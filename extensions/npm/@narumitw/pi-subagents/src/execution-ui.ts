import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, SubagentThinkingLevel } from "./agents/types.js";
import {
	applyExecutionProfile,
	EXECUTION_PROFILES,
	type ExecutionProfile,
	executionProfileDescription,
	executionProfileLabel,
	executionProfilePreview,
	inspectExecutionProfile,
} from "./execution-profiles.js";
import { MAX_SUBAGENT_TIMEOUT_MS } from "./limits.js";
import { safeTerminalLine as safeTerminalText } from "./safe-text.js";
import { readSubagentSettings, updateAgentSettingsPatch } from "./settings.js";

export function executionProfileScreen() {
	const current = inspectExecutionProfile();
	return {
		kind: "actions" as const,
		title: "Execution Profiles",
		lines: [
			`Current built-in mapping: ${current === "custom" ? "Custom or inherited" : executionProfileLabel(current)}`,
			"Profiles change only built-in agent thinking defaults.",
			"Models, timeouts, tools, transport, context, and explicit tool-call values are preserved.",
		],
		items: [
			...EXECUTION_PROFILES.map((profile) => ({
				id: profile,
				label: executionProfileLabel(profile),
				description: executionProfileDescription(profile),
				action: "apply-execution-profile" as const,
			})),
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export async function applyExecutionProfileFromUi(
	profileValue: string,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
	isCurrent: () => boolean,
) {
	if (!EXECUTION_PROFILES.includes(profileValue as ExecutionProfile)) {
		return { kind: "rejected" as const };
	}
	const profile = profileValue as ExecutionProfile;
	const before = executionSettingsFingerprint();
	const confirmed = await ctx.ui.confirm(
		`Apply ${executionProfileLabel(profile)} profile?`,
		[
			executionProfileDescription(profile),
			...executionProfilePreview(profile),
			"Existing model, timeout, and tool overrides remain unchanged.",
		].join("\n"),
		{ signal },
	);
	if (signal.aborted || !isCurrent()) return { kind: "close" as const };
	if (!confirmed) return { kind: "rejected" as const };
	if (before !== executionSettingsFingerprint()) {
		ctx.ui.notify("Agent execution settings changed while confirming; review again.", "warning");
		return { kind: "rejected" as const };
	}
	try {
		applyExecutionProfile(profile);
		ctx.ui.notify(`Applied ${executionProfileLabel(profile)} profile.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Execution profile was not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

export function executionAgentPickerScreen(agents: readonly AgentConfig[]) {
	const configured = readSubagentSettings()?.agents ?? {};
	return {
		kind: "actions" as const,
		title: "Agent Execution Defaults",
		lines: ["Choose an agent to edit its inherited model, thinking, or timeout."],
		items: [
			...agents.map((agent) => {
				const value = configured[agent.name];
				return {
					id: agent.name,
					label: safeTerminalText(agent.name),
					description: safeTerminalText(
						`${agent.source} · model ${value?.model ?? agent.model ?? "inherited"} · thinking ${value?.thinkingLevel ?? agent.thinkingLevel ?? "inherited"} · timeout ${value?.timeoutMs ?? agent.timeoutMs ?? "inherited"}`,
					),
					action: "pick-execution-agent" as const,
				};
			}),
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export function executionAgentScreen(agent: AgentConfig | undefined) {
	if (!agent) {
		return {
			kind: "actions" as const,
			title: "Agent Execution Defaults",
			lines: ["No agent selected."],
			items: [{ id: "back", label: "Back", action: "back" as const }],
			hint: "back" as const,
		};
	}
	const configured = readSubagentSettings()?.agents?.[agent.name];
	return {
		kind: "actions" as const,
		title: `${safeTerminalText(agent.name)} execution`,
		lines: [
			`Model: ${safeTerminalText(configured?.model ?? agent.model ?? "inherited")}`,
			`Thinking: ${configured?.thinkingLevel ?? agent.thinkingLevel ?? "inherited"}`,
			`Timeout: ${configured?.timeoutMs ?? agent.timeoutMs ?? "inherited"}`,
			"Explicit tool-call values remain authoritative.",
		],
		items: [
			{ id: "thinking", label: "Thinking level", to: "execution-thinking" as const },
			{ id: "model", label: "Model", to: "execution-model" as const },
			{ id: "timeout", label: "Timeout", to: "execution-timeout" as const },
			{
				id: "reset",
				label: "Reset execution defaults",
				description: "Restore frontmatter or Pi inheritance without changing tools",
				action: "reset-agent-execution" as const,
			},
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export function executionThinkingScreen(agent: AgentConfig | undefined) {
	const configured = agent ? readSubagentSettings()?.agents?.[agent.name] : undefined;
	return {
		kind: "settings" as const,
		title: agent ? `${safeTerminalText(agent.name)} thinking` : "Agent thinking",
		items: agent
			? [
					{
						id: "thinking",
						label: "Default thinking level",
						description: "Explicit spawn or blocking call values still win.",
						currentValue: configured?.thinkingLevel ?? agent.thinkingLevel ?? "Inherited",
						values: ["Inherited", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
						action: "set-agent-thinking" as const,
					},
				]
			: [],
		hint: "back" as const,
	};
}

export function executionModelScreen(agent: AgentConfig | undefined, ctx: ExtensionCommandContext) {
	const configured = agent ? readSubagentSettings()?.agents?.[agent.name] : undefined;
	const models = ctx.modelRegistry
		.getAvailable()
		.map((model) => `${model.provider}/${model.id}`)
		.sort((left, right) => left.localeCompare(right))
		.slice(0, 100);
	return {
		kind: "actions" as const,
		title: agent ? `${safeTerminalText(agent.name)} model` : "Agent model",
		lines: [
			`Current: ${safeTerminalText(configured?.model ?? agent?.model ?? "inherited")}`,
			"Choose a session-available model or enter a custom Pi model pattern.",
		],
		items: agent
			? [
					{
						id: "model:__inherited__",
						label: "Inherited",
						description: "Use frontmatter or active Pi model resolution",
						action: "set-agent-model" as const,
					},
					...models.map((model) => ({
						id: `model:${model}`,
						label: safeTerminalText(model),
						action: "set-agent-model" as const,
					})),
					{
						id: "custom",
						label: "Custom model pattern",
						description: "Enter provider/model, a model pattern, or an optional :thinking suffix",
						to: "execution-model-input" as const,
					},
					{ id: "back", label: "Back", action: "back" as const },
				]
			: [],
		hint: "back" as const,
	};
}

export function executionModelInputScreen(agent: AgentConfig | undefined) {
	const configured = agent ? readSubagentSettings()?.agents?.[agent.name] : undefined;
	return {
		kind: "input" as const,
		title: agent ? `${safeTerminalText(agent.name)} model` : "Agent model",
		lines: [
			`Current: ${safeTerminalText(configured?.model ?? agent?.model ?? "inherited")}`,
			"Enter a Pi CLI model pattern, including an optional :thinking suffix.",
			"Use Reset execution defaults to restore inheritance.",
		],
		placeholder: "provider/model or model pattern",
		action: "set-agent-model" as const,
		hint: "back" as const,
	};
}

export function executionTimeoutInputScreen(agent: AgentConfig | undefined) {
	const configured = agent ? readSubagentSettings()?.agents?.[agent.name] : undefined;
	return {
		kind: "input" as const,
		title: agent ? `${safeTerminalText(agent.name)} timeout` : "Agent timeout",
		lines: [
			`Current: ${configured?.timeoutMs ?? agent?.timeoutMs ?? "inherited"}`,
			`Allowed: 1-${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`,
			"Use Reset execution defaults to restore inheritance.",
		],
		placeholder: "Timeout in milliseconds",
		action: "set-agent-timeout" as const,
		hint: "back" as const,
	};
}

export function applyAgentThinking(
	agent: AgentConfig | undefined,
	value: string | undefined,
	ctx: ExtensionCommandContext,
) {
	if (!agent) return { kind: "rejected" as const };
	const thinkingLevel = value === "Inherited" ? undefined : (value as SubagentThinkingLevel);
	if (
		thinkingLevel !== undefined &&
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)
	) {
		return { kind: "rejected" as const };
	}
	return saveAgentPatch(agent.name, { thinkingLevel }, ctx, "thinking level");
}

export function applyAgentModel(
	agent: AgentConfig | undefined,
	value: string | undefined,
	ctx: ExtensionCommandContext,
) {
	if (!agent) return { kind: "rejected" as const };
	if (value === undefined) return saveAgentPatch(agent.name, { model: undefined }, ctx, "model");
	const model = value.trim();
	if (!model || Buffer.byteLength(model, "utf8") > 1_024 || hasTerminalControl(model)) {
		ctx.ui.notify("Model must contain 1-1024 UTF-8 bytes on one line.", "warning");
		return { kind: "rejected" as const };
	}
	return saveAgentPatch(agent.name, { model }, ctx, "model");
}

export function applyAgentTimeout(
	agent: AgentConfig | undefined,
	value: string | undefined,
	ctx: ExtensionCommandContext,
) {
	if (!agent) return { kind: "rejected" as const };
	const normalized = value?.trim() ?? "";
	if (!/^\d+$/u.test(normalized)) {
		ctx.ui.notify("Timeout must be a whole number of milliseconds.", "warning");
		return { kind: "rejected" as const };
	}
	const timeoutMs = Number(normalized);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SUBAGENT_TIMEOUT_MS) {
		ctx.ui.notify(`Timeout must be between 1 and ${MAX_SUBAGENT_TIMEOUT_MS}.`, "warning");
		return { kind: "rejected" as const };
	}
	return saveAgentPatch(agent.name, { timeoutMs }, ctx, "timeout");
}

export function resetAgentExecution(agent: AgentConfig | undefined, ctx: ExtensionCommandContext) {
	if (!agent) return { kind: "rejected" as const };
	return saveAgentPatch(
		agent.name,
		{ model: undefined, thinkingLevel: undefined, timeoutMs: undefined },
		ctx,
		"execution defaults",
	);
}

function saveAgentPatch(
	name: string,
	patch: Parameters<typeof updateAgentSettingsPatch>[0][string],
	ctx: ExtensionCommandContext,
	label: string,
) {
	try {
		updateAgentSettingsPatch({ [name]: patch });
		ctx.ui.notify(`${safeTerminalText(name)} ${label} saved.`, "info");
		return { kind: "back" as const };
	} catch (error) {
		ctx.ui.notify(
			`${safeTerminalText(name)} ${label} was not saved: ${formatError(error)}`,
			"error",
		);
		return { kind: "rejected" as const };
	}
}

function hasTerminalControl(value: string): boolean {
	return [...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	});
}

function executionSettingsFingerprint(): string {
	return JSON.stringify(readSubagentSettings()?.agents ?? {});
}

function formatError(error: unknown): string {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
