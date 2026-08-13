import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents/types.js";
import {
	parseAutomationRequest,
	parseWorkflowPlan,
	type WorkflowPlan,
	type WorkflowPlanPatch,
	type WorkflowPlanTask,
	workflowPlanIdentity,
} from "./automation-contract.js";
import { redactPrivateText } from "./context.js";
import type { TargetPolicyAudit } from "./cwd-policy.js";
import { rotateExecutionPlanGeneration } from "./execution-plan.js";
import {
	WorkItemLedger,
	type WorkItemLedgerSnapshot,
	type WorkItemRecord,
} from "./work-item-ledger.js";
import { type CompiledWorkflowPlan, compileWorkflowPlan } from "./workflow-plan-compiler.js";

export const WORKFLOW_PLAN_STATE_VERSION = "pi-subagents:workflow-plan-state:v1" as const;
const MAX_STATE_BYTES = 1024 * 1024;

export interface WorkflowPlanHistoryEntry {
	planId: string;
	workflowGeneration: number;
	revision: number;
	acceptedTaskIds: string[];
	acceptedArtifactIds: string[];
	verificationReceiptTaskIds: string[];
}

export interface WorkflowPlanRecord {
	version: typeof WORKFLOW_PLAN_STATE_VERSION;
	planId: string;
	workflowGeneration: number;
	revision: number;
	maxRevisions: number;
	request: CompiledWorkflowPlan["request"];
	plan: WorkflowPlan;
	cancelledTaskIds: string[];
	invalidatedTaskIds: string[];
	history: WorkflowPlanHistoryEntry[];
}

export interface ApplyWorkflowPlanPatchInput {
	record: WorkflowPlanRecord;
	ledger: WorkItemLedgerSnapshot;
	patch: WorkflowPlanPatch;
	agents: readonly AgentConfig[];
	target: TargetPolicyAudit;
}

export interface AppliedWorkflowPlanPatch {
	record: WorkflowPlanRecord;
	ledger: WorkItemLedgerSnapshot;
	compiled?: CompiledWorkflowPlan;
	taskGenerations: Record<string, number>;
	replayedTaskIds: string[];
}

export interface PersistedAutomationPlan {
	record: WorkflowPlanRecord;
	ledger: WorkItemLedgerSnapshot;
}

export function createWorkflowPlanRecord(compiled: CompiledWorkflowPlan): WorkflowPlanRecord {
	return {
		version: WORKFLOW_PLAN_STATE_VERSION,
		planId: compiled.planId,
		workflowGeneration: compiled.workflowGeneration,
		revision: compiled.revision,
		maxRevisions: compiled.request.aggregateBudget.maxRevisions,
		request: structuredClone(compiled.request),
		plan: structuredClone(compiled.plan),
		cancelledTaskIds: [],
		invalidatedTaskIds: [],
		history: [],
	};
}

