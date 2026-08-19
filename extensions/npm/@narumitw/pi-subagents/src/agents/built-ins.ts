/**
 * Built-in agent definitions and prompt construction.
 */

import { type AgentCapabilityManifest, CAPABILITY_MANIFEST_VERSION } from "../capabilities.js";
import type { AgentConfig } from "./types.js";

export const BUILT_IN_AGENTS: AgentConfig[] = [
	{
		name: "explorer",
		description:
			"Read-only codebase exploration for specific questions; returns concise findings with paths and evidence.",
		tools: ["read", "grep", "find", "ls"],
		capabilityManifest: builtInManifest(["repository-search", "code-evidence"], "read", [
			"evidence-gathering",
		]),
		thinkingLevel: "low",
		source: "built-in",
		filePath: "built-in:explorer",
		systemPrompt: [
			"You are an explorer subagent. Explore the codebase for specific, well-scoped questions and report grounded findings.",
			"Do not edit files, run shell commands, or use any tool outside the read-only inspection set.",
			"Do not install dependencies, run formatters, start servers, run tests, or execute long-running commands.",
			"Return concise bullets with exact file paths, symbols, and open questions.",
		].join("\n"),
	},
	{
		name: "worker",
		description: "Bounded implementation and command-execution worker with clear ownership.",
		capabilityManifest: builtInManifest(
			["implementation", "command-execution", "repository-modification"],
			"write",
		),
		source: "built-in",
		filePath: "built-in:worker",
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
		"You are a focused worker subagent running in an isolated Pi child context.",
		"Complete only the bounded delegated implementation slice and respect its assigned file or responsibility ownership.",
		"Keep scope tight, avoid unrelated changes, and do not overwrite concurrent work outside your ownership.",
		"The main agent owns integration and final verification; report changed files, commands run, and remaining risks for that handoff.",
	].join("\n");
}
