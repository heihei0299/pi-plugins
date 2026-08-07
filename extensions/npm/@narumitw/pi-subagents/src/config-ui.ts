import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type CompletionDelivery,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	type DelegationCwdPolicy,
	discoverAgents,
} from "./agents.js";
import type { ManagedAgent } from "./registry.js";
import {
	type DelegationWorkflow,
	hasOwn,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	readSubagentSettings,
	sameToolSet,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
	updateConsultResourceSetting,
	updateCwdPolicySetting,
	updateDelegationWorkflowSetting,
} from "./settings.js";
import { formatStatefulAgentLine, type StatefulSubagentRuntimeStatus } from "./stateful.js";

const SUBCOMMANDS = [
	{ value: "settings", label: "settings", description: "Configure subagent user settings" },
	{ value: "status", label: "status", description: "Show effective subagent settings" },
	{ value: "help", label: "help", description: "Show subagent settings help" },
];
const TOOL_VIEWPORT_SIZE = 10;

export interface SubagentSettingsRuntime {
	getBlockingEnabled(): boolean;
	getCompletionDelivery(): CompletionDelivery;
	getConsultResourcePolicy(): ConsultResourcePolicy;
	getConsultationCwdPolicy(): ConsultationCwdPolicy;
	getDelegationCwdPolicy(): DelegationCwdPolicy;
	setCompletionDelivery(value: CompletionDelivery): void;
	setConsultResourcePolicy(value: ConsultResourcePolicy): void;
	setConsultationCwdPolicy(value: ConsultationCwdPolicy): void;
	setDelegationCwdPolicy(value: DelegationCwdPolicy): void;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listAgents(includeClosed?: boolean): ManagedAgent[];
	clearAgents(): Promise<number>;
}

interface MenuOwner {
	generation: number;
	controller: AbortController;
}

interface ToolDraft {
	agentName: string;
	agentSource: string;
	allTools: string[];
	defaultTools?: string[];
	orderedTools: string[];
	selected: Set<string>;
}

export function registerSubagentConfigCommand(pi: ExtensionAPI, runtime: SubagentSettingsRuntime) {
	const owner: MenuOwner = { generation: 0, controller: new AbortController() };
	pi.on("session_start", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session replaced", "AbortError"));
		owner.controller = new AbortController();
	});
	pi.on("session_shutdown", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session shut down", "AbortError"));
	});
	registerSubagentPrimaryCommand(pi, runtime, owner);
}

function registerSubagentPrimaryCommand(
	pi: ExtensionAPI,
	runtime: SubagentSettingsRuntime,
	owner: MenuOwner,
) {
	pi.registerCommand("subagents", {
		description: "Manage current-session subagents and user settings",
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const subcommand = args.trim().toLowerCase();
			if (!subcommand) {
				await showSubagentManager(pi, ctx, runtime, owner);
				return;
			}
			switch (subcommand) {
				case "settings":
					await showSubagentSettings(ctx, runtime, owner);
					return;
				case "status":
					showSubagentStatus(ctx, runtime);
					return;
				case "help":
					showSubagentHelp(ctx, runtime);
					return;
				default:
					if (ctx.mode === "tui" || ctx.hasUI) {
						ctx.ui.notify(`Unknown /subagents subcommand: ${subcommand}`, "warning");
					}
			}
		},
	});
}