export function applyWorkflowPlanPatch(
	input: ApplyWorkflowPlanPatchInput,
): AppliedWorkflowPlanPatch {
	validateRecord(input.record);
	const ledger = WorkItemLedger.restore(input.ledger).snapshot();
	if (input.patch.planId !== input.record.planId) {
		throw new Error("Workflow plan patch has a stale or forged plan identity");
	}
	if (input.patch.workflowGeneration !== input.record.workflowGeneration) {
		throw new Error("Workflow plan patch has a stale or forged workflow generation");
	}
	if (input.record.revision >= input.record.maxRevisions) {
		throw new Error("Workflow plan revision limit is exhausted");
	}
	if (
		ledger.items.some((item) => item.state === "running" || item.state === "awaiting-verification")
	) {
		throw new Error("Workflow plan patches require a settled workflow snapshot");
	}
	const byState = new Map(ledger.items.map((item) => [item.id, item]));
	const tasks = input.record.plan.tasks.map((task) => structuredClone(task));
	const cancelled = new Set(input.record.cancelledTaskIds);
	const invalidated = new Set(input.record.invalidatedTaskIds);
	const modified = new Set<string>();
	const acceptedArtifactIds = new Set(
		ledger.items
			.filter((item) => item.state === "completed" || item.verificationAccepted)
			.flatMap((item) => item.artifacts.map((artifact) => artifact.id)),
	);

	for (const operation of input.patch.operations) {
		if (operation.type === "add-task") {
			if (tasks.some((task) => task.id === operation.task.id)) {
				throw new Error(`Workflow patch cannot add duplicate task ${operation.task.id}`);
			}
			assertNoAcceptedArtifactForgery(operation.task, acceptedArtifactIds);
			tasks.push(structuredClone(operation.task));
			modified.add(operation.task.id);
			continue;
		}
		const targetId = operation.taskId;
		if (cancelled.has(targetId)) {
			throw new Error(`Workflow patch cannot revive cancelled task ${targetId}`);
		}
		const taskIndex = tasks.findIndex((task) => task.id === targetId);
		if (taskIndex < 0) throw new Error(`Workflow patch targets unknown task ${targetId}`);
		const state = byState.get(targetId);
		if (!state || !isPatchEligible(state)) {
			throw new Error(`Workflow task ${targetId} is immutable while ${state?.state ?? "missing"}`);
		}
		if (operation.type === "replace-task") {
			if (operation.task.id !== targetId) {
				throw new Error("Workflow replacement must preserve the executor-owned task id");
			}
			assertNoAcceptedArtifactForgery(operation.task, acceptedArtifactIds);
			tasks[taskIndex] = structuredClone(operation.task);
			modified.add(targetId);
			continue;
		}
		if (operation.type === "add-dependency") {
			if (!tasks.some((task) => task.id === operation.dependsOn)) {
				throw new Error(`Workflow patch dependency ${operation.dependsOn} is missing`);
			}
			const current = tasks[taskIndex];
			if (!current.dependsOn.includes(operation.dependsOn)) {
				current.dependsOn.push(operation.dependsOn);
			}
			modified.add(targetId);
			continue;
		}
		if (operation.type === "cancel-task") {
			const current = tasks[taskIndex];
			if (
				current.verifierFor &&
				tasks.some(
					(task) =>
						task.id === current.verifierFor &&
						task.sideEffectPolicy === "mutating" &&
						!cancelled.has(task.id),
				)
			) {
				throw new Error(`Workflow patch cannot remove required verification ${targetId}`);
			}
			for (const affected of downstreamTaskIds(tasks, targetId, true)) {
				const affectedState = byState.get(affected);
				if (affectedState && !isPatchEligible(affectedState)) {
					throw new Error(`Workflow cancellation would rewrite immutable task ${affected}`);
				}
				cancelled.add(affected);
				modified.add(affected);
			}
			continue;
		}
		if (operation.type === "request-verification") {
			if (tasks.some((task) => task.verifierFor === targetId && !cancelled.has(task.id))) {
				throw new Error(`Workflow task ${targetId} already has required verification`);
			}
			if (
				operation.verifier.verifierFor !== targetId ||
				operation.verifier.dependsOn.length !== 1 ||
				operation.verifier.dependsOn[0] !== targetId
			) {
				throw new Error("Workflow verification patch must add one direct verifier");
			}
			tasks.push(structuredClone(operation.verifier));
			modified.add(operation.verifier.id);
			continue;
		}
		if (operation.type === "invalidate-downstream") {
			for (const affected of downstreamTaskIds(tasks, targetId, false)) {
				const affectedState = byState.get(affected);
				if (affectedState && !isPatchEligible(affectedState)) {
					throw new Error(`Workflow invalidation would rewrite immutable task ${affected}`);
				}
				invalidated.add(affected);
				modified.add(affected);
			}
		}
	}

	const candidatePlan = parseWorkflowPlan({ ...input.record.plan, tasks });
	const activeTasks = candidatePlan.tasks.filter((task) => !cancelled.has(task.id));
	let baseCompiled: CompiledWorkflowPlan | undefined;
	if (activeTasks.length > 0) {
		const activePlan = parseWorkflowPlan({ ...candidatePlan, tasks: activeTasks });
		const result = compileWorkflowPlan({
			request: input.record.request,
			proposal: activePlan,
			agents: input.agents,
			target: input.target,
			depth: 0,
		});
		if (result.status !== "compiled") {
			throw new Error(
				`Workflow patch rejected by compiler: ${result.reasonCodes.join(", ") || result.status}`,
			);
		}
		baseCompiled = result;
	}
	const normalizedPlan = mergeCompiledActivePlan(
		candidatePlan,
		baseCompiled,
		cancelled,
		modified,
		byState,
	);
	const nextGeneration = input.record.workflowGeneration + 1;
	const nextRevision = input.record.revision + 1;
	const historyEntry = captureHistory(input.record, ledger);
	const nextPlanId = revisionIdentity(
		input.record.planId,
		normalizedPlan,
		nextGeneration,
		nextRevision,
		cancelled,
		invalidated,
	);
	const nextLedger = buildPatchedLedger(
		normalizedPlan,
		ledger,
		baseCompiled,
		modified,
		cancelled,
		invalidated,
		input.patch.reason,
	);
	const taskGenerations = Object.fromEntries(
		nextLedger.items.map((item) => [item.id, item.taskGeneration]),
	);
	const compiled = baseCompiled
		? rotateCompiledPlan(baseCompiled, nextPlanId, nextGeneration, nextRevision, taskGenerations)
		: undefined;
	return {
		record: {
			...input.record,
			planId: nextPlanId,
			workflowGeneration: nextGeneration,
			revision: nextRevision,
			plan: normalizedPlan,
			cancelledTaskIds: [...cancelled].sort(),
			invalidatedTaskIds: [...invalidated].sort(),
			history: [...input.record.history, historyEntry],
		},
		ledger: nextLedger,
		...(compiled ? { compiled } : {}),
		taskGenerations,
		replayedTaskIds: [],
	};
}

