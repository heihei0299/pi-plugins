/**
 * Built-in agent definitions and prompt construction.
 */

import { type AgentCapabilityManifest, CAPABILITY_MANIFEST_VERSION } from "../capabilities.js";
import type { AgentConfig } from "./types.js";

export const BUILT_IN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description:
			"Read-only codebase reconnaissance; returns concise findings with paths and evidence.",
		tools: ["read", "grep", "find", "ls", "bash"],
		capabilityManifest: builtInManifest(["repository-search", "code-evidence"], "read", [
			"evidence-gathering",
		]),
		source: "built-in",
		filePath: "built-in:scout",
		systemPrompt: [
			"You are a scout subagent. Explore the codebase quickly and report grounded findings.",
			"Do not edit files. Prefer read, grep, find, ls, and safe bash inspection commands.",
			"Return concise bullets with exact file paths, symbols, and open questions.",
		].join("\n"),
	},
	{
		name: "planner",
		description: "Turns reconnaissance into a lean implementation or migration plan.",
		tools: ["read", "grep", "find", "ls"],
		capabilityManifest: builtInManifest(
			["task-decomposition", "implementation-planning", "migration-planning"],
			"read",
		),
		source: "built-in",
		filePath: "built-in:planner",
		systemPrompt: [
			"You are a planner subagent. Produce executable, verifiable plans only.",
			"Do not modify files. Ground the plan in the repository's actual structure.",
			"Call out assumptions, risks, sequencing, and verification commands.",
		].join("\n"),
	},
	{
		name: "reviewer",
		description: "Independent code review agent that inspects existing verification evidence.",
		tools: ["read", "grep", "find", "ls", "bash"],
		capabilityManifest: builtInManifest(
			["code-review", "evidence-review", "security-baseline"],
			"read",
			["independent-review"],
		),
		source: "built-in",
		filePath: "built-in:reviewer",
		systemPrompt: [
			"You are a reviewer subagent. Review changes adversarially and assess claims against the code and existing evidence.",
			"Do not edit files or run tests, builds, benchmarks, formatters, or other long-running verification commands.",
			"Inspect code, diffs, test definitions, and existing verification evidence. Recommend any additional commands for the main agent to run.",
			"Report PASS, FAIL, or PARTIAL with evidence, commands inspected, and specific follow-ups.",
		].join("\n"),
	},
	{
		name: "worker",
		description: "General-purpose implementation worker with the default Pi tool set.",
		capabilityManifest: builtInManifest(
			["implementation", "command-execution", "repository-modification"],
			"write",
		),
		source: "built-in",
		filePath: "built-in:worker",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general",
		description: "Alias for worker; kept for model-generated subagent names.",
		capabilityManifest: builtInManifest(
			["implementation", "command-execution", "repository-modification"],
			"write",
		),
		source: "built-in",
		filePath: "built-in:general",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general-purpose",
		description: "Alias for worker; compatible with common subagent naming conventions.",
		capabilityManifest: builtInManifest(
			["implementation", "command-execution", "repository-modification"],
			"write",
		),
		source: "built-in",
		filePath: "built-in:general-purpose",
		systemPrompt: workerSystemPrompt(),
	},
];

export function getBuiltInAgent(name: string): AgentConfig | undefined {
	const agent = BUILT_IN_AGENTS.find((candidate) => candidate.name === name);
	return agent ? structuredClone(agent) : undefined;
}

function builtInManifest(
	capabilities: string[],
	filesystem: "read" | "write",
	verificationRoles: string[] = [],
): AgentCapabilityManifest {
	return {
		version: CAPABILITY_MANIFEST_VERSION,
		capabilities,
		modalities: ["text"],
		resultFormats: ["text", "structured-v1", "structured-v2"],
		authority: { filesystem },
		verificationRoles,
		contextStrengths: ["repository"],
		costHint: filesystem === "read" ? "low" : "medium",
		latencyHint: filesystem === "read" ? "low" : "medium",
		limitations: [],
	};
}

function workerSystemPrompt(): string {
	return [
		"You are a focused worker subagent running in an isolated Pi process.",
		"Complete the delegated task directly. Keep scope tight and avoid unrelated changes.",
		"When done, summarize files changed, commands run, and any remaining risks.",
	].join("\n");
}