async function showSubagentManager(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
	owner: MenuOwner,
) {
	if (ctx.mode !== "tui") {
		showSubagentStatus(ctx, runtime);
		return;
	}
	const generation = owner.generation;
	const isCurrent = () => generation === owner.generation && !owner.controller.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	let availableAgents = discoverAgents(ctx.cwd, "user", readSubagentSettings() ?? {}).agents;
	let toolDraft: ToolDraft | undefined;
	type Screen =
		| "main"
		| "workflow"
		| "agents"
		| "settings"
		| "advanced"
		| "status"
		| "help"
		| "agent-picker"
		| "tool-draft";
	type Action =
		| "set-workflow"
		| "clear-agents"
		| "set-completion"
		| "set-consult-resources"
		| "set-consultation-cwd"
		| "set-delegation-cwd"
		| "load-agent-picker"
		| "pick-agent"
		| "toggle-tool"
		| "save-tools"
		| "discard-tools"
		| "back";
	const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => {
				const status = runtime.getRuntimeStatus();
				const workflow = inspectDelegationWorkflowSettings();
				return {
					kind: "actions",
					title: "Subagents",
					lines: formatManagerSummary(runtime, status, workflow).split("\n"),
					items: [
						{
							id: "workflow",
							label: "Change delegation",
							description: "Choose all methods, async only, or blocking only",
							to: "workflow",
						},
						{
							id: "agents",
							label: "Current agents",
							description: `${status.activeAgents} active · ${status.retainedAgents} retained`,
							to: "agents",
						},
						{
							id: "settings",
							label: "Settings",
							description: "Configure targets, trusted resources, and async completion",
							to: "settings",
						},
						{
							id: "advanced",
							label: "Advanced settings",
							description: "Agent permissions, runtime details, and settings path",
							to: "advanced",
						},
						{ id: "help", label: "Help", to: "help" },
					],
					hint: "close",
				};
			},
			workflow: () => {
				const snapshot = inspectDelegationWorkflowSettings();
				const active = currentWorkflow(runtime, runtime.getRuntimeStatus());
				return {
					kind: "actions",
					title: "Change Delegation",
					lines: [
						`Current: ${workflowLabel(active)}`,
						...(snapshot.value !== active
							? [`Configured after reload: ${workflowLabel(snapshot.value)}`]
							: []),
						...(snapshot.error
							? [
									`Settings cannot be edited: ${safeTerminalText(snapshot.error)}`,
									`Repair ${safeTerminalText(snapshot.path)} and retry.`,
								]
							: []),
					],
					items: snapshot.error
						? []
						: [
								{
									id: "all",
									label: "All delegation methods",
									description: "Allow blocking batches and reusable async agents",
									action: "set-workflow" as const,
								},
								{
									id: "async-only",
									label: "Async only",
									description: "Keep the root responsive; remove blocking subagent",
									action: "set-workflow" as const,
								},
								{
									id: "blocking-only",
									label: "Blocking only",
									description: "Keep blocking batches; remove reusable async agents",
									action: "set-workflow" as const,
								},
							],
					hint: "back",
				};
			},
			agents: () => {
				const agents = runtime.listAgents();
				const status = runtime.getRuntimeStatus();
				return {
					kind: "actions",
					title: "Current-session Subagents",
					lines: agents.length ? agents.map(formatStatefulAgentLine) : [formatEmptyRuntime(status)],
					items: [
						...(agents.length > 0
							? [
									{
										id: "clear",
										label: "Clear current-session agents",
										description: "Close and delete retained agents for this session",
										action: "clear-agents" as const,
									},
								]
							: []),
						{ id: "back", label: "Back", action: "back" },
					],
					hint: "back",
				};
			},
			settings: () => subagentSettingsScreen(runtime),
			advanced: () => ({
				kind: "actions",
				title: "Advanced Subagent Settings",
				items: [
					{
						id: "agent-tools",
						label: "Agent tool permissions",
						description: "Customize persistent per-agent tool allow-lists",
						action: "load-agent-picker",
					},
					{
						id: "status",
						label: "Runtime details",
						description: "Show transport, configured source, and settings path",
						to: "status",
					},
					{ id: "back", label: "Back", action: "back" },
				],
				hint: "back",
			}),
			status: () => ({
				kind: "detail",
				title: "Subagent runtime details",
				lines: statusLines(runtime),
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "Subagents help",
				lines: helpLines(runtime),
				hint: "back",
			}),
			"agent-picker": () => {
				const settings = readSubagentSettings() ?? {};
				const configured = settings.agents ?? {};
				return {
					kind: "actions",
					title: "Subagent Tool Configuration",
					lines: ["Select an agent to configure its allowed tools."],
					items: availableAgents.map((agent) => {
						const override = configured[agent.name];
						const hasOverride = override ? hasOwn(override, "tools") : false;
						const summary = hasOverride
							? override?.tools && override.tools.length > 0
								? override.tools.join(", ")
								: "none"
							: "defaults";
						return {
							id: agent.name,
							label: safeTerminalText(agent.name),
							description: safeTerminalText(`${agent.source} · tools: ${summary}`),
							action: "pick-agent" as const,
						};
					}),
					hint: "back",
				};
			},
			"tool-draft": () => ({
				kind: "multiSelect",
				title: toolDraft ? `${safeTerminalText(toolDraft.agentName)} tools` : "Agent tools",
				enableSearch: true,
				lines: toolDraft
					? [
							`Source: ${safeTerminalText(toolDraft.agentSource)}`,
							"Toggle a draft, then Save changes.",
						]
					: ["No agent selected."],
				viewportSize: TOOL_VIEWPORT_SIZE,
				items:
					toolDraft?.orderedTools.map((name) => {
						const available = toolDraft?.allTools.includes(name) ?? false;
						return {
							id: name,
							label: safeTerminalText(name),
							description: available ? "Available tool" : "Configured tool is not currently loaded",
							searchText: available ? "available tool" : "configured unavailable preserved",
							selected: toolDraft?.selected.has(name) ?? false,
							disabled: !available,
							disabledReason: available
								? undefined
								: "Unavailable; preserved until explicitly changed in JSON",
						};
					}) ?? [],
				action: "toggle-tool",
				actions: [
					{ id: "save", label: "Save changes", action: "save-tools" },
					{ id: "discard", label: "Discard draft", action: "discard-tools" },
				],
				hint: "back",
				doneLabel: "Close without saving",
			}),
		},
		actions: {
			"set-workflow": async ({ itemId }) => {
				if (!isWorkflow(itemId)) return { kind: "rejected" };
				const snapshot = inspectDelegationWorkflowSettings();
				if (snapshot.error) return { kind: "rejected" };
				const active = currentWorkflow(runtime, runtime.getRuntimeStatus());
				if (itemId === active && itemId === snapshot.value) {
					ctx.ui.notify(`Delegation already uses ${workflowLabel(itemId)}.`, "info");
					return { kind: "stay" };
				}
				const requiresReload = itemId !== active;
				if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) {
					return { kind: "rejected" };
				}
				if (!(await showWorkflowPreview(ctx, active, itemId, requiresReload))) {
					return { kind: "rejected" };
				}
				if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) {
					return { kind: "rejected" };
				}
				try {
					updateDelegationWorkflowSetting(itemId);
				} catch (error) {
					ctx.ui.notify(
						`Delegation settings were not saved: ${formatError(error)}. The current workflow is unchanged.`,
						"error",
					);
					return { kind: "rejected" };
				}
				if (!requiresReload) {
					ctx.ui.notify(
						`Saved ${workflowLabel(itemId)}. The current tool surface already matches.`,
						"info",
					);
					return { kind: "stay" };
				}
				ctx.ui.notify(
					`Saved ${workflowLabel(itemId)}. Reloading subagent tools… If the tool surface does not refresh, run /reload.`,
					"info",
				);
				await ctx.reload();
				return { kind: "close" };
			},
			"clear-agents": async () => {
				const agents = runtime.listAgents();
				if (agents.length === 0) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"Clear current-session subagents?",
					`Close and delete ${agents.length} retained agent${agents.length === 1 ? "" : "s"}?`,
				);
				if (!confirmed) return { kind: "rejected" };
				const cleared = await runtime.clearAgents();
				ctx.ui.notify(
					`Cleared ${cleared} current-session subagent${cleared === 1 ? "" : "s"}.`,
					"info",
				);
				return { kind: "stay" };
			},
			"set-completion": async ({ value }) => applyCompletionSetting(value, ctx, runtime),
			"set-consult-resources": async ({ value }) =>
				applyConsultResourceSetting(value, ctx, runtime),
			"set-consultation-cwd": async ({ value }) => applyConsultationCwdSetting(value, ctx, runtime),
			"set-delegation-cwd": async ({ value }) => applyDelegationCwdSetting(value, ctx, runtime),
			"load-agent-picker": async () => {
				availableAgents = discoverAgents(ctx.cwd, "user", readSubagentSettings() ?? {}).agents;
				if (availableAgents.length === 0) {
					ctx.ui.notify("No agents found", "warning");
					return { kind: "rejected" };
				}
				return { kind: "to", screen: "agent-picker" };
			},
			"pick-agent": async ({ itemId }) => {
				const agent = availableAgents.find((candidate) => candidate.name === itemId);
				if (!agent) return { kind: "rejected" };
				const settings = readSubagentSettings() ?? {};
				const configured = settings.agents?.[agent.name];
				const configuredTools =
					configured && hasOwn(configured, "tools") ? (configured.tools ?? []) : undefined;
				const defaults = discoverAgents(ctx.cwd, "user").agents.find(
					(candidate) => candidate.name === agent.name,
				)?.tools;
				const allTools = uniqueToolNames(pi.getAllTools().map((tool) => tool.name)).sort((a, b) =>
					a.localeCompare(b),
				);
				const selected = uniqueToolNames(configuredTools ?? defaults ?? allTools);
				const selectedSet = new Set(selected);
				toolDraft = {
					agentName: agent.name,
					agentSource: agent.source,
					allTools,
					defaultTools: defaults,
					orderedTools: [...selected, ...allTools.filter((name) => !selectedSet.has(name))],
					selected: selectedSet,
				};
				return { kind: "to", screen: "tool-draft" };
			},
			"toggle-tool": async ({ itemId, selected }) => {
				if (!toolDraft?.allTools.includes(itemId)) return { kind: "rejected" };
				if (selected) toolDraft.selected.add(itemId);
				else toolDraft.selected.delete(itemId);
				return { kind: "stay" };
			},
			"save-tools": async () => {
				if (!toolDraft) return { kind: "rejected" };
				const selected = toolDraft.orderedTools.filter((name) => toolDraft?.selected.has(name));
				const restoredDefaults =
					toolDraft.defaultTools === undefined
						? sameToolSet(selected, toolDraft.allTools)
						: sameToolSet(selected, toolDraft.defaultTools);
				try {
					updateAgentToolsSetting(toolDraft.agentName, restoredDefaults ? undefined : selected);
				} catch (error) {
					ctx.ui.notify(`Agent tool settings were not saved: ${formatError(error)}`, "error");
					return { kind: "rejected" };
				}
				ctx.ui.notify(
					restoredDefaults
						? `${safeTerminalText(toolDraft.agentName)}: defaults restored`
						: `${safeTerminalText(toolDraft.agentName)}: ${selected.length} tool${selected.length === 1 ? "" : "s"} configured`,
					"info",
				);
				toolDraft = undefined;
				return { kind: "back" };
			},
			"discard-tools": async () => {
				toolDraft = undefined;
				return { kind: "back" };
			},
			back: async () => ({ kind: "back" }),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.controller.signal,
		isCurrent,
	});
}

