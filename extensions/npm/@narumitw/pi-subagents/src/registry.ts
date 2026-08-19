/**
 * AgentRegistry intentionally owns its full state machine in one module so queue, tree,
 * mailbox, generation, grant, transport, persistence, and completion transitions are atomic.
 */
import { randomUUID } from "node:crypto";
import { projectAgentRecords } from "./agent-projection.js";
import type { SubagentThinkingLevel } from "./agents/types.js";
import {
	type CapabilityGrant,
	isCapabilityGrantActive,
	revokeCapabilityGrant,
} from "./capability-grant.js";
import { resolveCompletionRecipient } from "./completion-routing.js";
import type { TargetPolicyAudit } from "./cwd-policy.js";
import type { DelegationContract } from "./delegation-contract.js";
import {
	copyExecutionPlan,
	type ExecutionPlan,
	rotateExecutionPlanGeneration,
} from "./execution-plan.js";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	DEFAULT_MAX_OUTPUT_BYTES,
	MAX_SUBAGENT_TIMEOUT_MS,
	MAX_TOOL_MESSAGE_BYTES,
	truncateUtf8,
} from "./limits.js";
import { classifyStructuredOutcome } from "./outcome.js";
import type {
	AgentInspectionCounts,
	AgentLifecycleState,
	AgentMailboxMessage,
	AgentRegistryOptions,
	AgentRunInspectionDetail,
	AgentRunInspectionSummary,
	AgentTurnCompletion,
	ManagedAgent,
} from "./registry-types.js";
import {
	type AnyStructuredSubagentResult,
	parseAnyStructuredSubagentResult,
	type SubagentResultFormat,
} from "./result-contract.js";
import { safeTerminalLine } from "./safe-text.js";
import type { SemanticCompatibility, SemanticSnapshot } from "./semantic-snapshot.js";
import { resolveStatefulLimits } from "./stateful-limits.js";
import {
	deriveTaskName,
	joinTaskPath,
	ROOT_TASK_PATH,
	resolveTaskPath,
	validateTaskName,
	validateTaskPath,
} from "./task-path.js";
import { copyTurnTerminationReport } from "./timeout-checkpoint.js";
import { type AgentTurnRunner, normalizeTransport, type SubagentTransport } from "./transport.js";
import type { TransportTelemetry } from "./transport-types.js";
import { type TurnLimits, validateTurnLimits } from "./turn-budget.js";

const DEFAULT_STATEFUL_LIMITS = resolveStatefulLimits();
const MAX_PENDING_COMPLETIONS_PER_AGENT = 20;
const INITIAL_PERSISTENCE_RETRY_DELAY_MS = 25;
const MAX_PERSISTENCE_RETRY_DELAY_MS = 1_000;

export type * from "./registry-types.js";

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value;
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function validateTurnTimeout(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SUBAGENT_TIMEOUT_MS) {
		throw new Error(`Subagent timeoutMs must be between 1 and ${MAX_SUBAGENT_TIMEOUT_MS}`);
	}
	return value;
}

function clearCurrentTurn(agent: ManagedAgent): void {
	agent.currentTask = undefined;
	agent.currentRunId = undefined;
	agent.currentTurnGeneration = undefined;
	agent.currentTimeoutMs = undefined;
	agent.currentIdleTimeoutMs = undefined;
	agent.currentMaxTurns = undefined;
	agent.currentMaxToolCalls = undefined;
	agent.currentMailboxMessageIds = undefined;
}

function waitAbortError(): Error {
	const error = new Error("Subagent wait was aborted");
	error.name = "AbortError";
	return error;
}

function waitForPersistenceRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export class AgentRegistry {
	private readonly agents = new Map<string, ManagedAgent>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly running = new Map<string, Promise<ManagedAgent>>();
	private readonly queue: Array<{
		agent: ManagedAgent;
		task: string;
		resolve: (agent: ManagedAgent) => void;
	}> = [];
	private changeQueue: Promise<void> = Promise.resolve();
	private readonly shutdownController = new AbortController();
	private readonly maxAgents: number;
	private readonly maxActiveTurns: number;
	private readonly maxHistoryTurns: number;
	private readonly maxDepth: number;
	private readonly maxChildrenPerAgent: number;
	private readonly maxMailboxMessages: number;
	private readonly maxMailboxMessageBytes: number;
	private readonly maxTaskBytes: number;
	private readonly maxTurnOutputBytes: number;
	private readonly idleTtlMs: number;
	private readonly transport: SubagentTransport;
	private readonly now: () => number;
	private lastCompletionAt = 0;

	constructor(
		transport: SubagentTransport | AgentTurnRunner,
		private readonly options: AgentRegistryOptions = {},
	) {
		this.transport = normalizeTransport(transport);
		this.maxAgents = positiveInteger(
			options.maxAgents ?? DEFAULT_STATEFUL_LIMITS.maxAgents,
			"maxAgents",
		);
		this.maxActiveTurns = positiveInteger(
			options.maxActiveTurns ?? DEFAULT_STATEFUL_LIMITS.maxActiveTurns,
			"maxActiveTurns",
		);
		this.maxHistoryTurns = positiveInteger(options.maxHistoryTurns ?? 20, "maxHistoryTurns");
		this.maxDepth = nonNegativeInteger(
			options.maxDepth ?? DEFAULT_STATEFUL_LIMITS.maxDepth,
			"maxDepth",
		);
		this.maxChildrenPerAgent = positiveInteger(
			options.maxChildrenPerAgent ?? DEFAULT_STATEFUL_LIMITS.maxChildrenPerAgent,
			"maxChildrenPerAgent",
		);
		this.maxMailboxMessages = positiveInteger(
			options.maxMailboxMessages ?? 100,
			"maxMailboxMessages",
		);
		this.maxMailboxMessageBytes = positiveInteger(
			options.maxMailboxMessageBytes ?? 16 * 1024,
			"maxMailboxMessageBytes",
		);
		this.maxTaskBytes = positiveInteger(
			options.maxTaskBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
			"maxTaskBytes",
		);
		this.maxTurnOutputBytes = positiveInteger(
			options.maxTurnOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
			"maxTurnOutputBytes",
		);
		this.idleTtlMs = positiveInteger(options.idleTtlMs ?? 60 * 60 * 1000, "idleTtlMs");
		this.now = options.now ?? Date.now;
	}

	restore(records: readonly ManagedAgent[]): void {
		const candidates = new Map(
			projectAgentRecords(
				records.filter((record) => record.id && record.state !== "closed"),
				{ maxAgents: this.maxAgents, maxDepth: this.maxDepth },
			).map((record) => [record.id, record]),
		);
		const restorable: Array<{ record: ManagedAgent; rootId: string; depth: number }> = [];
		for (const record of candidates.values()) {
			if (record.parentId && !candidates.has(record.parentId)) continue;
			if (record.parentId === record.id) continue;
			const seen = new Set([record.id]);
			let parentId = record.parentId;
			let rootId = record.id;
			let cyclic = false;
			while (parentId) {
				if (seen.has(parentId)) {
					cyclic = true;
					break;
				}
				seen.add(parentId);
				rootId = parentId;
				parentId = candidates.get(parentId)?.parentId;
			}
			const depth = seen.size - 1;
			if (!cyclic && depth <= this.maxDepth) restorable.push({ record, rootId, depth });
		}
		restorable.sort(
			(left, right) =>
				left.depth - right.depth ||
				left.record.createdAt - right.record.createdAt ||
				left.record.id.localeCompare(right.record.id),
		);
		const reservedPaths = new Set(
			[...this.agents.values()].flatMap((agent) =>
				agent.state !== "closed" && agent.taskPath ? [agent.taskPath] : [],
			),
		);
		for (const { record, rootId, depth } of restorable) {
			const parentPath = record.parentId
				? this.agents.get(record.parentId)?.taskPath
				: ROOT_TASK_PATH;
			if (!parentPath) continue;
			const identity = this.reserveRestoredIdentity(record, parentPath, reservedPaths);
			for (const completion of record.pendingCompletions ?? []) {
				this.lastCompletionAt = Math.max(this.lastCompletionAt, completion.createdAt);
			}
			this.agents.set(record.id, {
				...record,
				...identity,
				state:
					record.state === "running" || record.state === "starting" ? "interrupted" : record.state,
				rootId,
				depth,
				currentTask: undefined,
				turnGeneration: record.turnGeneration ?? 0,
				currentRunId: undefined,
				currentTurnGeneration: undefined,
				pendingCompletions: (record.pendingCompletions ?? []).map((completion) => ({
					...completion,
				})),
				currentTimeoutMs: undefined,
				currentIdleTimeoutMs: undefined,
				currentMaxTurns: undefined,
				currentMaxToolCalls: undefined,
				currentMailboxMessageIds: undefined,
				children: [],
				contextSourceIds: [...(record.contextSourceIds ?? [])],
				capabilityGrant:
					record.capabilityGrant?.state === "active"
						? revokeCapabilityGrant(record.capabilityGrant, "restore-boundary", this.now())
						: record.capabilityGrant,
				mailbox: (record.mailbox ?? [])
					.slice(-this.maxMailboxMessages)
					.map((message) => ({ ...message, recipientId: record.id })),
				history: record.history.slice(-this.maxHistoryTurns).map((turn) => ({ ...turn })),
			});
		}
		for (const agent of this.agents.values()) {
			if (agent.parentId) {
				const parent = this.agents.get(agent.parentId);
				if (parent && !parent.children.includes(agent.id)) parent.children.push(agent.id);
			}
			for (const completion of agent.pendingCompletions ?? []) {
				if (!completion.recipientId || !completion.recipientPath) {
					Object.assign(completion, this.completionRecipient(agent));
				}
				this.enqueueCompletionMessage(
					agent,
					completion,
					completion.output || completion.error || "(no output)",
				);
			}
		}
	}

	async spawn(input: {
		agent: string;
		taskName?: string;
		task: string;
		cwd: string;
		agentScope?: "user" | "project" | "both";
		thinkingLevel?: SubagentThinkingLevel;
		timeoutMs?: number;
		idleTimeoutMs?: number;
		maxTurns?: number;
		maxToolCalls?: number;
		parentId?: string;
		context?: string;
		contextSourceIds?: string[];
		contextTruncated?: boolean;
		contextTurns?: number;
		contextBytes?: number;
		workspaceMode?: "worktree";
		spawnIdempotencyKey?: string;
		spawnRequestHash?: string;
		contract?: DelegationContract;
		resultFormat?: SubagentResultFormat;
		executionPlan?: ExecutionPlan;
		capabilityGrant?: CapabilityGrant;
		semanticSnapshot?: SemanticSnapshot;
		semanticCompatibility?: SemanticCompatibility;
		target?: TargetPolicyAudit;
	}): Promise<ManagedAgent> {
		if (!input.task.trim()) throw new Error("Subagent tasks cannot be empty");
		if (input.timeoutMs !== undefined) validateTurnTimeout(input.timeoutMs);
		validateTurnLimits(input);
		const existing = this.findBySpawnIdempotencyKey(
			input.spawnIdempotencyKey,
			input.spawnRequestHash,
		);
		if (existing) return existing;
		const task = truncateUtf8(input.task, this.maxTaskBytes).text;
		const expired = this.evictExpired();
		let expiryReleaseError: unknown;
		try {
			await this.releaseAgents(expired);
		} catch (error) {
			expiryReleaseError = error;
		}
		if (expired.length > 0) await this.changed();
		if (expiryReleaseError) throw expiryReleaseError;
		if (this.retainedCount() >= this.maxAgents) {
			throw new Error(`Subagent capacity reached (${this.maxAgents})`);
		}
		const parent = input.parentId ? this.require(input.parentId) : undefined;
		if (parent?.state === "closed") throw new Error(`Cannot spawn under closed agent ${parent.id}`);
		if (parent && parent.children.length >= this.maxChildrenPerAgent) {
			throw new Error(`Agent ${parent.id} child capacity reached (${this.maxChildrenPerAgent})`);
		}
		const depth = parent ? parent.depth + 1 : 0;
		if (depth > this.maxDepth) throw new Error(`Subagent depth limit reached (${this.maxDepth})`);
		const now = this.now();
		const id = `sa_${randomUUID()}`;
		const taskName = input.taskName ? validateTaskName(input.taskName) : deriveTaskName(id);
		const taskPath = joinTaskPath(parent?.taskPath ?? ROOT_TASK_PATH, taskName);
		if (this.findByTaskPath(taskPath)) {
			throw new Error(`Canonical subagent task path is already retained: ${taskPath}`);
		}
		const record: ManagedAgent = {
			id,
			taskName,
			taskPath,
			agent: input.agent,
			parentId: parent?.id,
			rootId: parent?.rootId ?? id,
			depth,
			children: [],
			state: "starting",
			createdAt: now,
			updatedAt: now,
			cwd: input.cwd,
			agentScope: input.agentScope,
			thinkingLevel: input.thinkingLevel,
			timeoutMs: input.timeoutMs,
			currentTimeoutMs: input.timeoutMs,
			idleTimeoutMs: input.idleTimeoutMs,
			currentIdleTimeoutMs: input.idleTimeoutMs,
			maxTurns: input.maxTurns,
			currentMaxTurns: input.maxTurns,
			maxToolCalls: input.maxToolCalls,
			currentMaxToolCalls: input.maxToolCalls,
			currentTask: task,
			turnGeneration: 0,
			pendingCompletions: [],
			history: [],
			mailbox: [],
			context: input.context,
			contextSourceIds: input.contextSourceIds,
			contextTruncated: input.contextTruncated,
			contextTurns: input.contextTurns,
			contextBytes: input.contextBytes,
			workspaceMode: input.workspaceMode,
			spawnIdempotencyKey: input.spawnIdempotencyKey,
			spawnRequestHash: input.spawnRequestHash,
			contract: input.contract,
			resultFormat: input.resultFormat,
			executionPlan: input.executionPlan,
			capabilityGrant: input.capabilityGrant,
			semanticSnapshot: input.semanticSnapshot,
			semanticCompatibility: input.semanticCompatibility,
			target: input.target,
		};
		this.agents.set(record.id, record);
		if (parent) {
			parent.children.push(record.id);
			parent.updatedAt = now;
		}
		await this.changed();
		this.startTurn(record, task, input);
		return this.copy(record);
	}

	findBySpawnIdempotencyKey(
		key: string | undefined,
		requestHash: string | undefined,
	): ManagedAgent | undefined {
		if (!key) return undefined;
		const existing = [...this.agents.values()].find(
			(agent) => agent.state !== "closed" && agent.spawnIdempotencyKey === key,
		);
		if (!existing) return undefined;
		if (!requestHash || existing.spawnRequestHash !== requestHash) {
			throw new Error(
				"The subagent_spawn idempotencyKey was already used with different parameters",
			);
		}
		return this.copy(existing);
	}

	async followUp(
		id: string,
		task: string,
		options: TurnLimits & { timeoutMs?: number } = {},
	): Promise<ManagedAgent> {
		if (!task.trim()) throw new Error("Subagent tasks cannot be empty");
		if (options.timeoutMs !== undefined) validateTurnTimeout(options.timeoutMs);
		validateTurnLimits(options);
		const boundedTask = truncateUtf8(task, this.maxTaskBytes).text;
		const agent = this.require(id);
		if (
			![
				"idle",
				"completed",
				"blocked",
				"needs-input",
				"abstained",
				"stale",
				"interrupted",
				"failed",
			].includes(agent.state)
		) {
			throw new Error(`Agent ${id} cannot accept follow-up while ${agent.state}`);
		}
		const unread = agent.mailbox.filter((message) => !message.readAt).slice(-20);
		agent.currentMailboxMessageIds = unread.map((message) => message.id);
		this.startTurn(agent, boundedTask, options);
		return this.copy(agent);
	}

	async updateSemanticState(
		id: string,
		executionPlan: ExecutionPlan,
		capabilityGrant: CapabilityGrant,
		snapshot: SemanticSnapshot,
		compatibility: SemanticCompatibility,
	): Promise<ManagedAgent> {
		const agent = this.require(id);
		if (agent.state === "running" || agent.state === "starting" || agent.state === "closed") {
			throw new Error(`Agent ${id} cannot update semantic state while ${agent.state}`);
		}
		agent.executionPlan = copyExecutionPlan(executionPlan);
		agent.capabilityGrant = structuredClone(capabilityGrant);
		agent.semanticSnapshot = structuredClone(snapshot);
		agent.semanticCompatibility = structuredClone(compatibility);
		agent.updatedAt = this.now();
		await this.changed();
		return this.copy(agent);
	}

	async sendMessage(
		recipientId: string,
		content: string,
		senderId = "root",
		deduplicationKey?: string,
	): Promise<AgentMailboxMessage> {
		if (!content.trim()) throw new Error("Subagent mailbox messages cannot be empty");
		if (deduplicationKey && deduplicationKey.length > 256) {
			throw new Error("Subagent mailbox deduplication keys cannot exceed 256 characters");
		}
		const sender = senderId === "root" ? undefined : this.require(senderId);
		if (sender?.state === "closed")
			throw new Error(`Closed agent ${sender.id} cannot send messages`);
		const recipient = this.require(recipientId, sender?.id);
		if (recipient.state === "closed")
			throw new Error(`Cannot message closed agent ${recipient.id}`);
		const message = this.enqueueMessage(recipient, content, sender?.id ?? "root", deduplicationKey);
		await this.changed();
		return { ...message };
	}

	async readMessages(
		id: string,
		acknowledge = true,
		limit = this.maxMailboxMessages,
	): Promise<AgentMailboxMessage[]> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("Subagent mailbox read limit must be a positive safe integer");
		}
		const agent = this.require(id);
		const unread = agent.mailbox.filter((message) => !message.readAt).slice(0, limit);
		if (acknowledge && unread.length > 0) {
			const readAt = this.now();
			for (const message of unread) message.readAt = readAt;
			await this.changed();
		}
		return unread.map((message) => ({ ...message }));
	}

	async acknowledgeVisibleMessages(
		id: string,
		messageIds: readonly string[],
		completionIds: readonly string[] = [],
		visibleAt = this.now(),
	): Promise<void> {
		const agent = this.require(id);
		const visibleMessageIds = new Set(messageIds);
		const visibleCompletionIds = new Set(completionIds);
		const changedMessages: AgentMailboxMessage[] = [];
		const removedCompletions: Array<{
			owner: ManagedAgent;
			completion: NonNullable<ManagedAgent["pendingCompletions"]>[number];
		}> = [];
		for (const message of agent.mailbox) {
			if (message.readAt === undefined && visibleMessageIds.has(message.id)) {
				message.readAt = visibleAt;
				changedMessages.push(message);
			}
			if (message.completionId && visibleMessageIds.has(message.id)) {
				visibleCompletionIds.add(message.completionId);
			}
		}
		for (const owner of this.agents.values()) {
			for (const completion of owner.pendingCompletions ?? []) {
				if (!visibleCompletionIds.has(completion.completionId)) continue;
				if (completion.recipientId !== agent.id && completion.recipientPath !== agent.taskPath) {
					continue;
				}
				removedCompletions.push({ owner, completion });
			}
		}
		if (changedMessages.length === 0 && removedCompletions.length === 0) return;
		for (const { owner, completion } of removedCompletions) {
			owner.pendingCompletions = (owner.pendingCompletions ?? []).filter(
				(candidate) => candidate.completionId !== completion.completionId,
			);
		}
		agent.updatedAt = Math.max(agent.updatedAt, visibleAt);
		try {
			await this.changed(true);
		} catch (error) {
			for (const message of changedMessages) message.readAt = undefined;
			for (const { owner, completion } of removedCompletions) {
				owner.pendingCompletions = [...(owner.pendingCompletions ?? []), completion].sort(
					(left, right) => left.createdAt - right.createdAt || left.generation - right.generation,
				);
			}
			throw error;
		}
	}

	async wait(
		id: string,
		timeoutMs = 30_000,
		signal?: AbortSignal,
	): Promise<{ timedOut: boolean; agent: ManagedAgent }> {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
			throw new Error("Subagent wait timeout must be a positive finite number");
		}
		if (signal?.aborted) throw waitAbortError();
		const agent = this.require(id);
		const agentId = agent.id;
		const running = this.running.get(agentId);
		if (!running) return { timedOut: false, agent: this.copy(agent) };
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
		});
		const aborted = new Promise<"aborted">((resolve) => {
			onAbort = () => resolve("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const result = await Promise.race([running, timeout, aborted]);
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		if (result === "aborted") throw waitAbortError();
		return result === "timeout"
			? { timedOut: true, agent: this.copy(this.require(agentId)) }
			: { timedOut: false, agent: this.copy(result) };
	}

	async interruptTree(id: string): Promise<ManagedAgent[]> {
		const results: ManagedAgent[] = [];
		for (const target of this.descendants(id).reverse()) {
			const agent = this.require(target);
			if (agent.state === "running" || agent.state === "starting") {
				results.push(await this.interrupt(target));
			}
		}
		return results;
	}

	async interrupt(id: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		const agentId = agent.id;
		if (agent.state !== "running" && agent.state !== "starting")
			throw new Error(`Agent ${id} is not running`);
		if (agent.capabilityGrant?.state === "active") {
			agent.capabilityGrant = revokeCapabilityGrant(
				agent.capabilityGrant,
				"interrupted",
				this.now(),
			);
		}
		if (agent.executionPlan) {
			agent.executionPlan = rotateExecutionPlanGeneration(agent.executionPlan);
		}
		if (agent.state === "starting") {
			const index = this.queue.findIndex((entry) => entry.agent.id === agentId);
			if (index >= 0) {
				const [entry] = this.queue.splice(index, 1);
				const recipient = this.completionRecipient(agent);
				const persistedCompletion = {
					completionId: `completion:${agent.id}:${randomUUID()}`,
					...recipient,
					runId: agent.currentRunId ?? `run:${agent.id}:${randomUUID()}`,
					generation: agent.currentTurnGeneration ?? agent.turnGeneration ?? 1,
					task: truncateUtf8(entry.task, 256).text,
					output: "",
					error: "Interrupted before execution",
					createdAt: this.completionCreatedAt(),
				};
				agent.state = "interrupted";
				agent.pendingCompletions = [...(agent.pendingCompletions ?? []), persistedCompletion];
				this.enqueueCompletionMessage(agent, persistedCompletion, persistedCompletion.error);
				clearCurrentTurn(agent);
				agent.updatedAt = this.now();
				const persisted = await this.persistTerminalState().then(
					() => true,
					() => false,
				);
				const completion: AgentTurnCompletion = {
					...persistedCompletion,
					agent: this.copy(agent),
				};
				entry.resolve(agent);
				this.running.delete(agentId);
				if (persisted) await this.notifyTurnComplete(completion);
				return this.copy(agent);
			}
		}
		this.controllers.get(agentId)?.abort();
		await this.running.get(agentId);
		return this.copy(this.require(agentId));
	}

	async closeTree(id: string): Promise<ManagedAgent[]> {
		const results: ManagedAgent[] = [];
		const failures: unknown[] = [];
		for (const target of this.descendants(id).reverse()) {
			const agent = this.require(target);
			if (agent.state === "closed") continue;
			try {
				results.push(await this.close(target));
			} catch (error) {
				failures.push(error);
				const closed = this.get(target);
				if (closed?.state === "closed") results.push(closed);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to release ${failures.length} subagent(s)`);
		}
		return results;
	}

	async close(id: string): Promise<ManagedAgent> {
		const agent = this.require(id);
		const agentId = agent.id;
		if (agent.state === "closed") throw new Error(`Agent ${id} is already closed`);
		if (agent.children.some((childId) => this.agents.get(childId)?.state !== "closed")) {
			throw new Error(`Agent ${id} has active descendants; close the subtree instead`);
		}
		if (agent.state === "starting" || agent.state === "running") {
			if (agent.capabilityGrant?.state === "active") {
				agent.capabilityGrant = revokeCapabilityGrant(agent.capabilityGrant, "closed", this.now());
			}
			if (agent.executionPlan) {
				agent.executionPlan = rotateExecutionPlanGeneration(agent.executionPlan);
			}
		}
		if (agent.state === "starting") {
			const index = this.queue.findIndex((entry) => entry.agent.id === agentId);
			if (index >= 0) {
				const [entry] = this.queue.splice(index, 1);
				entry.resolve(agent);
				this.running.delete(agentId);
			}
		}
		this.controllers.get(agentId)?.abort();
		await this.running.get(agentId)?.catch(() => undefined);
		agent.state = "closed";
		agent.updatedAt = this.now();
		if (agent.parentId) {
			const parent = this.agents.get(agent.parentId);
			if (parent) parent.children = parent.children.filter((childId) => childId !== agentId);
		}
		clearCurrentTurn(agent);
		let releaseError: unknown;
		try {
			await this.transport.release?.(this.copy(agent));
		} catch (error) {
			releaseError = error;
		}
		this.pruneClosedAgents();
		await this.changed();
		if (releaseError) throw releaseError;
		return this.copy(agent);
	}

	async closeAll(): Promise<void> {
		const roots = [...this.agents.values()]
			.filter((agent) => agent.state !== "closed" && !agent.parentId)
			.map((agent) => agent.id);
		const results = await Promise.allSettled(roots.map((id) => this.closeTree(id)));
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to close ${failures.length} subagent tree(s)`);
		}
	}

	async shutdown(): Promise<void> {
		this.shutdownController.abort(new Error("Subagent registry is shutting down"));
		for (const entry of this.queue.splice(0)) {
			if (entry.agent.capabilityGrant?.state === "active") {
				entry.agent.capabilityGrant = revokeCapabilityGrant(
					entry.agent.capabilityGrant,
					"shutdown",
					this.now(),
				);
			}
			if (entry.agent.executionPlan) {
				entry.agent.executionPlan = rotateExecutionPlanGeneration(entry.agent.executionPlan);
			}
			entry.agent.state = "interrupted";
			clearCurrentTurn(entry.agent);
			entry.resolve(entry.agent);
			this.running.delete(entry.agent.id);
		}
		for (const id of this.controllers.keys()) {
			const agent = this.agents.get(id);
			if (agent?.capabilityGrant?.state === "active") {
				agent.capabilityGrant = revokeCapabilityGrant(
					agent.capabilityGrant,
					"shutdown",
					this.now(),
				);
			}
			if (agent?.executionPlan) {
				agent.executionPlan = rotateExecutionPlanGeneration(agent.executionPlan);
			}
		}
		for (const controller of this.controllers.values()) controller.abort();
		await Promise.all([...this.running.values()].map((turn) => turn.catch(() => undefined)));
		for (const agent of this.agents.values()) {
			if (agent.state !== "closed") {
				if (agent.state === "running" || agent.state === "starting") {
					agent.state = "interrupted";
				}
				clearCurrentTurn(agent);
			}
		}
		let shutdownError: unknown;
		try {
			await this.transport.shutdown?.();
		} catch (error) {
			shutdownError = error;
		}
		await this.changed(true);
		if (shutdownError) throw shutdownError;
	}

	inspectionCounts(): AgentInspectionCounts {
		let activeAgents = 0;
		let retainedAgents = 0;
		for (const agent of this.agents.values()) {
			if (agent.state === "starting" || agent.state === "running") activeAgents++;
			if (agent.state !== "closed") retainedAgents++;
		}
		return { activeAgents, retainedAgents };
	}

	listInspection(includeClosed = false): AgentRunInspectionSummary[] {
		return [...this.agents.values()]
			.filter((agent) => includeClosed || agent.state !== "closed")
			.sort((left, right) => left.createdAt - right.createdAt)
			.map((agent) => this.inspectSummary(agent));
	}

	getInspection(id: string): AgentRunInspectionDetail | undefined {
		const agent = this.findReference(id);
		if (!agent) return undefined;
		return {
			...this.inspectSummary(agent),
			cwd: agent.cwd,
			thinkingLevel: agent.thinkingLevel,
			timeoutMs: agent.timeoutMs,
			currentTimeoutMs: agent.currentTimeoutMs,
			idleTimeoutMs: agent.idleTimeoutMs,
			currentIdleTimeoutMs: agent.currentIdleTimeoutMs,
			maxTurns: agent.maxTurns,
			currentMaxTurns: agent.currentMaxTurns,
			maxToolCalls: agent.maxToolCalls,
			currentMaxToolCalls: agent.currentMaxToolCalls,
			currentTask: agent.currentTask,
			currentRunId: agent.currentRunId,
			currentTurnGeneration: agent.currentTurnGeneration,
			error: agent.error,
			workspaceMode: agent.workspaceMode,
			contextTurns: agent.contextTurns,
			contextBytes: agent.contextBytes,
			contextSources: agent.contextSourceIds?.length,
			contextTruncated: agent.contextTruncated,
			contract: agent.contract ? structuredClone(agent.contract) : undefined,
			resultFormat: agent.resultFormat,
			target: agent.target ? { ...agent.target, trust: { ...agent.target.trust } } : undefined,
			policy: agent.policy
				? {
						inherited: [...agent.policy.inherited],
						overridden: [...agent.policy.overridden],
						unsupported: [...agent.policy.unsupported],
					}
				: undefined,
			structuredResult: agent.structuredResult
				? copyStructuredResult(agent.structuredResult)
				: undefined,
			termination: agent.termination ? copyTurnTerminationReport(agent.termination) : undefined,
			outcome: agent.outcome ? structuredClone(agent.outcome) : undefined,
			executionPlan: agent.executionPlan ? copyExecutionPlan(agent.executionPlan) : undefined,
			capabilityGrant: agent.capabilityGrant ? structuredClone(agent.capabilityGrant) : undefined,
			semanticSnapshot: agent.semanticSnapshot
				? structuredClone(agent.semanticSnapshot)
				: undefined,
			semanticCompatibility: agent.semanticCompatibility
				? structuredClone(agent.semanticCompatibility)
				: undefined,
			telemetry: agent.telemetry ? copyTelemetry(agent.telemetry) : undefined,
		};
	}

	list(includeClosed = false, rootId?: string): ManagedAgent[] {
		return [...this.agents.values()]
			.filter((agent) => !rootId || agent.rootId === rootId)
			.filter((agent) => includeClosed || agent.state !== "closed")
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((agent) => this.copy(agent));
	}

	get(reference: string): ManagedAgent | undefined {
		return this.resolveAgent(reference);
	}

	resolveAgent(reference: string, senderId = "root"): ManagedAgent | undefined {
		const agent = this.findReference(reference, senderId);
		return agent ? this.copy(agent) : undefined;
	}

	listPendingCompletions(): AgentTurnCompletion[] {
		return [...this.agents.values()]
			.flatMap((agent) =>
				(agent.pendingCompletions ?? []).map((completion) => ({
					...completion,
					agent: this.copy(agent),
				})),
			)
			.sort(
				(left, right) =>
					left.createdAt - right.createdAt ||
					left.generation - right.generation ||
					left.completionId.localeCompare(right.completionId),
			);
	}

	async markCompletionDelivered(completionId: string, deliveredAt: number): Promise<void> {
		const agent = [...this.agents.values()].find((candidate) =>
			candidate.pendingCompletions?.some((completion) => completion.completionId === completionId),
		);
		if (!agent) return;
		const acknowledged = (agent.pendingCompletions ?? []).find(
			(completion) => completion.completionId === completionId,
		);
		if (!acknowledged) return;
		agent.pendingCompletions = (agent.pendingCompletions ?? []).filter(
			(completion) => completion.completionId !== completionId,
		);
		if (agent.telemetry) {
			agent.telemetry = {
				...agent.telemetry,
				updatedAt: deliveredAt,
				timing: { ...agent.telemetry.timing, completionDeliveredAt: deliveredAt },
			};
		}
		agent.updatedAt = Math.max(agent.updatedAt, deliveredAt);
		try {
			await this.changed(true);
		} catch (error) {
			if (
				!agent.pendingCompletions?.some(
					(completion) => completion.completionId === acknowledged.completionId,
				)
			) {
				agent.pendingCompletions = [...(agent.pendingCompletions ?? []), acknowledged].sort(
					(left, right) => left.createdAt - right.createdAt || left.generation - right.generation,
				);
			}
			if (agent.telemetry?.timing.completionDeliveredAt === deliveredAt) {
				const { completionDeliveredAt: _discarded, ...timing } = agent.telemetry.timing;
				agent.telemetry = { ...agent.telemetry, timing };
			}
			throw error;
		}
	}

	async sweepExpired(): Promise<number> {
		const removed = this.evictExpired();
		let releaseError: unknown;
		try {
			await this.releaseAgents(removed);
		} catch (error) {
			releaseError = error;
		}
		if (removed.length > 0) await this.changed();
		if (releaseError) throw releaseError;
		return removed.length;
	}

	private startTurn(
		agent: ManagedAgent,
		task: string,
		limits: TurnLimits & { timeoutMs?: number } = {},
	): void {
		if ((agent.pendingCompletions?.length ?? 0) >= MAX_PENDING_COMPLETIONS_PER_AGENT) {
			throw new Error(
				`Agent ${agent.id} has ${MAX_PENDING_COMPLETIONS_PER_AGENT} undelivered completions; wait for delivery before another turn`,
			);
		}
		agent.turnGeneration = (agent.turnGeneration ?? 0) + 1;
		agent.currentTurnGeneration = agent.turnGeneration;
		agent.currentRunId = `run:${agent.id}:${randomUUID()}`;
		agent.state = "starting";
		agent.error = undefined;
		agent.currentTask = task;
		agent.currentTimeoutMs = limits.timeoutMs ?? agent.timeoutMs;
		agent.currentIdleTimeoutMs = limits.idleTimeoutMs ?? agent.idleTimeoutMs;
		agent.currentMaxTurns = limits.maxTurns ?? agent.maxTurns;
		agent.currentMaxToolCalls = limits.maxToolCalls ?? agent.maxToolCalls;
		agent.structuredResult = undefined;
		agent.termination = undefined;
		agent.outcome = undefined;
		agent.updatedAt = this.now();
		agent.telemetry = {
			phase: "queued",
			queuePosition: this.queue.length + 1,
			updatedAt: agent.updatedAt,
			timing: { queuedAt: agent.updatedAt },
		};
		let resolveQueued!: (agent: ManagedAgent) => void;
		const completion = new Promise<ManagedAgent>((resolve) => {
			resolveQueued = resolve;
		});
		this.running.set(agent.id, completion);
		this.queue.push({ agent, task, resolve: resolveQueued });
		this.updateQueuePositions();
		void this.changed();
		this.pumpQueue();
	}

	private pumpQueue(): void {
		while (this.controllers.size < this.maxActiveTurns && this.queue.length > 0) {
			const next = this.queue.shift();
			if (!next) return;
			this.runQueuedTurn(next.agent, next.task, next.resolve);
			this.updateQueuePositions();
		}
	}

	private runQueuedTurn(
		agent: ManagedAgent,
		task: string,
		resolveQueued: (agent: ManagedAgent) => void,
	): void {
		if (
			agent.capabilityGrant &&
			agent.executionPlan &&
			!isCapabilityGrantActive(agent.capabilityGrant, agent.executionPlan, this.now())
		) {
			agent.state = "failed";
			agent.error = "Capability grant expired or no longer matches the accepted plan";
			agent.outcome = classifyStructuredOutcome("failed", "capability-grant-invalid");
			const recipient = this.completionRecipient(agent);
			const persistedCompletion = {
				completionId: `completion:${agent.id}:${randomUUID()}`,
				...recipient,
				runId: agent.currentRunId ?? `run:${agent.id}:${randomUUID()}`,
				generation: agent.currentTurnGeneration ?? agent.turnGeneration ?? 1,
				task: truncateUtf8(task, 256).text,
				output: "",
				error: truncateUtf8(agent.error, 512).text,
				createdAt: this.completionCreatedAt(),
			};
			agent.pendingCompletions = [...(agent.pendingCompletions ?? []), persistedCompletion];
			this.enqueueCompletionMessage(agent, persistedCompletion, persistedCompletion.error ?? "");
			clearCurrentTurn(agent);
			agent.updatedAt = this.now();
			void this.persistTerminalState()
				.then(() =>
					this.notifyTurnComplete({
						...persistedCompletion,
						agent: this.copy(agent),
					}),
				)
				.catch(() => undefined)
				.finally(() => {
					resolveQueued(agent);
					this.running.delete(agent.id);
				});
			return;
		}
		const controller = new AbortController();
		this.controllers.set(agent.id, controller);
		agent.state = "running";
		agent.updatedAt = this.now();
		const startedAt = this.now();
		const runId = agent.currentRunId ?? `run:${agent.id}:${randomUUID()}`;
		const turnGeneration = agent.currentTurnGeneration ?? agent.turnGeneration ?? 1;
		const completionKey = `completion:${agent.id}:${randomUUID()}`;
		const acceptedPlanId = agent.executionPlan?.id;
		let completionContent = "";
		let completionOutput = "";
		let completionError: string | undefined;
		const visibleMailboxMessageIds = [...(agent.currentMailboxMessageIds ?? [])];
		void this.transport
			.runTurn(this.copy(agent), task, controller.signal, (progress) => {
				agent.telemetry = {
					...progress,
					queuePosition: undefined,
					timing: {
						queuedAt: agent.telemetry?.timing.queuedAt,
						...progress.timing,
					},
				};
			})
			.then(async (outcome) => {
				if (visibleMailboxMessageIds.length > 0) {
					await this.acknowledgeVisibleMessages(
						agent.id,
						visibleMailboxMessageIds,
						[],
						this.now(),
					).catch(() => undefined);
				}
				const output = truncateUtf8(outcome.output, this.maxTurnOutputBytes).text;
				const error = outcome.error
					? truncateUtf8(outcome.error, this.maxTurnOutputBytes).text
					: undefined;
				agent.history.push({
					runId,
					generation: turnGeneration,
					task,
					output,
					startedAt,
					completedAt: this.now(),
					exitCode: outcome.exitCode,
					truncated: outcome.truncated,
					termination: outcome.termination
						? copyTurnTerminationReport(outcome.termination)
						: undefined,
				});
				agent.history = agent.history.slice(-this.maxHistoryTurns);
				agent.structuredResult =
					outcome.structuredResult ?? parseAnyStructuredSubagentResult(output, agent.resultFormat);
				agent.outcome =
					outcome.outcome ??
					(outcome.aborted
						? classifyStructuredOutcome("interrupted", "transport-aborted")
						: agent.structuredResult?.version === "pi-subagents:result:v2"
							? classifyStructuredOutcome(
									agent.structuredResult.status,
									agent.structuredResult.reasonCode,
								)
							: agent.resultFormat !== undefined &&
									agent.resultFormat !== "text" &&
									agent.structuredResult === undefined
								? classifyStructuredOutcome("contract-invalid", "malformed-structured-result")
								: undefined);
				const staleGeneration = Boolean(
					acceptedPlanId && agent.executionPlan?.id !== acceptedPlanId,
				);
				if (staleGeneration) {
					agent.outcome = classifyStructuredOutcome("stale", "cancelled-generation");
				}
				agent.state = staleGeneration
					? "stale"
					: outcome.aborted
						? "interrupted"
						: outcome.exitCode !== 0
							? "failed"
							: lifecycleStateForOutcome(agent.outcome?.status);
				agent.error = error;
				if (agent.capabilityGrant?.state === "active") {
					agent.capabilityGrant = revokeCapabilityGrant(
						agent.capabilityGrant,
						"turn-settled",
						this.now(),
					);
				}
				agent.policy = outcome.policy;
				agent.telemetry = outcome.telemetry
					? {
							...outcome.telemetry,
							timing: {
								queuedAt: agent.telemetry?.timing.queuedAt,
								...outcome.telemetry.timing,
							},
						}
					: agent.telemetry;
				agent.termination = outcome.termination
					? copyTurnTerminationReport(outcome.termination)
					: undefined;
				completionOutput = output;
				completionError = error;
				completionContent = output || error || `${agent.id} ${agent.state}`;
				return agent;
			})
			.catch((error) => {
				const staleGeneration = Boolean(
					acceptedPlanId && agent.executionPlan?.id !== acceptedPlanId,
				);
				agent.state = staleGeneration
					? "stale"
					: controller.signal.aborted
						? "interrupted"
						: "failed";
				agent.outcome = classifyStructuredOutcome(
					staleGeneration ? "stale" : controller.signal.aborted ? "interrupted" : "failed",
					staleGeneration
						? "cancelled-generation"
						: controller.signal.aborted
							? "transport-aborted"
							: "transport-error",
				);
				if (agent.capabilityGrant?.state === "active") {
					agent.capabilityGrant = revokeCapabilityGrant(
						agent.capabilityGrant,
						"turn-failed",
						this.now(),
					);
				}
				agent.error = truncateUtf8(
					error instanceof Error ? error.message : String(error),
					this.maxTurnOutputBytes,
				).text;
				agent.history.push({
					runId,
					generation: turnGeneration,
					task,
					output: "",
					startedAt,
					completedAt: this.now(),
					exitCode: controller.signal.aborted ? 130 : 1,
				});
				agent.history = agent.history.slice(-this.maxHistoryTurns);
				agent.telemetry = {
					...(agent.telemetry ?? {
						phase: "failed",
						updatedAt: this.now(),
						timing: { queuedAt: startedAt },
					}),
					phase: controller.signal.aborted ? "interrupted" : "failed",
					failurePhase: agent.telemetry?.phase ?? "running",
					updatedAt: this.now(),
				};
				completionError = agent.error;
				completionContent = agent.error;
				return agent;
			})
			.finally(async () => {
				const recipient = this.completionRecipient(agent);
				const persistedCompletion = {
					completionId: completionKey,
					...recipient,
					runId,
					generation: turnGeneration,
					task: truncateUtf8(task, 256).text,
					output: truncateUtf8(completionOutput, MAX_TOOL_MESSAGE_BYTES).text,
					error: completionError ? truncateUtf8(completionError, 512).text : undefined,
					createdAt: this.completionCreatedAt(),
				};
				agent.pendingCompletions = [...(agent.pendingCompletions ?? []), persistedCompletion];
				this.enqueueCompletionMessage(agent, persistedCompletion, completionContent);
				clearCurrentTurn(agent);
				agent.updatedAt = this.now();
				const persisted = await this.persistTerminalState().then(
					() => true,
					() => false,
				);
				this.controllers.delete(agent.id);
				const turnCompletion: AgentTurnCompletion = {
					...persistedCompletion,
					agent: this.copy(agent),
				};
				this.running.delete(agent.id);
				resolveQueued(agent);
				this.pumpQueue();
				if (persisted) await this.notifyTurnComplete(turnCompletion);
			});
	}

	private updateQueuePositions(): void {
		for (const [index, entry] of this.queue.entries()) {
			if (!entry.agent.telemetry) continue;
			entry.agent.telemetry = {
				...entry.agent.telemetry,
				queuePosition: index + 1,
				updatedAt: this.now(),
			};
		}
	}

	private completionRecipient(
		agent: ManagedAgent,
	): Pick<
		NonNullable<ManagedAgent["pendingCompletions"]>[number],
		"recipientId" | "recipientPath"
	> {
		return resolveCompletionRecipient(agent, (id) => this.agents.get(id));
	}

	private enqueueCompletionMessage(
		agent: ManagedAgent,
		completion: NonNullable<ManagedAgent["pendingCompletions"]>[number],
		content: string,
	): void {
		if (!completion.recipientId || completion.recipientId === "root") return;
		const recipient = this.agents.get(completion.recipientId);
		if (!recipient || recipient.state === "closed") return;
		this.enqueueMessage(
			recipient,
			content || "(no output)",
			agent.id,
			completion.completionId,
			completion.completionId,
		);
	}

	private enqueueMessage(
		recipient: ManagedAgent,
		content: string,
		senderId: string,
		deduplicationKey?: string,
		completionId?: string,
	): AgentMailboxMessage {
		if (deduplicationKey) {
			const existing = recipient.mailbox.find(
				(message) => message.deduplicationKey === deduplicationKey && message.senderId === senderId,
			);
			if (existing) return existing;
		}
		const bounded = truncateUtf8(content, this.maxMailboxMessageBytes);
		const message: AgentMailboxMessage = {
			id: `msg_${randomUUID()}`,
			senderId,
			recipientId: recipient.id,
			content: bounded.text,
			createdAt: this.now(),
			deduplicationKey,
			completionId,
		};
		recipient.mailbox.push(message);
		recipient.mailbox = recipient.mailbox.slice(-this.maxMailboxMessages);
		recipient.updatedAt = this.now();
		return message;
	}

	private descendants(id: string): string[] {
		const root = this.require(id);
		const result: string[] = [];
		const visit = (agent: ManagedAgent) => {
			result.push(agent.id);
			for (const childId of agent.children) {
				const child = this.agents.get(childId);
				if (child) visit(child);
			}
		};
		visit(root);
		return result;
	}

	private require(reference: string, senderId = "root"): ManagedAgent {
		const agent = this.findReference(reference, senderId);
		if (!agent) throw new Error(`Unknown subagent: ${safeTerminalLine(reference, 256)}`);
		return agent;
	}

	private findReference(reference: string, senderId = "root"): ManagedAgent | undefined {
		const direct = this.agents.get(reference);
		if (direct) return direct;
		const sender =
			senderId === "root"
				? undefined
				: (this.agents.get(senderId) ?? this.findByTaskPath(senderId));
		if (senderId !== "root" && !sender) return undefined;
		let taskPath: string;
		try {
			taskPath = resolveTaskPath(sender?.taskPath ?? ROOT_TASK_PATH, reference);
		} catch {
			return undefined;
		}
		return this.findByTaskPath(taskPath);
	}

	private findByTaskPath(taskPath: string): ManagedAgent | undefined {
		return [...this.agents.values()].find(
			(agent) => agent.state !== "closed" && agent.taskPath === taskPath,
		);
	}

	private reserveRestoredIdentity(
		record: ManagedAgent,
		parentPath: string,
		reservedPaths: Set<string>,
	): Pick<ManagedAgent, "taskName" | "taskPath"> {
		let taskName: string | undefined;
		try {
			taskName = record.taskName ? validateTaskName(record.taskName) : undefined;
		} catch {
			taskName = undefined;
		}
		if (!taskName && record.taskPath) {
			try {
				const storedPath = validateTaskPath(record.taskPath);
				const storedName = storedPath.slice(storedPath.lastIndexOf("/") + 1);
				taskName = validateTaskName(storedName);
			} catch {
				taskName = undefined;
			}
		}
		taskName ??= deriveTaskName(record.id);
		let taskPath = joinTaskPath(parentPath, taskName);
		if (reservedPaths.has(taskPath)) {
			taskName = deriveTaskName(record.id);
			taskPath = joinTaskPath(parentPath, taskName);
		}
		if (reservedPaths.has(taskPath)) {
			throw new Error(`Cannot restore duplicate canonical subagent task path: ${taskPath}`);
		}
		reservedPaths.add(taskPath);
		return { taskName, taskPath };
	}

	private retainedCount(): number {
		return [...this.agents.values()].filter((agent) => agent.state !== "closed").length;
	}

	private completionCreatedAt(): number {
		this.lastCompletionAt = Math.max(this.now(), this.lastCompletionAt + 1);
		return this.lastCompletionAt;
	}

	private evictExpired(): ManagedAgent[] {
		const cutoff = this.now() - this.idleTtlMs;
		const protectedIds = new Set<string>();
		for (const agent of this.agents.values()) {
			if (
				agent.state !== "running" &&
				agent.state !== "starting" &&
				(agent.pendingCompletions?.length ?? 0) === 0
			) {
				continue;
			}
			let current: ManagedAgent | undefined = agent;
			while (current) {
				protectedIds.add(current.id);
				current = current.parentId ? this.agents.get(current.parentId) : undefined;
			}
		}
		const removed: ManagedAgent[] = [];
		const candidates = [...this.agents.values()].sort((left, right) => right.depth - left.depth);
		for (const agent of candidates) {
			if (protectedIds.has(agent.id) || agent.updatedAt >= cutoff) continue;
			if (agent.children.some((childId) => this.agents.get(childId)?.state !== "closed")) continue;
			this.agents.delete(agent.id);
			if (agent.parentId) {
				const parent = this.agents.get(agent.parentId);
				if (parent) parent.children = parent.children.filter((childId) => childId !== agent.id);
			}
			removed.push(this.copy(agent));
		}
		return removed;
	}

	private async releaseAgents(agents: readonly ManagedAgent[]): Promise<void> {
		if (!this.transport.release || agents.length === 0) return;
		const results = await Promise.allSettled(
			agents.map((agent) => this.transport.release?.(agent)),
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to release ${failures.length} subagent transport session(s)`,
			);
		}
	}

	private pruneClosedAgents(): void {
		const closed = [...this.agents.values()]
			.filter((agent) => agent.state === "closed")
			.sort((left, right) => right.updatedAt - left.updatedAt);
		for (const agent of closed.slice(this.maxAgents)) this.agents.delete(agent.id);
	}

	private async persistTerminalState(): Promise<void> {
		let failures = 0;
		for (;;) {
			try {
				await this.changed(true);
				return;
			} catch (error) {
				if (this.shutdownController.signal.aborted) throw error;
				failures++;
				if (failures === 1) continue;
				const delay = Math.min(
					INITIAL_PERSISTENCE_RETRY_DELAY_MS * 2 ** (failures - 2),
					MAX_PERSISTENCE_RETRY_DELAY_MS,
				);
				await waitForPersistenceRetry(delay, this.shutdownController.signal);
			}
		}
	}

	private async notifyTurnComplete(completion: AgentTurnCompletion): Promise<void> {
		try {
			await this.options.onTurnComplete?.(completion);
		} catch {
			// Completion notifications are best-effort and must not destabilize agent lifecycle.
		}
	}

	private changed(propagateError = false): Promise<void> {
		const snapshot = this.list(true);
		const next = this.changeQueue.then(async () => {
			try {
				await this.options.onChange?.(snapshot);
			} catch (error) {
				if (propagateError) throw error;
				// Non-terminal persistence remains best-effort so lifecycle controls stay usable.
			}
		});
		this.changeQueue = next.catch(() => undefined);
		return next;
	}

	private inspectSummary(agent: ManagedAgent): AgentRunInspectionSummary {
		let unreadMessages = 0;
		for (const message of agent.mailbox) {
			if (message.readAt === undefined) unreadMessages++;
		}
		return {
			id: agent.id,
			taskName: agent.taskName,
			taskPath: agent.taskPath,
			agent: agent.agent,
			state: agent.state,
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
			historyCount: agent.history.length,
			unreadMessages,
			turnGeneration: agent.turnGeneration ?? 0,
			pendingCompletionCount: agent.pendingCompletions?.length ?? 0,
		};
	}

	private copy(agent: ManagedAgent): ManagedAgent {
		return {
			...agent,
			children: [...agent.children],
			contextSourceIds: [...(agent.contextSourceIds ?? [])],
			currentMailboxMessageIds: agent.currentMailboxMessageIds
				? [...agent.currentMailboxMessageIds]
				: undefined,
			pendingCompletions: (agent.pendingCompletions ?? []).map((completion) => ({
				...completion,
			})),
			history: agent.history.map((turn) => ({ ...turn })),
			mailbox: agent.mailbox.map((message) => ({ ...message })),
			contract: agent.contract ? structuredClone(agent.contract) : undefined,
			target: agent.target ? { ...agent.target, trust: { ...agent.target.trust } } : undefined,
			policy: agent.policy
				? {
						inherited: [...agent.policy.inherited],
						overridden: [...agent.policy.overridden],
						unsupported: [...agent.policy.unsupported],
					}
				: undefined,
			structuredResult: agent.structuredResult
				? copyStructuredResult(agent.structuredResult)
				: undefined,
			termination: agent.termination ? copyTurnTerminationReport(agent.termination) : undefined,
			outcome: agent.outcome ? structuredClone(agent.outcome) : undefined,
			executionPlan: agent.executionPlan ? copyExecutionPlan(agent.executionPlan) : undefined,
			capabilityGrant: agent.capabilityGrant ? structuredClone(agent.capabilityGrant) : undefined,
			semanticSnapshot: agent.semanticSnapshot
				? structuredClone(agent.semanticSnapshot)
				: undefined,
			semanticCompatibility: agent.semanticCompatibility
				? structuredClone(agent.semanticCompatibility)
				: undefined,
			telemetry: agent.telemetry ? copyTelemetry(agent.telemetry) : undefined,
		};
	}
}

function lifecycleStateForOutcome(
	status: import("./result-contract.js").SubagentOutcomeStatus | undefined,
): AgentLifecycleState {
	switch (status) {
		case "blocked":
		case "needs-input":
		case "abstained":
		case "stale":
			return status;
		case "failed":
		case "contract-invalid":
			return "failed";
		case "interrupted":
			return "interrupted";
		default:
			return "completed";
	}
}

function copyStructuredResult(value: AnyStructuredSubagentResult): AnyStructuredSubagentResult {
	return structuredClone(value);
}

function copyTelemetry(value: TransportTelemetry): TransportTelemetry {
	return {
		...value,
		timing: { ...value.timing },
		usage: value.usage ? { ...value.usage } : undefined,
	};
}