function mergeCompiledActivePlan(
	candidate: WorkflowPlan,
	compiled: CompiledWorkflowPlan | undefined,
	cancelled: ReadonlySet<string>,
	modified: Set<string>,
	byState: ReadonlyMap<string, WorkItemRecord>,
): WorkflowPlan {
	if (!compiled) return candidate;
	const compiledById = new Map(compiled.plan.tasks.map((task) => [task.id, task]));
	const candidateIds = new Set(candidate.tasks.map((task) => task.id));
	const tasks = candidate.tasks.map((task) => {
		if (cancelled.has(task.id)) return task;
		const normalized = compiledById.get(task.id);
		if (!normalized) {
			throw new Error(`Compiled patch omitted active workflow task ${task.id}`);
		}
		if (!isDeepStrictEqual(normalized, task)) {
			const state = byState.get(task.id);
			if (state && !isPatchEligible(state)) {
				throw new Error(`Workflow normalization would rewrite immutable task ${task.id}`);
			}
			modified.add(task.id);
		}
		return normalized;
	});
	for (const task of compiled.plan.tasks) {
		if (!candidateIds.has(task.id)) tasks.push(task);
	}
	return parseWorkflowPlan({ ...candidate, tasks });
}

function rotateCompiledPlan(
	compiled: CompiledWorkflowPlan,
	planId: string,
	workflowGeneration: number,
	revision: number,
	taskGenerations: Readonly<Record<string, number>>,
): CompiledWorkflowPlan {
	const executionPlans = compiled.executionPlans.map((plan) => {
		const taskId = plan.taskId;
		const targetGeneration = taskId ? taskGenerations[taskId] : undefined;
		if (!taskId || !targetGeneration || targetGeneration < plan.taskGeneration) {
			throw new Error(`Patched workflow has an invalid task generation for ${taskId ?? "unknown"}`);
		}
		let rotated = plan;
		while (rotated.taskGeneration < targetGeneration) {
			rotated = rotateExecutionPlanGeneration(rotated);
		}
		return rotated;
	});
	return {
		...compiled,
		planId,
		workflowGeneration,
		revision,
		workflow: {
			...compiled.workflow,
			id: `auto-${planId.slice(0, 24)}`,
		},
		executionPlans,
	};
}

function buildPatchedLedger(
	plan: WorkflowPlan,
	previous: WorkItemLedgerSnapshot,
	compiled: CompiledWorkflowPlan | undefined,
	modified: ReadonlySet<string>,
	cancelled: ReadonlySet<string>,
	invalidated: ReadonlySet<string>,
	reason: string,
): WorkItemLedgerSnapshot {
	const previousById = new Map(previous.items.map((item) => [item.id, item]));
	const compiledById = new Map((compiled?.workflow.tasks ?? []).map((task) => [task.id, task]));
	const fresh = WorkItemLedger.create({
		workflowId: previous.workflowId,
		items: plan.tasks.map((task) => ({
			id: task.id,
			objective: task.objective,
			dependencies: [...task.dependsOn],
			inputArtifacts: [...task.inputArtifacts],
			inputArtifactVersions: Object.fromEntries(
				task.inputArtifacts.flatMap((artifactId) => {
					const artifact = plan.tasks
						.flatMap((candidate) => candidate.producesArtifacts)
						.find((candidate) => candidate.id === artifactId);
					return artifact ? [[artifact.id, artifact.version]] : [];
				}),
			),
			requiredCapabilities: [...task.requiredCapabilities],
			requiredTools: [...task.requiredTools],
			selectedAgentName:
				compiledById.get(task.id)?.agent ?? previousById.get(task.id)?.selectedAgentName,
			sideEffectPolicy: task.sideEffectPolicy,
			readPaths: [...task.readPaths],
			writePaths: [...task.writePaths],
			ownershipKeys: [...task.ownershipKeys],
			acceptanceCriteria: [...task.acceptanceCriteria],
			integrationOwner: cancelled.has(task.id) ? false : task.integrationOwner,
			verifierFor: task.verifierFor,
		})),
	}).snapshot();
	let generation = previous.generation;
	for (const item of fresh.items) {
		const stored = previousById.get(item.id);
		if (stored && !modified.has(item.id)) {
			const dependencies = item.dependencies;
			const dependents = item.dependents;
			Object.assign(item, structuredClone(stored), { dependencies, dependents });
			continue;
		}
		item.taskGeneration = stored ? stored.taskGeneration + 1 : 1;
		item.state = cancelled.has(item.id) || invalidated.has(item.id) ? "invalidated" : "pending";
		item.assignedAgentId = undefined;
		item.acceptedExecutionPlanId = undefined;
		item.artifactHistory = [
			...(stored?.artifactHistory ?? []).map((artifact) => structuredClone(artifact)),
			...(stored?.artifacts ?? []).map((artifact) => structuredClone(artifact)),
		];
		item.artifacts = [];
		item.inputArtifactVersions = {};
		item.verificationAccepted = false;
		item.stagedTreeIdentity = undefined;
		item.verificationReceipt = undefined;
		item.invalidationReasons = [...(stored?.invalidationReasons ?? []), `${item.id}:${reason}`];
		item.outcomeReason = item.state === "invalidated" ? reason : undefined;
		item.generation = ++generation;
	}
	fresh.generation = generation;
	return WorkItemLedger.restore(fresh).snapshot();
}

