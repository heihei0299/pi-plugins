import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { projectAgentRecords } from "./agent-projection.js";
import { isThinkingLevel } from "./agents/types.js";
import { isCapabilityGrant, revokeCapabilityGrant } from "./capability-grant.js";
import { redactPrivateText } from "./context.js";
import { normalizeDelegationContract } from "./delegation-contract.js";
import { copyExecutionPlan, isExecutionPlan } from "./execution-plan.js";
import { MAX_SUBAGENT_TIMEOUT_MS } from "./limits.js";
import type { ManagedAgent } from "./registry.js";
import { parseAnyStructuredSubagentResult, SUBAGENT_RESULT_FORMATS } from "./result-contract.js";
import { isSemanticSnapshot } from "./semantic-snapshot.js";
import { resolveStatefulLimits } from "./stateful-limits.js";
import { validateTaskName, validateTaskPath } from "./task-path.js";
import { copyTurnTerminationReport, type TurnTerminationReport } from "./timeout-checkpoint.js";
import { MAX_SUBAGENT_TOOL_CALLS, MAX_SUBAGENT_TURNS } from "./turn-budget.js";

const STATE_VERSION = 3;
const MAX_STORED_COMPLETIONS_PER_AGENT = 20;
const DEFAULT_STATEFUL_LIMITS = resolveStatefulLimits();
const MAX_STATE_BYTES = 5 * 1024 * 1024;

interface StoredState {
	version: 3;
	updatedAt: number;
	agents: ManagedAgent[];
}

export interface PersistenceOptions {
	retentionDays?: number;
	maxStoredAgents?: number;
	stateDir?: string;
}

export class AgentPersistence {
	readonly filePath: string;
	private readonly retentionMs: number;
	private readonly maxStoredAgents: number;

	constructor(owner: string, options: PersistenceOptions = {}) {
		const retentionDays = options.retentionDays ?? 30;
		if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
			throw new Error("Subagent retentionDays must be a positive finite number");
		}
		const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
		if (!Number.isFinite(retentionMs)) {
			throw new Error("Subagent retentionDays is too large");
		}
		const maxStoredAgents = options.maxStoredAgents ?? DEFAULT_STATEFUL_LIMITS.maxStoredAgents;
		if (!Number.isSafeInteger(maxStoredAgents) || maxStoredAgents < 1) {
			throw new Error("Subagent maxStoredAgents must be a positive safe integer");
		}
		const safeOwner = createHash("sha256").update(owner).digest("hex").slice(0, 24);
		const stateDir = options.stateDir ?? path.join(getAgentDir(), "pi-subagents-state");
		this.filePath = path.join(stateDir, `${safeOwner}.json`);
		this.retentionMs = retentionMs;
		this.maxStoredAgents = maxStoredAgents;
	}

	load(): ManagedAgent[] {
		if (!fs.existsSync(this.filePath)) return [];
		try {
			const stat = fs.statSync(this.filePath);
			if (stat.size > MAX_STATE_BYTES) throw new Error("state exceeds size limit");
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
			if (!isStoredState(parsed)) throw new Error("unsupported or malformed state");
			const cutoff = Date.now() - this.retentionMs;
			return projectAgentRecords(
				parsed.agents.filter((agent) => agent.updatedAt >= cutoff && agent.state !== "closed"),
				{ maxAgents: this.maxStoredAgents },
			).map(sanitizeAgent);
		} catch {
			this.quarantine();
			return [];
		}
	}

	async save(agents: readonly ManagedAgent[]): Promise<void> {
		const cutoff = Date.now() - this.retentionMs;
		const eligible = agents.filter(
			(agent) => agent.state !== "closed" && agent.updatedAt >= cutoff,
		);
		const records = projectAgentRecords(eligible, {
			maxAgents: this.maxStoredAgents,
		}).map(sanitizeAgent);
		const state: StoredState = { version: STATE_VERSION, updatedAt: Date.now(), agents: records };
		let content = `${JSON.stringify(state, null, "\t")}\n`;
		while (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES && state.agents.length > 0) {
			const rootsWithPendingCompletions = new Set(
				state.agents
					.filter((agent) => (agent.pendingCompletions?.length ?? 0) > 0)
					.map((agent) => agent.rootId),
			);
			const droppableRoot = state.agents.find(
				(agent) => !rootsWithPendingCompletions.has(agent.rootId),
			)?.rootId;
			if (droppableRoot) {
				state.agents = state.agents.filter((agent) => agent.rootId !== droppableRoot);
			} else if (!trimOldestHistory(state.agents) && !clearOldestContext(state.agents)) {
				throw new Error("Subagent state exceeds its durable completion storage limit");
			}
			content = `${JSON.stringify(state, null, "\t")}\n`;
		}
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		await withFileMutationQueue(this.filePath, async () => {
			const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
			await fs.promises.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
			await fs.promises.rename(tempPath, this.filePath);
		});
	}

	async delete(): Promise<void> {
		await withFileMutationQueue(this.filePath, async () => {
			await fs.promises.rm(this.filePath, { force: true });
		});
	}

	private quarantine(): void {
		try {
			fs.renameSync(this.filePath, `${this.filePath}.invalid-${Date.now()}`);
		} catch {
			// A concurrent process may already have moved or removed it.
		}
	}
}