async function showSubagentSettings(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
	owner: MenuOwner,
) {
	const snapshot = inspectConsultResourceSettings();
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`User settings apply to this and future sessions. Edit settings manually: ${safeTerminalText(snapshot.path)}`,
				"info",
			);
		}
		return;
	}
	const generation = owner.generation;
	const isCurrent = () => generation === owner.generation && !owner.controller.signal.aborted;
	const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
	if (!isCurrent()) return;
	type SettingsAction =
		| "set-completion"
		| "set-consult-resources"
		| "set-consultation-cwd"
		| "set-delegation-cwd";
	const menu = defineMenu<undefined, "settings", SettingsAction, ExtensionCommandContext>({
		start: "settings",
		screens: { settings: () => subagentSettingsScreen(runtime) },
		actions: {
			"set-completion": async ({ value }) => applyCompletionSetting(value, ctx, runtime),
			"set-consult-resources": async ({ value }) =>
				applyConsultResourceSetting(value, ctx, runtime),
			"set-consultation-cwd": async ({ value }) => applyConsultationCwdSetting(value, ctx, runtime),
			"set-delegation-cwd": async ({ value }) => applyDelegationCwdSetting(value, ctx, runtime),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: owner.controller.signal,
		isCurrent,
	});
}

function subagentSettingsScreen(runtime: SubagentSettingsRuntime) {
	const completion = inspectCompletionDeliverySettings();
	const consult = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const error = completion.error ?? consult.error ?? cwdPolicy.error;
	return {
		kind: "settings" as const,
		title: error ? "Subagent User Settings · Read only" : "Subagent User Settings",
		lines: [
			"Applies now and to future sessions",
			"Target and trust settings control startup resources, not filesystem access or sandboxing.",
			"Manage folder trust with Pi /trust; restart Pi after changing it.",
			safeTerminalText(consult.path),
			...(error ? [`Settings cannot be edited: ${safeTerminalText(error)}`] : []),
		],
		items: error
			? []
			: [
					{
						id: "consultationCwd",
						label: "Read-only consultation target",
						description:
							"Untrusted external targets inherit no target/project resources; agent and package read-only prompts remain.",
						currentValue: consultationCwdLabel(runtime.getConsultationCwdPolicy()),
						values: ["Anywhere · untrusted targets inherit nothing", "Current workspace only"],
						action: "set-consultation-cwd" as const,
					},
					{
						id: "delegationCwd",
						label: "General delegation target",
						description:
							"Controls starting directories, not absolute paths, shell commands, or OS permissions.",
						currentValue: delegationCwdLabel(runtime.getDelegationCwdPolicy()),
						values: [
							"Current or saved-trusted folders",
							"Current workspace only",
							"Anywhere · normal Pi permissions",
						],
						action: "set-delegation-cwd" as const,
					},
					{
						id: "consultResources",
						label: "Consultation resources for trusted targets",
						description:
							"Choose which trusted context, system, skill, and prompt resources a consultation inherits.",
						currentValue: consultResourceLabel(runtime.getConsultResourcePolicy()),
						values: ["Project context only", "No inherited resources", "All trusted resources"],
						action: "set-consult-resources" as const,
					},
					{
						id: "completionDelivery",
						label: "When async work finishes",
						description:
							"Wait for your next turn, or request one synthesis turn after the root settles.",
						currentValue: completionLabel(runtime.getCompletionDelivery()),
						values: ["Wait until my next turn", "Resume automatically when finished"],
						action: "set-completion" as const,
					},
				],
	};
}

function applyCompletionSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getCompletionDelivery();
	const next: CompletionDelivery =
		value === "Resume automatically when finished" ? "auto-resume" : "next-turn";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCompletionDeliverySetting(next);
		runtime.setCompletionDelivery(next);
		ctx.ui.notify(`Saved and applied: ${completionLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyConsultResourceSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getConsultResourcePolicy();
	const next: ConsultResourcePolicy =
		value === "No inherited resources"
			? "none"
			: value === "All trusted resources"
				? "all"
				: "project-context";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateConsultResourceSetting(next);
		runtime.setConsultResourcePolicy(next);
		ctx.ui.notify(`Saved and applied: ${consultResourceLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyConsultationCwdSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getConsultationCwdPolicy();
	const next: ConsultationCwdPolicy =
		value === "Current workspace only" ? "current-workspace" : "anywhere";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCwdPolicySetting("consultation", next);
		runtime.setConsultationCwdPolicy(next);
		ctx.ui.notify(`Saved and applied: ${consultationCwdLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function applyDelegationCwdSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const previous = runtime.getDelegationCwdPolicy();
	const next: DelegationCwdPolicy =
		value === "Current workspace only"
			? "current-workspace"
			: value === "Anywhere · normal Pi permissions"
				? "anywhere"
				: "trusted-targets";
	if (next === previous) return { kind: "stay" as const };
	try {
		updateCwdPolicySetting("delegation", next);
		runtime.setDelegationCwdPolicy(next);
		ctx.ui.notify(`Saved and applied: ${delegationCwdLabel(next)}.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
		return { kind: "rejected" as const };
	}
}

function blockReloadWithRetainedAgents(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
): boolean {
	const status = runtime.getRuntimeStatus();
	if (status.retainedAgents === 0) return false;
	ctx.ui.notify(
		`Cannot reload while ${status.retainedAgents} detached subagent${status.retainedAgents === 1 ? " is" : "s are"} retained (${status.activeAgents} active). Open Current agents and clear them after their work is safe to discard, then change delegation.`,
		"warning",
	);
	return true;
}

async function showWorkflowPreview(
	ctx: ExtensionCommandContext,
	current: DelegationWorkflow,
	next: DelegationWorkflow,
	requiresReload: boolean,
): Promise<boolean> {
	const changes = workflowEffects(current, next);
	return ctx.ui.confirm(
		requiresReload ? "Save delegation change and reload?" : "Save delegation change?",
		[
			`Current: ${workflowLabel(current)}`,
			`New: ${workflowLabel(next)}`,
			"",
			"Effect:",
			...(changes.length > 0 ? changes : ["Keep the current registered tools"]).map(
				(effect) => `- ${effect}`,
			),
			`- ${requiresReload ? "Reload the extension to apply this tool surface" : "No reload is needed because the active tools already match"}`,
		].join("\n"),
	);
}

function showSubagentStatus(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		formatStatus(runtime.getRuntimeStatus(), snapshot, runtime),
		snapshot.error ? "warning" : "info",
	);
}

