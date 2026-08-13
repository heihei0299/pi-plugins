import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { appendResultInstruction, type SubagentResultFormat } from "./result-contract.js";
import type { RecentActivityItem } from "./runner.js";
import {
	formatTimeoutCheckpoint,
	type TimeoutCheckpoint,
	type TurnTerminationReason,
} from "./timeout-checkpoint.js";

export const DEFAULT_TIMEOUT_FINALIZATION_MS = 45_000;

export interface TimeoutFinalizationEvidence {
	task: string;
	partialOutput?: string;
	recentActivity?: readonly RecentActivityItem[];
	checkpoint?: TimeoutCheckpoint;
	terminationReason?: TurnTerminationReason;
	resultFormat?: SubagentResultFormat;
}

export function resolveTimeoutFinalizationMs(workTimeoutMs: number, override?: number): number {
	const requested = override ?? Math.min(workTimeoutMs, DEFAULT_TIMEOUT_FINALIZATION_MS);
	if (!Number.isFinite(requested) || requested < 1) {
		throw new Error("Timeout finalization deadline must be a positive finite number");
	}
	return Math.min(Math.floor(requested), DEFAULT_TIMEOUT_FINALIZATION_MS);
}

export function buildTimeoutFinalizationPrompt(
	evidence: TimeoutFinalizationEvidence,
	maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
): string {
	const activity = (evidence.recentActivity ?? [])
		.slice(-10)
		.map((item) =>
			item.type === "text"
				? `- Assistant note: ${redactPrivateText(item.text)}`
				: `- Tool activity: ${redactPrivateText(item.name)}`,
		)
		.join("\n");
	const prompt = [
		terminationHeading(evidence.terminationReason),
		"Do not continue investigating, call tools, modify files, or retry the original task.",
		"Return a concise summary of only verified findings and completed evidence already available.",
		"Explicitly label unfinished or unverified areas.",
		`Original task:\n${redactPrivateText(evidence.task)}`,
		evidence.partialOutput
			? `Partial assistant output:\n${redactPrivateText(evidence.partialOutput)}`
			: "Partial assistant output: (none)",
		evidence.checkpoint
			? `Deterministic progress checkpoint:\n${formatTimeoutCheckpoint(evidence.checkpoint)}`
			: undefined,
		activity ? `Recent bounded activity:\n${activity}` : "Recent bounded activity: (none)",
	]
		.filter((value): value is string => Boolean(value))
		.join("\n\n");
	return truncateUtf8(appendResultInstruction(prompt, evidence.resultFormat, maxBytes), maxBytes)
		.text;
}

function terminationHeading(reason: TurnTerminationReason | undefined): string {
	switch (reason) {
		case "idle_timeout":
			return "The idle deadline expired and the active work was aborted.";
		case "turn_limit":
			return "The assistant-turn budget was exhausted and the active work was aborted.";
		case "tool_call_limit":
			return "The tool-call budget was exhausted and the active work was aborted.";
		case "orchestration_timeout":
			return "The orchestration deadline expired and the active work was aborted.";
		default:
			return "Work deadline expired and the active work was aborted.";
	}
}