function trimOldestHistory(agents: ManagedAgent[]): boolean {
	const candidate = agents
		.filter((agent) => agent.history.length > 0)
		.sort(
			(left, right) =>
				(left.history[0]?.completedAt ?? Number.POSITIVE_INFINITY) -
				(right.history[0]?.completedAt ?? Number.POSITIVE_INFINITY),
		)[0];
	if (!candidate) return false;
	candidate.history.shift();
	return true;
}

function clearOldestContext(agents: ManagedAgent[]): boolean {
	const candidate = agents.find((agent) => agent.context !== undefined);
	if (!candidate) return false;
	candidate.context = undefined;
	candidate.contextTruncated = true;
	return true;
}

function sanitizeAgent(agent: ManagedAgent): ManagedAgent {
	return {
		...agent,
		rootId: agent.rootId ?? agent.id,
		depth: agent.depth ?? 0,
		children: [...(agent.children ?? [])],
		mailbox: (agent.mailbox ?? []).map((message) => ({
			...message,
			recipientId: agent.id,
			content: redactPrivateText(message.content),
		})),
		state: agent.state === "running" || agent.state === "starting" ? "interrupted" : agent.state,
		currentTask: undefined,
		currentRunId: undefined,
		currentTurnGeneration: undefined,
		turnGeneration: agent.turnGeneration ?? 0,
		pendingCompletions: (agent.pendingCompletions ?? [])
			.slice(-MAX_STORED_COMPLETIONS_PER_AGENT)
			.map((completion) => ({
				...completion,
				task: redactPrivateText(completion.task),
				output: redactPrivateText(completion.output),
				error: completion.error ? redactPrivateText(completion.error) : undefined,
			})),
		currentTimeoutMs: undefined,
		currentIdleTimeoutMs: undefined,
		currentMaxTurns: undefined,
		currentMaxToolCalls: undefined,
		currentMailboxMessageIds: undefined,
		telemetry: undefined,
		contract: normalizeDelegationContract(agent.contract),
		structuredResult:
			agent.structuredResult && agent.resultFormat
				? parseAnyStructuredSubagentResult(
						JSON.stringify(agent.structuredResult),
						agent.resultFormat,
					)
				: undefined,
		executionPlan: agent.executionPlan ? copyExecutionPlan(agent.executionPlan) : undefined,
		capabilityGrant: agent.capabilityGrant
			? agent.capabilityGrant.state === "active"
				? revokeCapabilityGrant(agent.capabilityGrant, "persistence-boundary", Date.now())
				: structuredClone(agent.capabilityGrant)
			: undefined,
		semanticSnapshot: agent.semanticSnapshot ? structuredClone(agent.semanticSnapshot) : undefined,
		semanticCompatibility: agent.semanticCompatibility
			? structuredClone(agent.semanticCompatibility)
			: undefined,
		termination: agent.termination ? sanitizeTermination(agent.termination) : undefined,
		context: agent.context ? redactPrivateText(agent.context) : undefined,
		error: agent.error ? redactPrivateText(agent.error) : undefined,
		history: agent.history.map((turn) => ({
			...turn,
			task: redactPrivateText(turn.task),
			output: redactPrivateText(turn.output),
			termination: turn.termination ? sanitizeTermination(turn.termination) : undefined,
		})),
	};
}

