import { isResultError, type SingleResult } from "./runner.js";

const HEDGE_LOSER_GRACE_MS = 5_000;

export async function runHedgedAttempt(
	run: (signal: AbortSignal | undefined) => Promise<SingleResult>,
	parentSignal: AbortSignal | undefined,
	hedgeAfterMs: number | undefined,
	loserGraceMs = HEDGE_LOSER_GRACE_MS,
): Promise<{ result: SingleResult; hedged: boolean }> {
	if (hedgeAfterMs === undefined) return { result: await run(parentSignal), hedged: false };
	const primaryLink = linkedAbortController(parentSignal);
	const hedgeLink = linkedAbortController(parentSignal);
	const primaryController = primaryLink.controller;
	const hedgeController = hedgeLink.controller;
	let hedgeStarted = false;
	let hedgePromise: Promise<SingleResult> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const primaryPromise = run(primaryController.signal);
	const primaryTagged = primaryPromise.then((result) => ({ source: "primary" as const, result }));
	const delayedHedge = new Promise<{ source: "hedge"; result: SingleResult }>((resolve, reject) => {
		timer = setTimeout(() => {
			hedgeStarted = true;
			hedgePromise = run(hedgeController.signal);
			hedgePromise.then((result) => resolve({ source: "hedge", result }), reject);
		}, hedgeAfterMs);
	});
	try {
		const first = await Promise.race([primaryTagged, delayedHedge]);
		if (!isResultError(first.result) || !hedgeStarted || !hedgePromise) {
			return { result: first.result, hedged: hedgeStarted };
		}
		const other = first.source === "primary" ? await hedgePromise : await primaryPromise;
		return {
			result: isResultError(other) ? first.result : other,
			hedged: true,
		};
	} finally {
		if (timer) clearTimeout(timer);
		primaryController.abort();
		hedgeController.abort();
		primaryLink.dispose();
		hedgeLink.dispose();
		await settleWithin(
			[primaryPromise, hedgePromise].filter(
				(value): value is Promise<SingleResult> => value !== undefined,
			),
			loserGraceMs,
		);
	}
}

export function isRetryableResult(result: SingleResult): boolean {
	if (!isResultError(result)) return false;
	if (result.outcome) return result.outcome.retryable;
	return result.aborted === true || result.exitCode !== 0;
}

export async function supervisionDelay(
	milliseconds: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (milliseconds <= 0 || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		timer = setTimeout(finish, milliseconds);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(promises),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function linkedAbortController(parentSignal: AbortSignal | undefined): {
	controller: AbortController;
	dispose(): void;
} {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (parentSignal?.aborted) controller.abort();
	else parentSignal?.addEventListener("abort", abort, { once: true });
	return {
		controller,
		dispose: () => parentSignal?.removeEventListener("abort", abort),
	};
}
