export const FALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

export function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveDefaultSubagentTimeoutMs(): number {
	return parsePositiveInteger(process.env.PI_SUBAGENT_TIMEOUT_MS) ?? FALLBACK_TIMEOUT_MS;
}

export function assertSubagentDepthAllowed(): void {
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const maxDepth = parsePositiveInteger(process.env.PI_SUBAGENT_MAX_DEPTH) ?? 1;
	if (depth >= maxDepth) {
		throw new Error(`Subagent recursion depth limit reached (${maxDepth})`);
	}
}