function sanitizeTermination(report: TurnTerminationReport): TurnTerminationReport {
	const copy = copyTurnTerminationReport(report);
	copy.checkpoint.task = redactPrivateText(copy.checkpoint.task);
	copy.checkpoint.partialOutput = copy.checkpoint.partialOutput
		? redactPrivateText(copy.checkpoint.partialOutput)
		: undefined;
	copy.checkpoint.assistantNotes = copy.checkpoint.assistantNotes.map(redactPrivateText);
	copy.checkpoint.completedTools = copy.checkpoint.completedTools.map((item) => ({
		...item,
		toolName: redactPrivateText(item.toolName),
		output: redactPrivateText(item.output),
	}));
	copy.checkpoint.changedFiles = copy.checkpoint.changedFiles.map(redactPrivateText);
	copy.finalization.error = copy.finalization.error
		? redactPrivateText(copy.finalization.error)
		: undefined;
	return copy;
}

function isStoredState(value: unknown): value is StoredState {
	if (!value || typeof value !== "object") return false;
	const state = value as { version?: unknown; agents?: unknown };
	if (
		(state.version !== 1 && state.version !== 2 && state.version !== STATE_VERSION) ||
		!Array.isArray(state.agents)
	) {
		return false;
	}
	return state.agents.every((agent) => {
		if (!agent || typeof agent !== "object") return false;
		const record = agent as Partial<ManagedAgent>;
		return (
			typeof record.id === "string" &&
			(record.taskName === undefined || isValidTaskName(record.taskName)) &&
			(record.taskPath === undefined || isValidTaskPath(record.taskPath)) &&
			typeof record.agent === "string" &&
			typeof record.cwd === "string" &&
			typeof record.createdAt === "number" &&
			Number.isFinite(record.createdAt) &&
			typeof record.updatedAt === "number" &&
			Number.isFinite(record.updatedAt) &&
			(record.parentId === undefined || typeof record.parentId === "string") &&
			(record.thinkingLevel === undefined || isThinkingLevel(record.thinkingLevel)) &&
			(record.timeoutMs === undefined || isTurnTimeout(record.timeoutMs)) &&
			(record.idleTimeoutMs === undefined || isTurnTimeout(record.idleTimeoutMs)) &&
			(record.maxTurns === undefined || isPositiveBounded(record.maxTurns, MAX_SUBAGENT_TURNS)) &&
			(record.maxToolCalls === undefined ||
				isPositiveBounded(record.maxToolCalls, MAX_SUBAGENT_TOOL_CALLS)) &&
			(record.termination === undefined || isTerminationReport(record.termination)) &&
			(record.contextTurns === undefined || isNonNegativeInteger(record.contextTurns)) &&
			(record.contextBytes === undefined || isNonNegativeInteger(record.contextBytes)) &&
			(record.turnGeneration === undefined || isNonNegativeInteger(record.turnGeneration)) &&
			(record.pendingCompletions === undefined ||
				isCompletionOutbox(record.pendingCompletions, record.turnGeneration ?? 0)) &&
			(record.spawnIdempotencyKey === undefined ||
				(typeof record.spawnIdempotencyKey === "string" &&
					record.spawnIdempotencyKey.length > 0 &&
					record.spawnIdempotencyKey.length <= 256)) &&
			(record.spawnRequestHash === undefined || isSha256(record.spawnRequestHash)) &&
			(record.contract === undefined ||
				normalizeDelegationContract(record.contract) !== undefined) &&
			(record.resultFormat === undefined ||
				SUBAGENT_RESULT_FORMATS.includes(record.resultFormat)) &&
			(record.structuredResult === undefined ||
				(record.resultFormat !== undefined &&
					parseAnyStructuredSubagentResult(
						JSON.stringify(record.structuredResult),
						record.resultFormat,
					) !== undefined)) &&
			(record.executionPlan === undefined || isExecutionPlan(record.executionPlan)) &&
			(record.capabilityGrant === undefined || isCapabilityGrant(record.capabilityGrant)) &&
			(record.semanticSnapshot === undefined || isSemanticSnapshot(record.semanticSnapshot)) &&
			(record.semanticCompatibility === undefined ||
				isSemanticCompatibility(record.semanticCompatibility)) &&
			(record.workspaceMode === undefined || record.workspaceMode === "worktree") &&
			(record.target === undefined || isTargetPolicyAudit(record.target)) &&
			(record.children === undefined ||
				(Array.isArray(record.children) &&
					record.children.every((id) => typeof id === "string"))) &&
			Array.isArray(record.history) &&
			record.history.every(isAgentTurn) &&
			(record.mailbox === undefined ||
				(Array.isArray(record.mailbox) && record.mailbox.every(isMailboxMessage)))
		);
	});
}

