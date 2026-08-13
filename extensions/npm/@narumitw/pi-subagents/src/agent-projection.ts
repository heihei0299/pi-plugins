import type { ManagedAgent } from "./registry.js";

export interface AgentProjectionLimits {
	maxAgents: number;
	maxDepth?: number;
}

/**
 * Select the newest restorable agent trees without orphaning child records.
 *
 * Complete ancestor chains are selected together, then returned in their original
 * order so persistence and restore behavior stay deterministic.
 */
export function projectAgentRecords(
	agents: readonly ManagedAgent[],
	limits: AgentProjectionLimits,
): ManagedAgent[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const selected = new Set<string>();
	const maxDepth = limits.maxDepth ?? Number.MAX_SAFE_INTEGER;
	const newestFirst = agents
		.map((agent, index) => ({ agent, index }))
		.sort(
			(left, right) => right.agent.updatedAt - left.agent.updatedAt || right.index - left.index,
		);

	for (const { agent } of newestFirst) {
		const chain = ancestorChain(agent, byId);
		if (!chain || chain.length - 1 > maxDepth) continue;
		const missing = chain.filter((candidate) => !selected.has(candidate.id));
		if (selected.size + missing.length > limits.maxAgents) continue;
		for (const candidate of missing) selected.add(candidate.id);
	}

	return agents.filter((agent) => selected.has(agent.id));
}

function ancestorChain(
	agent: ManagedAgent,
	byId: ReadonlyMap<string, ManagedAgent>,
): ManagedAgent[] | undefined {
	const chain: ManagedAgent[] = [];
	const seen = new Set<string>();
	let current: ManagedAgent | undefined = agent;
	while (current) {
		if (seen.has(current.id)) return undefined;
		seen.add(current.id);
		chain.unshift(current);
		if (!current.parentId) return chain;
		current = byId.get(current.parentId);
	}
	return undefined;
}
