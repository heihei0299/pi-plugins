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
	inFlightUsage?: TransportUsage;
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

export function captureRpcEvent(event: unknown, capture: RpcTurnCapture): boolean {
	if (!isRecord(event)) return false;
	const previousUsage = snapshotRpcUsage(capture);
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
	if (event.type === "message_start" && isRecord(event.message)) {
		if (event.message.role === "assistant") commitRpcInFlightUsage(capture);
	}
	if (event.type === "message_update") {
		const usage = normalizeUsage(event.usage);
		if (usage) capture.inFlightUsage = usage;
		const delta = event.assistantMessageEvent;
		if (isRecord(delta) && delta.type === "text_delta" && typeof delta.delta === "string") {
			capture.partial = truncateUtf8(
				`${capture.partial}${delta.delta}`,
				DEFAULT_MAX_OUTPUT_BYTES,
			).text;
		}
	}
	if (event.type === "message_end" && isRecord(event.message)) {
		const candidate = event.message;
		if (candidate.role !== "toolResult") journalMessages(capture.journal, [candidate]);
		if (candidate.role === "assistant") captureAssistantEnd(candidate, capture);
	}
	return !sameUsage(previousUsage, snapshotRpcUsage(capture));
}

export function snapshotRpcUsage(capture: RpcTurnCapture): TransportUsage {
	const usage = { ...capture.usage };
	if (capture.inFlightUsage) addUsage(usage, capture.inFlightUsage);
	return usage;
}

export function commitRpcInFlightUsage(capture: RpcTurnCapture): boolean {
	if (!capture.inFlightUsage) return false;
	addUsage(capture.usage, capture.inFlightUsage);
	capture.inFlightUsage = undefined;
	return true;
}

function captureAssistantEnd(candidate: Record<string, unknown>, capture: RpcTurnCapture): void {
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
	const finalUsage = normalizeUsage(candidate.usage);
	const completedUsage = finalUsage ?? capture.inFlightUsage;
	if (completedUsage) addUsage(capture.usage, completedUsage);
	capture.inFlightUsage = undefined;
	capture.usage.turns = addUsageValue(capture.usage.turns, 1);
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

function normalizeUsage(value: unknown): TransportUsage | undefined {
	if (!isRecord(value)) return undefined;
	const input = safeNonNegative(value.input);
	const output = safeNonNegative(value.output);
	const cacheRead = safeNonNegative(value.cacheRead);
	const cacheWrite = safeNonNegative(value.cacheWrite);
	const reportedTotal = safeNonNegative(value.totalTokens);
	const cost = isRecord(value.cost) ? safeNonNegative(value.cost.total) : undefined;
	if (
		input === undefined &&
		output === undefined &&
		cacheRead === undefined &&
		cacheWrite === undefined &&
		reportedTotal === undefined &&
		cost === undefined
	) {
		return undefined;
	}
	const components = [input, output, cacheRead, cacheWrite].reduce<number>(
		(total, current) => addUsageValue(total, current ?? 0),
		0,
	);
	return {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead: cacheRead ?? 0,
		cacheWrite: cacheWrite ?? 0,
		totalTokens: reportedTotal ?? components,
		cost: cost ?? 0,
		turns: 0,
	};
}

function addUsage(target: TransportUsage, value: TransportUsage): void {
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"cost",
		"turns",
	] as const) {
		target[key] = addUsageValue(target[key], value[key]);
	}
}

function addUsageValue(current: number, addition: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, current + addition);
}

function safeNonNegative(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
		? value
		: undefined;
}

function sameUsage(left: TransportUsage, right: TransportUsage): boolean {
	return (
		left.input === right.input &&
		left.output === right.output &&
		left.cacheRead === right.cacheRead &&
		left.cacheWrite === right.cacheWrite &&
		left.totalTokens === right.totalTokens &&
		left.cost === right.cost &&
		left.turns === right.turns
	);
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
