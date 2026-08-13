import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionDelivery } from "./agents/types.js";
import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, MAX_TOOL_MESSAGE_BYTES, truncateUtf8 } from "./limits.js";
import type { AgentTurnCompletion, ManagedAgent } from "./registry.js";
import { safeTerminalText } from "./safe-text.js";
import { PI_SUBAGENTS_RPC_PROTOCOL } from "./transport-types.js";

const MAX_COMPLETION_ERROR_BYTES = 512;
const MAX_COMPLETIONS_PER_MESSAGE = 16;
const COMPLETION_BATCH_DELAY_MS = 10;

interface CompletionMetadata {
	protocol: typeof PI_SUBAGENTS_RPC_PROTOCOL;
	completionId: string;
	runId: string;
	generation: number;
	agentId: string;
	agent: string;
	state: string;
	transport?: string;
	structuredResult?: ManagedAgent["structuredResult"];
	outcome?: ManagedAgent["outcome"];
	capabilityGrant?: ManagedAgent["capabilityGrant"];
}

interface CompletionMessage {
	customType: "pi-subagent-completion";
	content: string;
	display: true;
	details:
		| CompletionMetadata
		| {
				completionCount: number;
				completions: CompletionMetadata[];
		  };
}

type CompletionContext = Pick<ExtensionContext, "hasPendingMessages" | "isIdle">;
type CompletionPi = Pick<ExtensionAPI, "sendMessage">;

export interface CompletionDeliveryBrokerOptions {
	onDeliveryError?: (error: unknown) => void;
	onAcknowledged?: (completions: readonly AgentTurnCompletion[], acknowledgedAt: number) => void;
	now?: () => number;
}

/** Owns bounded completion batching and at most one idle-root wake for one parent session. */
export class CompletionDeliveryBroker {
	private pending: AgentTurnCompletion[] = [];
	private readonly knownCompletionIds = new Set<string>();
	private awaitingParentAck: AgentTurnCompletion[] = [];
	private flushTimer?: NodeJS.Timeout;
	private wakeInFlight = false;
	private closed = false;

	constructor(
		private readonly pi: CompletionPi,
		private readonly ctx: CompletionContext,
		private delivery: CompletionDelivery,
		private readonly options: CompletionDeliveryBrokerOptions = {},
	) {}

	enqueue(completion: AgentTurnCompletion): void {
		if (this.closed || this.knownCompletionIds.has(completion.completionId)) return;
		this.knownCompletionIds.add(completion.completionId);
		this.pending.push(completion);
		this.scheduleFlush();
	}

	setDelivery(value: CompletionDelivery): void {
		this.delivery = value;
		this.scheduleFlush();
	}

	onParentTurnStart(): void {
		this.wakeInFlight = false;
		this.scheduleFlush();
	}

	onParentContext(messages: readonly unknown[]): void {
		this.acknowledgeVisible(completionIdsFromContext(messages));
		if (this.awaitingParentAck.length > 0) {
			this.pending = [...this.awaitingParentAck.splice(0), ...this.pending];
		}
		this.scheduleFlush();
	}

	onParentSettled(): void {
		this.wakeInFlight = false;
		this.scheduleFlush();
	}

	flush(): void {
		if (this.closed || this.pending.length === 0) return;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.delivery === "auto-resume" && !this.isRootIdle()) return;

		const completions = this.pending.splice(0);
		const batches = chunkCompletions(completions);
		let canWake = this.shouldWakeRoot();
		for (let index = 0; index < batches.length; index++) {
			const triggerTurn = canWake && index === batches.length - 1;
			const batch = batches[index];
			const message = buildCompletionMessage(batch);
			if (triggerTurn) this.wakeInFlight = true;
			this.awaitingParentAck.push(...batch);
			try {
				this.pi.sendMessage(message, { deliverAs: "steer", triggerTurn });
			} catch (primaryError) {
				this.removeAwaiting(batch);
				if (triggerTurn) this.wakeInFlight = false;
				canWake = false;
				this.awaitingParentAck.push(...batch);
				try {
					this.pi.sendMessage(message, { deliverAs: "nextTurn", triggerTurn: false });
				} catch (fallbackError) {
					this.removeAwaiting(batch);
					this.pending = [...batches.slice(index).flat(), ...this.pending];
					try {
						this.options.onDeliveryError?.(
							new AggregateError(
								[primaryError, fallbackError],
								"Detached subagent completion delivery failed",
							),
						);
					} catch {
						// Delivery retention must survive a failing observer.
					}
					return;
				}
			}
		}
	}

	close(): void {
		this.closed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.pending = [];
		this.awaitingParentAck = [];
		this.knownCompletionIds.clear();
	}

	private scheduleFlush(): void {
		if (this.closed || this.pending.length === 0 || this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, COMPLETION_BATCH_DELAY_MS);
	}

	private acknowledgeVisible(visibleIds: ReadonlySet<string>): void {
		if (visibleIds.size === 0) return;
		const completions = [...this.awaitingParentAck, ...this.pending].filter((completion) =>
			visibleIds.has(completion.completionId),
		);
		if (completions.length === 0) return;
		const acknowledgedIds = new Set(completions.map((completion) => completion.completionId));
		this.awaitingParentAck = this.awaitingParentAck.filter(
			(completion) => !acknowledgedIds.has(completion.completionId),
		);
		this.pending = this.pending.filter(
			(completion) => !acknowledgedIds.has(completion.completionId),
		);
		for (const completion of completions) this.knownCompletionIds.delete(completion.completionId);
		try {
			this.options.onAcknowledged?.(completions, (this.options.now ?? Date.now)());
		} catch {
			// Context assembly already observed the message, so observer failures cannot retract it.
		}
	}

	private removeAwaiting(completions: readonly AgentTurnCompletion[]): void {
		const removed = new Set(completions.map((completion) => completion.completionId));
		this.awaitingParentAck = this.awaitingParentAck.filter(
			(completion) => !removed.has(completion.completionId),
		);
	}

	private isRootIdle(): boolean {
		try {
			return this.ctx.isIdle();
		} catch {
			return false;
		}
	}

	private shouldWakeRoot(): boolean {
		if (this.delivery !== "auto-resume" || this.wakeInFlight) return false;
		try {
			return !this.ctx.hasPendingMessages();
		} catch {
			return false;
		}
	}
}