export class AutomationPlanPersistence {
	constructor(readonly filePath: string) {}

	async save(value: PersistedAutomationPlan): Promise<void> {
		validateRecord(value.record);
		WorkItemLedger.restore(value.ledger);
		const filePath = path.resolve(this.filePath);
		const sanitized = sanitizePersisted(value);
		const content = `${JSON.stringify(sanitized)}\n`;
		if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) {
			throw new Error("Automation workflow state exceeds the persistence size limit");
		}
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
			const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			try {
				await fs.promises.writeFile(temporary, content, { mode: 0o600 });
				await fs.promises.rename(temporary, filePath);
			} finally {
				await fs.promises.rm(temporary, { force: true });
			}
		});
	}

	load(): PersistedAutomationPlan | undefined {
		const filePath = path.resolve(this.filePath);
		let source: string;
		try {
			const stat = fs.statSync(filePath);
			if (stat.size > MAX_STATE_BYTES) throw new Error("automation workflow state exceeds limit");
			source = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			const decoded = JSON.parse(source) as PersistedAutomationPlan;
			validateRecord(decoded.record);
			const ledger = WorkItemLedger.restore(decoded.ledger).snapshot();
			return { record: structuredClone(decoded.record), ledger };
		} catch {
			try {
				fs.renameSync(filePath, `${filePath}.invalid-${Date.now()}`);
			} catch {
				// A concurrent owner may already have quarantined the invalid record.
			}
			return undefined;
		}
	}
}

function validateRecord(record: WorkflowPlanRecord): void {
	if (!record || record.version !== WORKFLOW_PLAN_STATE_VERSION) {
		throw new Error("Unsupported automation workflow state");
	}
	if (
		!Number.isSafeInteger(record.workflowGeneration) ||
		record.workflowGeneration < 0 ||
		!Number.isSafeInteger(record.revision) ||
		record.revision < 0 ||
		!Number.isSafeInteger(record.maxRevisions) ||
		record.maxRevisions < 0 ||
		record.revision > record.maxRevisions
	) {
		throw new Error("Automation workflow state has an invalid generation or revision");
	}
	const request = parseAutomationRequest(record.request);
	const plan = parseWorkflowPlan(record.plan);
	if (record.maxRevisions !== request.aggregateBudget.maxRevisions) {
		throw new Error("Automation workflow state has an invalid revision ceiling");
	}
	if (!Array.isArray(record.cancelledTaskIds) || !Array.isArray(record.invalidatedTaskIds)) {
		throw new Error("Automation workflow state has invalid task state lists");
	}
	const taskIds = new Set(plan.tasks.map((task) => task.id));
	for (const list of [record.cancelledTaskIds, record.invalidatedTaskIds]) {
		if (new Set(list).size !== list.length || list.some((id) => !taskIds.has(id))) {
			throw new Error("Automation workflow state has invalid task state identities");
		}
	}
	if (!Array.isArray(record.history) || record.history.length !== record.revision) {
		throw new Error("Automation workflow state has invalid history");
	}
	for (const [index, entry] of record.history.entries()) validateHistoryEntry(entry, index);
	const expected =
		record.revision === 0
			? workflowPlanIdentity(record.plan, record.workflowGeneration, record.revision)
			: revisionIdentity(
					record.history.at(-1)?.planId ?? "",
					record.plan,
					record.workflowGeneration,
					record.revision,
					new Set(record.cancelledTaskIds),
					new Set(record.invalidatedTaskIds),
				);
	if (record.planId !== expected)
		throw new Error("Automation workflow state has a forged identity");
}

