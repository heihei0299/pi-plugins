import type { SubagentThinkingLevel } from "./agents/types.js";
import { safeLine } from "./render-common.js";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinkingLevel?: SubagentThinkingLevel,
	actualProvider?: string,
	actualModel?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	const safeProvider = actualProvider ? safeLine(actualProvider, "", 256) : undefined;
	const safeModel = actualModel ? safeLine(actualModel, "", 256) : undefined;
	const actual =
		safeProvider && safeModel ? `${safeProvider}/${safeModel}` : (safeModel ?? safeProvider);
	if (actual ?? model) parts.push(actual ?? safeLine(model, "", 256));
	if (thinkingLevel) parts.push(`requested-thinking:${safeLine(thinkingLevel, "", 128)}`);
	return parts.join(" ");
}
