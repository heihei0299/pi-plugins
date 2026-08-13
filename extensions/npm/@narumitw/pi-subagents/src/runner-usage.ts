export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costInput?: number;
	costOutput?: number;
	costCacheRead?: number;
	costCacheWrite?: number;
	totalTokens?: number;
	contextTokens: number;
	turns: number;
}

const MAX_USAGE_VALUE = Number.MAX_SAFE_INTEGER;

export function protocolUsageCount(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function protocolUsageCost(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, MAX_USAGE_VALUE)
		: 0;
}

export function addUsageValue(current: number, addition: number): number {
	return Math.min(MAX_USAGE_VALUE, current + addition);
}

export function mergeUsageStats(target: UsageStats, addition: UsageStats): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
		target[key] = addUsageValue(target[key], addition[key]);
	}
	for (const key of [
		"costInput",
		"costOutput",
		"costCacheRead",
		"costCacheWrite",
		"totalTokens",
	] as const) {
		if (addition[key] !== undefined) {
			target[key] = addUsageValue(target[key] ?? 0, addition[key]);
		}
	}
	target.contextTokens = addition.contextTokens || target.contextTokens;
}
