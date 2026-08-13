import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";

export const TIMEOUT_CHECKPOINT_VERSION = "pi-subagents:checkpoint:v1" as const;
export const TURN_TERMINATION_VERSION = "pi-subagents:termination:v1" as const;

const DEFAULT_CHECKPOINT_BYTES = 16 * 1024;
const MAX_ITEMS = 10;
const MAX_ITEM_BYTES = 2 * 1024;
const MAX_PENDING_TOOLS = 50;
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);
const FILE_TOOLS = new Set(["edit", "write"]);

export type TurnTerminationReason =
	| "work_timeout"
	| "idle_timeout"
	| "turn_limit"
	| "tool_call_limit"
	| "orchestration_timeout";

export interface CompletedToolEvidence {
	toolName: string;
	output: string;
	isError: boolean;
}

export interface TimeoutCheckpoint {
	version: typeof TIMEOUT_CHECKPOINT_VERSION;
	task: string;
	partialOutput?: string;
	assistantNotes: string[];
	completedTools: CompletedToolEvidence[];
	changedFiles: string[];
	sideEffectsMayHaveOccurred: boolean;
	truncated: boolean;
}

export interface TurnFinalizationReport {
	attempted: boolean;
	status: "completed" | "failed" | "timed_out" | "skipped";
	durationMs: number;
	error?: string;
}

export interface TurnTerminationReport {
	version: typeof TURN_TERMINATION_VERSION;
	reason: TurnTerminationReason;
	limit: number;
	checkpoint: TimeoutCheckpoint;
	finalization: TurnFinalizationReport;
}

export interface TimeoutProgressJournalOptions {
	maxBytes?: number;
}

interface PendingToolCall {
	name: string;
	path?: string;
}

export class TimeoutProgressJournal {
	private readonly assistantNotes: string[] = [];
	private readonly completedTools: CompletedToolEvidence[] = [];
	private readonly changedFiles = new Set<string>();
	private readonly pendingTools = new Map<string, PendingToolCall>();
	private readonly maxBytes: number;
	private sideEffectsMayHaveOccurred = false;
	private truncated = false;

	constructor(options: TimeoutProgressJournalOptions = {}) {
		const requested = options.maxBytes ?? DEFAULT_CHECKPOINT_BYTES;
		if (
			!Number.isSafeInteger(requested) ||
			requested < 512 ||
			requested > DEFAULT_MAX_CONTEXT_BYTES
		) {
			throw new Error(
				`Timeout checkpoint limit must be an integer between 512 and ${DEFAULT_MAX_CONTEXT_BYTES}`,
			);
		}
		this.maxBytes = requested;
	}

	recordAssistantText(text: string): void {
		const bounded = boundedPrivate(text, MAX_ITEM_BYTES);
		if (!bounded) return;
		this.assistantNotes.push(bounded);
		this.trimItems(this.assistantNotes);
	}

	recordToolCall(id: string, name: string, args: Record<string, unknown> = {}): void {
		const toolName = boundedPrivate(name, 256);
		if (!toolName) return;
		const path = toolPath(args);
		this.pendingTools.set(id, { name: toolName, path });
		while (this.pendingTools.size > MAX_PENDING_TOOLS) {
			const oldest = this.pendingTools.keys().next().value;
			if (typeof oldest !== "string") break;
			this.pendingTools.delete(oldest);
			this.truncated = true;
		}
		if (MUTATING_TOOLS.has(toolName)) this.sideEffectsMayHaveOccurred = true;
	}

	recordToolResult(
		id: string,
		name: string,
		result: { content?: unknown; isError?: unknown },
	): void {
		const pending = this.pendingTools.get(id);
		this.pendingTools.delete(id);
		const toolName = boundedPrivate(pending?.name || name, 256);
		if (!toolName) return;
		if (pending?.path && FILE_TOOLS.has(toolName)) this.changedFiles.add(pending.path);
		const output = boundedPrivate(textContent(result.content), MAX_ITEM_BYTES);
		this.completedTools.push({
			toolName,
			output: output || "(no text output)",
			isError: result.isError === true,
		});
		this.trimItems(this.completedTools);
	}

	checkpoint(task: string, partialOutput?: string): TimeoutCheckpoint {
		const checkpoint: TimeoutCheckpoint = {
			version: TIMEOUT_CHECKPOINT_VERSION,
			task: boundedPrivate(task, 4 * 1024),
			partialOutput: partialOutput ? boundedPrivate(partialOutput, 4 * 1024) : undefined,
			assistantNotes: [...this.assistantNotes],
			completedTools: this.completedTools.map((item) => ({ ...item })),
			changedFiles: [...this.changedFiles].slice(-MAX_ITEMS),
			sideEffectsMayHaveOccurred: this.sideEffectsMayHaveOccurred,
			truncated: this.truncated || this.changedFiles.size > MAX_ITEMS,
		};
		return fitCheckpoint(checkpoint, this.maxBytes);
	}

	private trimItems(items: unknown[]): void {
		if (items.length <= MAX_ITEMS) return;
		items.splice(0, items.length - MAX_ITEMS);
		this.truncated = true;
	}
}