function completionIdsFromContext(messages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "custom" || record.customType !== "pi-subagent-completion") continue;
		const details = record.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) continue;
		const metadata = details as Record<string, unknown>;
		if (
			metadata.protocol === PI_SUBAGENTS_RPC_PROTOCOL &&
			typeof metadata.completionId === "string"
		) {
			ids.add(metadata.completionId);
		}
		if (!Array.isArray(metadata.completions)) continue;
		for (const completion of metadata.completions) {
			if (!completion || typeof completion !== "object" || Array.isArray(completion)) continue;
			const item = completion as Record<string, unknown>;
			if (item.protocol === PI_SUBAGENTS_RPC_PROTOCOL && typeof item.completionId === "string") {
				ids.add(item.completionId);
			}
		}
	}
	return ids;
}

function chunkCompletions(completions: AgentTurnCompletion[]): AgentTurnCompletion[][] {
	const batches: AgentTurnCompletion[][] = [];
	for (let index = 0; index < completions.length; index += MAX_COMPLETIONS_PER_MESSAGE) {
		batches.push(completions.slice(index, index + MAX_COMPLETIONS_PER_MESSAGE));
	}
	return batches;
}

function buildCompletionMessage(completions: AgentTurnCompletion[]): CompletionMessage {
	if (completions.length === 1) {
		const completion = completions[0];
		return {
			customType: "pi-subagent-completion",
			content: buildDetachedCompletionMessage(completion),
			display: true,
			details: completionMetadata(completion),
		};
	}
	const content = truncateUtf8(
		[
			"Message Type: SUBAGENT_COMPLETION_BATCH",
			`Protocol: ${PI_SUBAGENTS_RPC_PROTOCOL}`,
			`Completion Count: ${completions.length}`,
			...completions.flatMap((completion, index) => [
				"",
				`--- Completion ${index + 1} of ${completions.length} ---`,
				buildDetachedCompletionMessage(completion),
			]),
		].join("\n"),
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
	return {
		customType: "pi-subagent-completion",
		content,
		display: true,
		details: {
			completionCount: completions.length,
			completions: completions.map(completionMetadata),
		},
	};
}

function completionMetadata(completion: AgentTurnCompletion): CompletionMetadata {
	return {
		protocol: PI_SUBAGENTS_RPC_PROTOCOL,
		completionId: completion.completionId,
		runId: completion.runId,
		generation: completion.generation,
		agentId: completion.agent.id,
		agent: completion.agent.agent,
		state: completion.agent.state,
		...(completion.agent.telemetry?.transport
			? { transport: completion.agent.telemetry.transport }
			: {}),
		...(completion.agent.structuredResult
			? { structuredResult: completion.agent.structuredResult }
			: {}),
		...(completion.agent.outcome ? { outcome: completion.agent.outcome } : {}),
		...(completion.agent.capabilityGrant
			? { capabilityGrant: completion.agent.capabilityGrant }
			: {}),
	};
}

export function buildDetachedCompletionMessage(completion: AgentTurnCompletion): string {
	const task = sanitizeCompletionLine(completion.task, 256) || "(unknown task)";
	const agentName = sanitizeCompletionLine(completion.agent.agent, 128) || "(unknown agent)";
	const output = safeTerminalText(redactPrivateText(completion.output));
	const error = completion.error
		? truncateUtf8(
				safeTerminalText(redactPrivateText(completion.error)),
				MAX_COMPLETION_ERROR_BYTES,
			).text
		: "";
	return truncateUtf8(
		[
			"Message Type: SUBAGENT_COMPLETION",
			`Protocol: ${PI_SUBAGENTS_RPC_PROTOCOL}`,
			`Completion ID: ${completion.completionId}`,
			`Run ID: ${completion.runId}`,
			`Generation: ${completion.generation}`,
			`Agent ID: ${completion.agent.id}`,
			`Agent: ${agentName}`,
			`Task: ${task}`,
			`State: ${completion.agent.state}`,
			...(error.trim() ? ["Error:", error] : []),
			"Payload:",
			output.trim() ? output : "(no output)",
		].join("\n"),
		MAX_TOOL_MESSAGE_BYTES,
	).text;
}

function sanitizeCompletionLine(value: string, maxBytes: number): string {
	return (
		truncateUtf8(redactPrivateText(value), maxBytes)
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip untrusted terminal controls.
			.text.replace(/[\u0000-\u001f\u007f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}