function validateHistoryEntry(entry: WorkflowPlanHistoryEntry, index: number): void {
	if (
		!entry ||
		!/^[a-f0-9]{64}$/u.test(entry.planId) ||
		!Number.isSafeInteger(entry.workflowGeneration) ||
		entry.workflowGeneration < 0 ||
		!Number.isSafeInteger(entry.revision) ||
		entry.revision !== index ||
		!Array.isArray(entry.acceptedTaskIds) ||
		!Array.isArray(entry.acceptedArtifactIds) ||
		!Array.isArray(entry.verificationReceiptTaskIds)
	) {
		throw new Error("Automation workflow state has malformed accepted history");
	}
	for (const list of [
		entry.acceptedTaskIds,
		entry.acceptedArtifactIds,
		entry.verificationReceiptTaskIds,
	]) {
		if (
			list.length > 64 ||
			new Set(list).size !== list.length ||
			list.some((value) => typeof value !== "string" || !value || value.length > 256)
		) {
			throw new Error("Automation workflow state has malformed accepted history identities");
		}
	}
}

function captureHistory(
	record: WorkflowPlanRecord,
	ledger: WorkItemLedgerSnapshot,
): WorkflowPlanHistoryEntry {
	const accepted = ledger.items.filter((item) => item.state === "completed");
	return {
		planId: record.planId,
		workflowGeneration: record.workflowGeneration,
		revision: record.revision,
		acceptedTaskIds: accepted.map((item) => item.id).sort(),
		acceptedArtifactIds: accepted
			.flatMap((item) => item.artifacts.map((artifact) => artifact.id))
			.sort(),
		verificationReceiptTaskIds: accepted
			.filter((item) => item.verificationReceipt)
			.map((item) => item.id)
			.sort(),
	};
}

function revisionIdentity(
	previousPlanId: string,
	plan: WorkflowPlan,
	workflowGeneration: number,
	revision: number,
	cancelled: ReadonlySet<string>,
	invalidated: ReadonlySet<string>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				previousPlanId,
				plan,
				workflowGeneration,
				revision,
				cancelledTaskIds: [...cancelled].sort(),
				invalidatedTaskIds: [...invalidated].sort(),
			}),
		)
		.digest("hex");
}

function isPatchEligible(item: WorkItemRecord): boolean {
	return (
		["pending", "ready", "needs-input", "stale", "invalidated"].includes(item.state) ||
		(item.state === "blocked" && item.outcomeReason === "verification-rework")
	);
}

function downstreamTaskIds(
	tasks: readonly WorkflowPlanTask[],
	rootId: string,
	includeRoot: boolean,
): string[] {
	const result: string[] = includeRoot ? [rootId] : [];
	const queue = [rootId];
	const seen = new Set(queue);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		for (const task of tasks) {
			if (!task.dependsOn.includes(current) || seen.has(task.id)) continue;
			seen.add(task.id);
			result.push(task.id);
			queue.push(task.id);
		}
	}
	return result;
}

function assertNoAcceptedArtifactForgery(
	task: WorkflowPlanTask,
	acceptedArtifactIds: ReadonlySet<string>,
): void {
	const forged = task.producesArtifacts.find((artifact) => acceptedArtifactIds.has(artifact.id));
	if (forged) throw new Error(`Workflow patch cannot forge accepted artifact ${forged.id}`);
}

function sanitizePersisted(value: PersistedAutomationPlan): PersistedAutomationPlan {
	const clone = structuredClone(value);
	const visit = (candidate: unknown): void => {
		if (Array.isArray(candidate)) {
			for (let index = 0; index < candidate.length; index++) {
				if (typeof candidate[index] === "string") {
					candidate[index] = redactPrivateText(candidate[index] as string).trim();
				} else visit(candidate[index]);
			}
			return;
		}
		if (!candidate || typeof candidate !== "object") return;
		for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
			if (typeof item === "string") {
				(candidate as Record<string, unknown>)[key] = redactPrivateText(item).trim();
			} else visit(item);
		}
	};
	visit(clone);
	validateRecord(clone.record);
	WorkItemLedger.restore(clone.ledger);
	return clone;
}