export function formatTurnTerminationMessage(
	reason: TurnTerminationReason,
	limit: number,
	prefix = "Subagent",
): string {
	switch (reason) {
		case "work_timeout":
			return `${prefix} timed out after ${limit}ms`;
		case "orchestration_timeout":
			return `${prefix} orchestration deadline expired after ${limit}ms`;
		case "idle_timeout":
			return `${prefix} made no completed progress for ${limit}ms`;
		case "turn_limit":
			return `${prefix} reached the ${limit}-turn limit before producing a final answer`;
		case "tool_call_limit":
			return `${prefix} exceeded the ${limit}-tool-call limit`;
	}
}

export function copyTurnTerminationReport(report: TurnTerminationReport): TurnTerminationReport {
	return {
		...report,
		checkpoint: {
			...report.checkpoint,
			assistantNotes: [...report.checkpoint.assistantNotes],
			completedTools: report.checkpoint.completedTools.map((item) => ({ ...item })),
			changedFiles: [...report.checkpoint.changedFiles],
		},
		finalization: { ...report.finalization },
	};
}

export function formatTimeoutCheckpoint(checkpoint: TimeoutCheckpoint): string {
	const sections = [
		checkpoint.partialOutput ? `Partial output:\n${checkpoint.partialOutput}` : undefined,
		checkpoint.assistantNotes.length > 0
			? `Assistant checkpoints:\n${checkpoint.assistantNotes.map((note) => `- ${note}`).join("\n")}`
			: undefined,
		checkpoint.completedTools.length > 0
			? `Completed tool evidence:\n${checkpoint.completedTools
					.map((item) => `- ${item.toolName}${item.isError ? " (error)" : ""}: ${item.output}`)
					.join("\n")}`
			: undefined,
		checkpoint.changedFiles.length > 0
			? `Changed files: ${checkpoint.changedFiles.join(", ")}`
			: undefined,
		checkpoint.sideEffectsMayHaveOccurred
			? "Side effects may have occurred before termination."
			: undefined,
		checkpoint.truncated ? "Checkpoint evidence was truncated." : undefined,
	].filter((value): value is string => Boolean(value));
	return truncateUtf8(
		sections.join("\n\n") || "No completed evidence was captured.",
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
}

export function journalMessages(
	journal: TimeoutProgressJournal,
	messages: readonly unknown[],
): void {
	for (const message of messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const value = message as Record<string, unknown>;
		if (value.role === "assistant" && Array.isArray(value.content)) {
			for (const part of value.content) {
				if (!part || typeof part !== "object" || Array.isArray(part)) continue;
				const item = part as Record<string, unknown>;
				if (item.type === "text" && typeof item.text === "string") {
					journal.recordAssistantText(item.text);
				} else if (
					item.type === "toolCall" &&
					typeof item.id === "string" &&
					typeof item.name === "string"
				) {
					journal.recordToolCall(
						item.id,
						item.name,
						isRecord(item.arguments) ? item.arguments : {},
					);
				}
			}
		} else if (value.role === "toolResult") {
			journal.recordToolResult(
				typeof value.toolCallId === "string" ? value.toolCallId : "",
				typeof value.toolName === "string" ? value.toolName : "tool",
				{ content: value.content, isError: value.isError },
			);
		}
	}
}

function fitCheckpoint(checkpoint: TimeoutCheckpoint, maxBytes: number): TimeoutCheckpoint {
	const copy: TimeoutCheckpoint = {
		...checkpoint,
		assistantNotes: [...checkpoint.assistantNotes],
		completedTools: checkpoint.completedTools.map((item) => ({ ...item })),
		changedFiles: [...checkpoint.changedFiles],
	};
	while (serializedBytes(copy) > maxBytes) {
		copy.truncated = true;
		if (copy.assistantNotes.length > 0) copy.assistantNotes.shift();
		else if (copy.completedTools.length > 0) copy.completedTools.shift();
		else if (copy.changedFiles.length > 0) copy.changedFiles.shift();
		else if (copy.partialOutput) {
			copy.partialOutput =
				shrinkCheckpointText(copy.partialOutput, Math.floor(maxBytes / 4), 128) || undefined;
		} else if (copy.task) {
			copy.task = shrinkCheckpointText(copy.task, Math.floor(maxBytes / 8), 64);
		} else break;
	}
	return copy;
}

function shrinkCheckpointText(
	value: string,
	preferredMaxBytes: number,
	minimumBytes: number,
): string {
	const currentBytes = Buffer.byteLength(value, "utf8");
	if (currentBytes <= minimumBytes) return "";
	const nextMaxBytes = Math.min(
		currentBytes - 1,
		preferredMaxBytes,
		Math.max(minimumBytes, Math.floor(currentBytes / 2)),
	);
	return truncateUtf8(value, nextMaxBytes).text;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedPrivate(value: string, maxBytes: number): string {
	return truncateUtf8(redactPrivateText(value).trim(), maxBytes).text;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((part) => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return [];
			const item = part as Record<string, unknown>;
			return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n");
}

function toolPath(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return boundedPrivate(value, 1024);
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