function showSubagentHelp(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	ctx.ui.notify(helpLines(runtime).join("\n"), "info");
}

function statusLines(runtime: SubagentSettingsRuntime): string[] {
	const snapshot = inspectCompletionDeliverySettings();
	return formatStatus(runtime.getRuntimeStatus(), snapshot, runtime).split("\n");
}

function helpLines(runtime: SubagentSettingsRuntime): string[] {
	const snapshot = inspectCompletionDeliverySettings();
	const cwdPolicy = inspectCwdPolicySettings();
	return [
		"/subagents — choose delegation workflow, manage current agents, and configure agent tools",
		"/subagents settings — configure target locations, trusted resources, and async completion",
		"/subagents status — show current-session and user-setting values",
		"/subagents help — show this help",
		"Target policies control startup directories and resources, not filesystem access or sandboxing.",
		"Manage saved folder trust with Pi /trust and restart Pi after changing it.",
		`Runtime consultation target: ${consultationCwdLabel(runtime.getConsultationCwdPolicy())}`,
		`Configured consultation target: ${consultationCwdLabel(cwdPolicy.consultation.value)} (${cwdPolicy.consultation.source})`,
		`Runtime delegation target: ${delegationCwdLabel(runtime.getDelegationCwdPolicy())}`,
		`Configured delegation target: ${delegationCwdLabel(cwdPolicy.delegation.value)} (${cwdPolicy.delegation.source})`,
		`User settings: ${safeTerminalText(snapshot.path)}`,
	];
}

