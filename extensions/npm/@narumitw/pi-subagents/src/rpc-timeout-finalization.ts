import { DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";
import type { SubagentResultFormat } from "./result-contract.js";
import type { TimeoutCheckpoint, TurnTerminationReason } from "./timeout-checkpoint.js";
import {
	buildTimeoutFinalizationPrompt,
	resolveTimeoutFinalizationMs,
} from "./timeout-finalization.js";

interface RpcTimeoutFinalizationClient {
	prompt(message: string, timeoutMs?: number): Promise<void>;
	abort(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
}

interface RpcSummaryCapture {
	output: string;
	partial: string;
	stopReason?: string;
	error?: string;
}

export interface RpcTimeoutFinalizationOptions {
	client: RpcTimeoutFinalizationClient;
	task: string;
	partialOutput: string;
	checkpoint?: TimeoutCheckpoint;
	terminationReason?: TurnTerminationReason;
	resultFormat?: SubagentResultFormat;
	signal: AbortSignal;
	workTimeoutMs: number;
	finalizationTimeoutMs?: number;
	abortGraceMs: number;
	resetCapture(): void;
	getCapture(): RpcSummaryCapture;
	release(): Promise<void>;
}

export interface RpcTimeoutFinalizationResult {
	output: string;
	truncated: boolean;
	status: "completed" | "failed" | "timed_out";
	error?: string;
}

export async function finalizeTimedOutRpcTurn(
	options: RpcTimeoutFinalizationOptions,
): Promise<RpcTimeoutFinalizationResult> {
	options.resetCapture();
	let settleResolve!: () => void;
	let settleReject!: (error: Error) => void;
	const settled = new Promise<void>((resolve, reject) => {
		settleResolve = resolve;
		settleReject = reject;
	});
	void settled.catch(() => undefined);
	const unsubscribeEvent = options.client.onEvent((event) => {
		if (eventType(event) === "agent_settled") settleResolve();
	});
	const unsubscribeClose = options.client.onClose(settleReject);
	let error: string | undefined;
	try {
		const finalizationMs = resolveTimeoutFinalizationMs(
			options.workTimeoutMs,
			options.finalizationTimeoutMs,
		);
		const deadline = Date.now() + finalizationMs;
		await raceWithAbort(
			() =>
				options.client.prompt(
					buildTimeoutFinalizationPrompt({
						task: options.task,
						partialOutput: options.partialOutput,
						checkpoint: options.checkpoint,
						terminationReason: options.terminationReason,
						resultFormat: options.resultFormat,
					}),
					remainingMs(deadline),
				),
			options.signal,
			remainingMs(deadline),
		);
		const settlement = await waitForSettlement(settled, options.signal, remainingMs(deadline));
		if (settlement !== "settled") {
			const [abortCompleted, stopped] = await Promise.all([
				settlesWithin(options.client.abort(), options.abortGraceMs),
				settlesWithin(settled, options.abortGraceMs),
			]);
			if (!stopped) await boundedRelease(options);
			error = [
				`timeout summary ${settlement}`,
				abortCompleted ? undefined : "summary abort command did not settle",
			]
				.filter(Boolean)
				.join("; ");
		}
	} catch (caught) {
		error = boundedError(caught);
		await boundedRelease(options);
	} finally {
		unsubscribeEvent();
		unsubscribeClose();
	}
	const capture = options.getCapture();
	const output = truncateUtf8(capture.output || capture.partial, DEFAULT_MAX_OUTPUT_BYTES);
	if (!error && (capture.stopReason === "error" || !output.text.trim())) {
		error = capture.error || "Timeout summary produced no final text";
	}
	return {
		output: output.text,
		truncated: output.truncated,
		status: error ? (/timed out|timeout/iu.test(error) ? "timed_out" : "failed") : "completed",
		error,
	};
}

function eventType(value: unknown): string | undefined {
	return value &&
		typeof value === "object" &&
		typeof (value as { type?: unknown }).type === "string"
		? ((value as { type: string }).type ?? undefined)
		: undefined;
}

function remainingMs(deadline: number): number {
	return Math.max(1, deadline - Date.now());
}

async function raceWithAbort<T>(
	start: () => Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<T> {
	if (signal.aborted) throw abortError();
	let onAbort: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	const timedOut = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("RPC timeout summary prompt timed out")), timeoutMs);
	});
	try {
		return await Promise.race([start(), aborted, timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function waitForSettlement(
	settled: Promise<void>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<"settled" | "aborted" | "timeout"> {
	if (signal.aborted) return "aborted";
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			settled.then(() => "settled" as const),
			new Promise<"aborted">((resolve) => {
				onAbort = () => resolve("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
			}),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function boundedRelease(options: RpcTimeoutFinalizationOptions): Promise<boolean> {
	return settlesWithin(options.release(), options.abortGraceMs + 1_000);
}

async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			settled.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function abortError(): Error {
	const error = new Error("RPC timeout summary aborted");
	error.name = "AbortError";
	return error;
}

function boundedError(error: unknown): string {
	return truncateUtf8(error instanceof Error ? error.message : String(error), 16 * 1024).text;
}
