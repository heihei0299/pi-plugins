import type { SubagentThinkingLevel } from "./agents/types.js";
import { readSubagentSettings, updateAgentSettingsPatch } from "./settings.js";

export const EXECUTION_PROFILES = ["fast", "balanced", "deep"] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

const PROFILE_AGENT_ORDER = [
	"scout",
	"planner",
	"reviewer",
	"worker",
	"general",
	"general-purpose",
] as const;

type ProfileAgent = (typeof PROFILE_AGENT_ORDER)[number];

export const EXECUTION_PROFILE_THINKING: Record<
	ExecutionProfile,
	Record<ProfileAgent, SubagentThinkingLevel>
> = {
	fast: {
		scout: "low",
		planner: "low",
		reviewer: "medium",
		worker: "low",
		general: "low",
		"general-purpose": "low",
	},
	balanced: {
		scout: "low",
		planner: "medium",
		reviewer: "medium",
		worker: "medium",
		general: "medium",
		"general-purpose": "medium",
	},
	deep: {
		scout: "medium",
		planner: "high",
		reviewer: "high",
		worker: "high",
		general: "high",
		"general-purpose": "high",
	},
};

export function executionProfileLabel(profile: ExecutionProfile): string {
	switch (profile) {
		case "fast":
			return "Fast";
		case "balanced":
			return "Balanced";
		case "deep":
			return "Deep";
	}
}

export function executionProfileDescription(profile: ExecutionProfile): string {
	switch (profile) {
		case "fast":
			return "Prefer low thinking for bounded work and medium for review.";
		case "balanced":
			return "Use low for scouting and medium for planning, review, and implementation.";
		case "deep":
			return "Use medium scouting and high thinking for planning, review, and implementation.";
	}
}

export function executionProfilePreview(profile: ExecutionProfile): string[] {
	const values = EXECUTION_PROFILE_THINKING[profile];
	return PROFILE_AGENT_ORDER.map((agent) => `${agent}: ${values[agent]}`);
}

export function inspectExecutionProfile(): ExecutionProfile | "custom" {
	const configured = readSubagentSettings()?.agents ?? {};
	for (const profile of EXECUTION_PROFILES) {
		const expected = EXECUTION_PROFILE_THINKING[profile];
		if (
			PROFILE_AGENT_ORDER.every((agent) => configured[agent]?.thinkingLevel === expected[agent])
		) {
			return profile;
		}
	}
	return "custom";
}

export function applyExecutionProfile(profile: ExecutionProfile): void {
	const values = EXECUTION_PROFILE_THINKING[profile];
	updateAgentSettingsPatch(
		Object.fromEntries(
			PROFILE_AGENT_ORDER.map((agent) => [agent, { thinkingLevel: values[agent] }]),
		),
	);
}