function formatManagerSummary(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
	configured: ReturnType<typeof inspectDelegationWorkflowSettings>,
): string {
	const current = currentWorkflow(runtime, status);
	const cwdPolicy = inspectCwdPolicySettings();
	const consult = inspectConsultResourceSettings();
	return [
		`Delegation: ${workflowLabel(current)}`,
		`Completion: ${completionLabel(status.completionDelivery)}`,
		`Consult target: ${consultationCwdLabel(runtime.getConsultationCwdPolicy())}`,
		`Delegation target: ${delegationCwdLabel(runtime.getDelegationCwdPolicy())}`,
		`Consult resources: ${consultResourceLabel(runtime.getConsultResourcePolicy())}`,
		`Configured consult target: ${consultationCwdLabel(cwdPolicy.consultation.value)} · ${cwdPolicy.consultation.source}`,
		`Configured delegation target: ${delegationCwdLabel(cwdPolicy.delegation.value)} · ${cwdPolicy.delegation.source}`,
		`Configured consult resources: ${consultResourceLabel(consult.value)} · ${consult.source}`,
		`Settings: ${safeTerminalText(cwdPolicy.path)}`,
		`Agents: ${status.activeAgents} active · ${status.retainedAgents} retained`,
		...(configured.value !== current
			? [`Configured after reload: ${workflowLabel(configured.value)}`]
			: []),
		...(configured.error ? ["Settings need repair; open Advanced settings for details."] : []),
	].join("\n");
}

