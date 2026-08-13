import { DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";
import { boundedPrivateText } from "./safe-text.js";
import { journalMessages, TimeoutProgressJournal } from "./timeout-checkpoint.js";
import { emptyTransportUsage, type TransportUsage } from "./transport-types.js";
import type { TurnBudgetMonitor } from "./turn-budget.js";

export interface RpcTurnCapture {
	output: string;
	partial: string;
	stopReason?: string;
	error?: string;
	provider?: string;
	model?: string;
	usage: TransportUsage;
	firstActivityAt?: number;
	journal: TimeoutProgressJournal;
}

export function createRpcTurnCapture(): RpcTurnCapture {
	return {
		output: "",
		partial: "",
		usage: emptyTransportUsage(),
		journal: new TimeoutProgressJournal(),
	};
}

export function captureRpcEvent(event: unknown, capture: RpcTurnCapture): void {
	if (!isRecord(event)) return;
	if (event.type === "tool_execution_start") {
		capture.journal.recordToolCall(
			typeof event.toolCallId === "string" ? event.toolCallId : "",
			typeof event.toolName === "string" ? event.toolName : "tool",
			isRecord(event.args) ? event.args : {},
		);
	}
	if (event.type === "tool_execution_end") {
		const result = isRecord(event.result) ? event.result : {};
		capture.journal.recordToolResult(
			typeof event.toolCallId === "string" ? event.toolCallId : "",
			typeof event.toolName === "string" ? event.toolName : "tool",
			{ content: result.content, isError: event.isError },
		);
	}
	if (event.type === "message_update") {
		const delta = event.assistantMessageEvent;
		if (isRecord(delta) && delta.type === "text_delta" && typeof delta.delta === "string") {
			capture.partial = truncateUtf8(
				`${capture.partial}${delta.delta}`,
				DEFAULT_MAX_OUTPUT_BYTES,
			).text;
		}
	}
	if (event.type !== "message_end" || !isRecord(event.message)) return;
	const candidate = event.message;
	if (candidate.role !== "toolResult") journalMessages(capture.journal, [candidate]);
	if (candidate.role !== "assistant") return;
	capture.output = truncateUtf8(
		assistantText(candidate.content) || capture.partial,
		DEFAULT_MAX_OUTPUT_BYTES,
	).text;
	capture.partial = capture.output;
	capture.stopReason = typeof candidate.stopReason === "string" ? candidate.stopReason : undefined;
	capture.error =
		typeof candidate.errorMessage === "string"
			? boundedPrivateText(candidate.errorMessage, 4 * 1024)
			: undefined;
	capture.provider =
		typeof candidate.provider === "string"
			? boundedPrivateText(candidate.provider, 256)
			: undefined;
	const responseModel =
		typeof candidate.responseModel === "string"
			? candidate.responseModel
			: typeof candidate.model === "string"
				? candidate.model
				: undefined;
	capture.model = responseModel ? boundedPrivateText(responseModel, 256) : undefined;
	capture.usage.turns++;
	addUsage(capture.usage, candidate.usage);
}

export function observeRpcBudgetEvent(event: unknown, monitor: TurnBudgetMonitor): void {
	if (!isRecord(event)) return;
	if (event.type === "tool_execution_end") monitor.recordActivity();
	if (event.type !== "message_end" || !isRecord(event.message)) return;
	const message = event.message;
	if (message.role === "toolResult") {
		monitor.recordActivity();
		return;
	}
	if (message.role !== "assistant") return;
	monitor.recordToolCalls(assistantToolCallCount(message.content));
	monitor.recordAssistantTurn(
		typeof message.stopReason === "string" ? message.stopReason : undefined,
	);
}

function assistantToolCallCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => isRecord(part) && part.type === "toolCall").length;
}

function addUsage(target: TransportUsage, value: unknown): void {
	if (!isRecord(value)) return;
	target.input += safeNonNegative(value.input);
	target.output += safeNonNegative(value.output);
	target.cacheRead += safeNonNegative(value.cacheRead);
	target.cacheWrite += safeNonNegative(value.cacheWrite);
	const reportedTotal = safeNonNegative(value.totalTokens);
	target.totalTokens +=
		reportedTotal ||
		safeNonNegative(value.input) +
			safeNonNegative(value.output) +
			safeNonNegative(value.cacheRead) +
			safeNonNegative(value.cacheWrite);
	if (isRecord(value.cost)) target.cost += safeNonNegative(value.cost.total);
}

function safeNonNegative(value: unknown): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
		? value
		: 0;
}

function assistantText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((part) => {
			if (!isRecord(part)) return [];
			return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
		})
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