function isValidTaskName(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return validateTaskName(value) === value;
	} catch {
		return false;
	}
}

function isValidTaskPath(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return validateTaskPath(value) === value;
	} catch {
		return false;
	}
}

function isSemanticCompatibility(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const compatibility = value as Record<string, unknown>;
	return (
		["compatible", "warning", "needs-revalidation", "rejected"].includes(
			String(compatibility.status),
		) &&
		Array.isArray(compatibility.changedComponents) &&
		compatibility.changedComponents.every((item) => typeof item === "string")
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTurnTimeout(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 1 &&
		value <= MAX_SUBAGENT_TIMEOUT_MS
	);
}

function isPositiveBounded(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function isTerminationReport(value: unknown): value is TurnTerminationReport {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const report = value as Record<string, unknown>;
	if (
		report.version !== "pi-subagents:termination:v1" ||
		![
			"work_timeout",
			"idle_timeout",
			"turn_limit",
			"tool_call_limit",
			"orchestration_timeout",
		].includes(String(report.reason)) ||
		!isPositiveBounded(report.limit, MAX_SUBAGENT_TIMEOUT_MS)
	) {
		return false;
	}
	const checkpoint = report.checkpoint;
	const finalization = report.finalization;
	if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return false;
	if (!finalization || typeof finalization !== "object" || Array.isArray(finalization))
		return false;
	const checkpointValue = checkpoint as Record<string, unknown>;
	const finalizationValue = finalization as Record<string, unknown>;
	return (
		checkpointValue.version === "pi-subagents:checkpoint:v1" &&
		typeof checkpointValue.task === "string" &&
		(checkpointValue.partialOutput === undefined ||
			typeof checkpointValue.partialOutput === "string") &&
		Array.isArray(checkpointValue.assistantNotes) &&
		checkpointValue.assistantNotes.every((item) => typeof item === "string") &&
		Array.isArray(checkpointValue.completedTools) &&
		checkpointValue.completedTools.every(isCompletedToolEvidence) &&
		Array.isArray(checkpointValue.changedFiles) &&
		checkpointValue.changedFiles.every((item) => typeof item === "string") &&
		typeof checkpointValue.sideEffectsMayHaveOccurred === "boolean" &&
		typeof checkpointValue.truncated === "boolean" &&
		typeof finalizationValue.attempted === "boolean" &&
		["completed", "failed", "timed_out", "skipped"].includes(String(finalizationValue.status)) &&
		typeof finalizationValue.durationMs === "number" &&
		Number.isFinite(finalizationValue.durationMs) &&
		finalizationValue.durationMs >= 0 &&
		(finalizationValue.error === undefined || typeof finalizationValue.error === "string")
	);
}

function isCompletedToolEvidence(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.toolName === "string" &&
		typeof item.output === "string" &&
		typeof item.isError === "boolean"
	);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTargetPolicyAudit(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const target = value as Record<string, unknown>;
	if (
		typeof target.cwd !== "string" ||
		(target.boundary !== "current-workspace" && target.boundary !== "external") ||
		!target.trust ||
		typeof target.trust !== "object"
	) {
		return false;
	}
	const trust = target.trust as Record<string, unknown>;
	return (
		[
			"session-trusted",
			"session-untrusted",
			"saved-trusted",
			"saved-denied",
			"unsaved",
			"trust-error",
		].includes(String(trust.kind)) &&
		typeof trust.projectTrusted === "boolean" &&
		(trust.sourcePath === undefined || typeof trust.sourcePath === "string") &&
		(trust.warning === undefined || typeof trust.warning === "string")
	);
}

function isCompletionOutbox(value: unknown, turnGeneration: number): boolean {
	if (!Array.isArray(value) || value.length > MAX_STORED_COMPLETIONS_PER_AGENT) return false;
	const ids = new Set<string>();
	let previousGeneration = 0;
	let previousCreatedAt = Number.NEGATIVE_INFINITY;
	for (const completion of value) {
		if (!isPersistedCompletion(completion, turnGeneration)) return false;
		if (ids.has(completion.completionId)) return false;
		if (completion.generation <= previousGeneration || completion.createdAt <= previousCreatedAt) {
			return false;
		}
		ids.add(completion.completionId);
		previousGeneration = completion.generation;
		previousCreatedAt = completion.createdAt;
	}
	return true;
}

function isPersistedCompletion(
	value: unknown,
	turnGeneration: number,
): value is import("./registry.js").PersistedAgentCompletion {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const completion = value as Record<string, unknown>;
	return (
		typeof completion.completionId === "string" &&
		completion.completionId.length > 0 &&
		completion.completionId.length <= 256 &&
		(completion.recipientId === undefined ||
			(typeof completion.recipientId === "string" && completion.recipientId.length > 0)) &&
		(completion.recipientPath === undefined || isValidTaskPath(completion.recipientPath)) &&
		typeof completion.runId === "string" &&
		completion.runId.length > 0 &&
		completion.runId.length <= 256 &&
		typeof completion.generation === "number" &&
		Number.isSafeInteger(completion.generation) &&
		completion.generation >= 1 &&
		completion.generation <= turnGeneration &&
		typeof completion.task === "string" &&
		typeof completion.output === "string" &&
		(completion.error === undefined || typeof completion.error === "string") &&
		typeof completion.createdAt === "number" &&
		Number.isFinite(completion.createdAt)
	);
}

function isAgentTurn(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const turn = value as Record<string, unknown>;
	return (
		(turn.runId === undefined ||
			(typeof turn.runId === "string" && turn.runId.length > 0 && turn.runId.length <= 256)) &&
		(turn.generation === undefined ||
			(typeof turn.generation === "number" &&
				Number.isSafeInteger(turn.generation) &&
				turn.generation >= 1)) &&
		typeof turn.task === "string" &&
		typeof turn.output === "string" &&
		typeof turn.startedAt === "number" &&
		Number.isFinite(turn.startedAt) &&
		typeof turn.completedAt === "number" &&
		Number.isFinite(turn.completedAt) &&
		typeof turn.exitCode === "number" &&
		Number.isFinite(turn.exitCode) &&
		(turn.termination === undefined || isTerminationReport(turn.termination))
	);
}

function isMailboxMessage(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "string" &&
		typeof message.senderId === "string" &&
		typeof message.recipientId === "string" &&
		typeof message.content === "string" &&
		typeof message.createdAt === "number" &&
		Number.isFinite(message.createdAt) &&
		(message.readAt === undefined ||
			(typeof message.readAt === "number" && Number.isFinite(message.readAt))) &&
		(message.deduplicationKey === undefined || typeof message.deduplicationKey === "string") &&
		(message.completionId === undefined || typeof message.completionId === "string")
	);
}