function formatStatus(
	status: StatefulSubagentRuntimeStatus,
	snapshot: ReturnType<typeof inspectCompletionDeliverySettings>,
	runtime?: SubagentSettingsRuntime,
): string {
	const configuredWorkflow = inspectDelegationWorkflowSettings();
	const consult = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const current = runtime ? currentWorkflow(runtime, status) : configuredWorkflow.value;
	return [
		"Current session",
		`  Delegation: ${workflowLabel(current)}`,
		`  Async runtime: ${status.initialized ? "initialized" : status.enabled ? "not initialized" : "disabled"}`,
		`  Transport: ${status.transport}`,
		`  Completion: ${completionLabel(status.completionDelivery)}`,
		`  Consultation target: ${consultationCwdLabel(runtime?.getConsultationCwdPolicy() ?? cwdPolicy.consultation.value)}`,
		`  Delegation target: ${delegationCwdLabel(runtime?.getDelegationCwdPolicy() ?? cwdPolicy.delegation.value)}`,
		`  Consultation resources: ${consultResourceLabel(runtime?.getConsultResourcePolicy() ?? consult.value)}`,
		`  Agents: ${status.activeAgents} active, ${status.retainedAgents} retained`,
		"User settings",
		`  Delegation source: ${configuredWorkflow.source}`,
		`  Configured delegation: ${workflowLabel(configuredWorkflow.value)}`,
		`  Completion source: ${snapshot.source}`,
		`  Configured completion: ${completionLabel(snapshot.value)}`,
		`  Configured consultation target: ${consultationCwdLabel(cwdPolicy.consultation.value)}`,
		`  Consultation target source: ${cwdPolicy.consultation.source}`,
		`  Configured delegation target: ${delegationCwdLabel(cwdPolicy.delegation.value)}`,
		`  Delegation target source: ${cwdPolicy.delegation.source}`,
		`  Configured consultation resources: ${consultResourceLabel(consult.value)}`,
		`  Consultation resource source: ${consult.source}`,
		`  Path: ${safeTerminalText(snapshot.path)}`,
		configuredWorkflow.error || snapshot.error || cwdPolicy.error
			? `  Warning: ${safeTerminalText(configuredWorkflow.error ?? snapshot.error ?? cwdPolicy.error ?? "invalid settings")}`
			: "  Warning: none",
		configuredWorkflow.value !== current
			? "Configured delegation differs from this session. Run /reload to apply it."
			: "Manual file changes require /reload.",
	].join("\n");
}

function formatEmptyRuntime(status: StatefulSubagentRuntimeStatus): string {
	if (!status.enabled) return "Stateful subagents are disabled in user settings.";
	if (!status.initialized) return "Stateful subagents are not initialized for this session.";
	return "No current-session subagents.";
}

function currentWorkflow(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
): DelegationWorkflow {
	const blocking = runtime.getBlockingEnabled();
	if (blocking && status.enabled) return "all";
	if (status.enabled) return "async-only";
	if (blocking) return "blocking-only";
	return "disabled";
}

function isWorkflow(value: string): value is Exclude<DelegationWorkflow, "disabled"> {
	return value === "all" || value === "async-only" || value === "blocking-only";
}

function workflowLabel(value: DelegationWorkflow): string {
	switch (value) {
		case "all":
			return "All delegation methods";
		case "async-only":
			return "Async only";
		case "blocking-only":
			return "Blocking only";
		case "disabled":
			return "Delegation disabled";
	}
}

function completionLabel(value: CompletionDelivery): string {
	return value === "auto-resume" ? "Resume automatically when finished" : "Wait until my next turn";
}

function consultationCwdLabel(value: ConsultationCwdPolicy): string {
	return value === "current-workspace"
		? "Current workspace only"
		: "Anywhere · untrusted targets inherit nothing";
}

function delegationCwdLabel(value: DelegationCwdPolicy): string {
	switch (value) {
		case "trusted-targets":
			return "Current or saved-trusted folders";
		case "current-workspace":
			return "Current workspace only";
		case "anywhere":
			return "Anywhere · normal Pi permissions";
	}
}

function consultResourceLabel(value: ConsultResourcePolicy): string {
	switch (value) {
		case "project-context":
			return "Project context only";
		case "none":
			return "No inherited resources";
		case "all":
			return "All trusted resources";
	}
}

function workflowEffects(current: DelegationWorkflow, next: DelegationWorkflow): string[] {
	const blockingEnabled = (value: DelegationWorkflow) =>
		value === "all" || value === "blocking-only";
	const asyncEnabled = (value: DelegationWorkflow) => value === "all" || value === "async-only";
	const effects: string[] = [];
	if (blockingEnabled(current) !== blockingEnabled(next)) {
		effects.push(
			blockingEnabled(next)
				? "Add blocking `subagent` and read-only `subagent_consult`"
				: "Remove blocking `subagent` and read-only `subagent_consult`",
		);
	}
	if (asyncEnabled(current) !== asyncEnabled(next)) {
		effects.push(
			asyncEnabled(next)
				? "Add reusable async lifecycle tools"
				: "Remove reusable async lifecycle tools",
		);
	}
	return effects;
}

function safeTerminalText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

function formatError(error: unknown): string {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
