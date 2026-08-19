import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents/discovery.js";
import type { AgentScope, SubagentSettings } from "./agents/types.js";
import { safeTerminalLine } from "./safe-text.js";
import { readSubagentSettings } from "./settings.js";

export function isWriteCapable(tools: string[] | undefined): boolean {
	if (!tools) return true;
	return tools.some((tool) => ["bash", "write", "edit"].includes(tool));
}

export async function confirmProjectAgent(
	name: string,
	scope: AgentScope,
	confirm: boolean,
	ctx: ExtensionContext,
	cwd: string,
	settings?: SubagentSettings,
): Promise<void> {
	if (scope !== "project" && scope !== "both") return;
	if (!isSameCwd(cwd, ctx.cwd)) {
		throw new Error("Project-local subagent definitions cannot run with an overridden cwd");
	}
	if (!ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	const discovery = discoverAgents(cwd, scope, settings ?? readSubagentSettings());
	const agent = discovery.agents.find((candidate) => candidate.name === name);
	if (agent?.source !== "project") return;
	if (confirm && ctx.hasUI) {
		const approved = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${safeTerminalLine(name, 256)}\nSource: ${safeTerminalLine(agent.filePath)}`,
		);
		if (!approved) throw new Error("Project-local subagent was not approved");
	}
}

function isSameCwd(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return path.resolve(left) === path.resolve(right);
	}
}
