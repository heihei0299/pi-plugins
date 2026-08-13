import type { Message } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import type { SingleResult } from "./runner.js";
import { formatTimeoutCheckpoint } from "./timeout-checkpoint.js";

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			const text = msg.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

export function getResultFinalOutput(result: SingleResult): string {
	return result.finalOutput ?? getFinalOutput(result.messages);
}

export function isResultError(result: SingleResult): boolean {
	return (
		(result.exitCode !== 0 && result.exitCode !== -1) ||
		result.timedOut === true ||
		result.stopReason === "timeout" ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

export function formatResultFailure(result: SingleResult): string {
	const error = result.errorMessage || result.stderr.trim();
	const output = getResultFinalOutput(result);
	const sections = [error];
	if (result.timeoutSummary) sections.push(`Timed-out work summary:\n${result.timeoutSummary}`);
	else if (output) sections.push(`Partial output:\n${output}`);
	if (result.partialOutput && result.partialOutput !== output) {
		sections.push(`Partial output before finalization:\n${result.partialOutput}`);
	}
	if (result.termination && !result.timeoutSummary) {
		sections.push(
			`Termination checkpoint:\n${formatTimeoutCheckpoint(result.termination.checkpoint)}`,
		);
	}
	if (result.timeoutSummaryError) {
		sections.push(`Summary finalization failed: ${result.timeoutSummaryError}`);
	}
	return truncateUtf8(
		sections.filter(Boolean).join("\n\n") || "(no output)",
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
}
