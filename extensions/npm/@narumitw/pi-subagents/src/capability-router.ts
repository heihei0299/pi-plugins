import { type AgentConfig, resolveAgentToolNames } from "./agents/types.js";
import type { CapabilityHint } from "./capabilities.js";

export interface CapabilityRouteRequest {
	agent?: string;
	requiredCapabilities?: string[];
	requiredTools?: string[];
	requiredVerificationRole?: string;
	requiredSideEffectClass?: string;
	preferredCostHint?: CapabilityHint;
	preferredLatencyHint?: CapabilityHint;
}

export interface CapabilityRouteDecision {
	agent: AgentConfig;
	eligibleAgents: string[];
	requiredCapabilities: string[];
}

const HINT_RANK: Record<CapabilityHint, number> = { low: 0, medium: 1, high: 2 };

export function routeByCapability(
	agents: readonly AgentConfig[],
	request: CapabilityRouteRequest,
): CapabilityRouteDecision {
	const requiredCapabilities = unique(request.requiredCapabilities ?? []);
	const requiredTools = unique(request.requiredTools ?? []);
	const eligible = agents.filter((agent) => {
		const manifest = agent.capabilityManifest;
		const effectiveTools = resolveAgentToolNames(agent.tools);
		if (!manifest) {
			return (
				requiredCapabilities.length === 0 &&
				requiredTools.every((tool) => effectiveTools.includes(tool)) &&
				request.requiredVerificationRole === undefined &&
				request.requiredSideEffectClass === undefined
			);
		}
		const sideEffectAllowed =
			request.requiredSideEffectClass !== "read-only" ||
			manifest.authority?.filesystem === "read" ||
			manifest.authority?.filesystem === "none";
		return (
			requiredCapabilities.every((capability) => manifest.capabilities.includes(capability)) &&
			requiredTools.every((tool) => effectiveTools.includes(tool)) &&
			(!request.requiredVerificationRole ||
				manifest.verificationRoles.includes(request.requiredVerificationRole)) &&
			sideEffectAllowed
		);
	});
	if (request.agent) {
		const named = agents.find((agent) => agent.name === request.agent);
		if (!named) throw new Error(`Unknown subagent ${request.agent}`);
		if (!eligible.includes(named)) {
			throw new Error(
				`Selected subagent ${request.agent} does not satisfy the required capability manifest`,
			);
		}
		return {
			agent: named,
			eligibleAgents: eligible.map((agent) => agent.name).sort(),
			requiredCapabilities,
		};
	}
	if (eligible.length === 0) {
		throw new Error(
			`No capable agent satisfies: ${
				[...requiredCapabilities, ...requiredTools.map((tool) => `tool:${tool}`)].join(", ") ||
				"the requested side-effect class"
			}`,
		);
	}
	const ranked = [...eligible].sort((left, right) => {
		const leftCost = hintDistance(
			left.capabilityManifest?.costHint ?? "medium",
			request.preferredCostHint,
		);
		const rightCost = hintDistance(
			right.capabilityManifest?.costHint ?? "medium",
			request.preferredCostHint,
		);
		const leftLatency = hintDistance(
			left.capabilityManifest?.latencyHint ?? "medium",
			request.preferredLatencyHint,
		);
		const rightLatency = hintDistance(
			right.capabilityManifest?.latencyHint ?? "medium",
			request.preferredLatencyHint,
		);
		return (
			leftCost - rightCost || leftLatency - rightLatency || left.name.localeCompare(right.name)
		);
	});
	return {
		agent: ranked[0],
		eligibleAgents: ranked.map((agent) => agent.name),
		requiredCapabilities,
	};
}

function hintDistance(actual: CapabilityHint, preferred: CapabilityHint | undefined): number {
	return preferred ? Math.abs(HINT_RANK[actual] - HINT_RANK[preferred]) : HINT_RANK[actual];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
