import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type CompletionDelivery, discoverAgents } from "./agents.js";
import type { ManagedAgent } from "./registry.js";
import {
	type DelegationWorkflow,
	hasOwn,
	inspectCompletionDeliverySettings,
	inspectDelegationWorkflowSettings,
	readSubagentSettings,
	sameToolSet,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateCompletionDeliverySetting,
	updateDelegationWorkflowSetting,
} from "./settings.js";
import { formatStatefulAgentLine, type StatefulSubagentRuntimeStatus } from "./stateful.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "settings", label: "settings", description: "Configure completion behavior" },
	{ value: "status", label: "status", description: "Show effective subagent settings" },
	{ value: "help", label: "help", description: "Show subagent settings help" },
];

export interface SubagentSettingsRuntime {
	getBlockingEnabled(): boolean;
	getCompletionDelivery(): CompletionDelivery;
	setCompletionDelivery(value: CompletionDelivery): void;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listAgents(includeClosed?: boolean): ManagedAgent[];
	clearAgents(): Promise<number>;
}

export class ToolToggleList {
	private items: { name: string; displayName: string; selected: boolean }[];
	private cursor = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	onDone?: (selected: string[]) => void;
	onCancel?: () => void;

	constructor(tools: string[], selected: Set<string>) {
		this.items = tools.map((name) => ({
			name,
			displayName: safeTerminalText(name),
			selected: selected.has(name),
		}));
	}

	private getSelectedNames(): string[] {
		return this.items.filter((i) => i.selected).map((i) => i.name);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
			return;
		}
		if (data === "s" || data === "S") {
			this.onDone?.(this.getSelectedNames());
			return;
		}
		if (this.items.length === 0) return;

		if (matchesKey(data, Key.up) && this.cursor > 0) {
			this.cursor--;
			this.invalidate();
		} else if (matchesKey(data, Key.down) && this.cursor < this.items.length - 1) {
			this.cursor++;
			this.invalidate();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.items[this.cursor].selected = !this.items[this.cursor].selected;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.items.map((item, i) => {
			const pointer = i === this.cursor ? ">" : " ";
			const check = item.selected ? "✓" : "○";
			return truncateToWidth(`${pointer} ${check} ${item.displayName}`, width);
		});
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function registerSubagentConfigCommand(pi: ExtensionAPI, runtime: SubagentSettingsRuntime) {
	registerSubagentPrimaryCommand(pi, runtime);
}

async function showSubagentToolSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("Agent tool settings require TUI mode", "info");
		return;
	}

	// Get current settings
	const currentSettings = readSubagentSettings() ?? {};
	const currentAgents = currentSettings.agents ?? {};

	// Discover agents to show which ones are available
	const discovery = discoverAgents(ctx.cwd, "user", currentSettings);
	const agents = discovery.agents;

	if (agents.length === 0) {
		ctx.ui.notify("No agents found", "warning");
		return;
	}

	// Loop: agent selection → tool toggle (Esc in tools returns here)
	let selectedAgentIndex = 0;
	while (true) {
		// Step 1: pick an agent to configure
		const agentItems: SelectItem[] = agents.map((a) => {
			const cfg = currentAgents[a.name];
			const hasToolsOverride = cfg ? hasOwn(cfg, "tools") : false;
			const toolSummary = hasToolsOverride
				? cfg?.tools && cfg.tools.length > 0
					? cfg.tools.join(", ")
					: "none"
				: "defaults";
			return {
				value: a.name,
				label: safeTerminalText(a.name),
				description: safeTerminalText(`${a.source} · tools: ${toolSummary}`),
			};
		});

		const agentName = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Subagent Tool Configuration")), 1, 0),
			);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("muted", "Select an agent to configure its allowed tools:"), 1, 0),
			);
			container.addChild(new Spacer(1));
			const selectList = new SelectList(agentItems, Math.min(agentItems.length + 2, 15), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			selectList.setSelectedIndex(selectedAgentIndex);
			selectList.onSelectionChange = (item) => {
				selectedAgentIndex = Math.max(
					0,
					agentItems.findIndex((candidate) => candidate.value === item.value),
				);
			};
			selectList.onSelect = (item) => {
				selectedAgentIndex = Math.max(
					0,
					agentItems.findIndex((candidate) => candidate.value === item.value),
				);
				done(item.value);
			};
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!agentName) return;

		const agent = agents.find((a) => a.name === agentName);
		if (!agent) return;

		// Step 2: toggle tools for the selected agent
		// Discover without overrides to get original built-in/frontmatter defaults.
		// The main discovery above applies saved overrides, so agent.tools is already
		// overridden — using it for the reset-to-default comparison would match the
		// override against itself and silently delete it on a no-op save.
		const defaultDiscovery = discoverAgents(ctx.cwd, "user");
		const defaultTools = defaultDiscovery.agents.find((a) => a.name === agentName)?.tools;
		const currentAgentSettings = currentAgents[agentName];
		const configuredTools =
			currentAgentSettings && hasOwn(currentAgentSettings, "tools")
				? (currentAgentSettings.tools ?? [])
				: undefined;

		// Get all available tools from pi's registry
		const allTools = uniqueToolNames(pi.getAllTools().map((t) => t.name)).sort((a, b) =>
			a.localeCompare(b),
		);
		const currentTools = uniqueToolNames(configuredTools ?? defaultTools ?? allTools);
		// Sort: currently selected tools first, then rest alphabetically. Preserve
		// unavailable configured tools so saving does not silently drop them.
		const currentSet = new Set(currentTools);
		const selectedFirst = [...currentTools, ...allTools.filter((t) => !currentSet.has(t))];

		const selectedTools = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
			const toggleList = new ToolToggleList(selectedFirst, currentSet);

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`${safeTerminalText(agentName)} tools`)) +
						theme.fg("muted", ` (${agent.source})`),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("muted", "Toggle tools with Enter/Space. S to save, Esc to cancel."),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			listContainer.addChild({
				render: (w: number) => toggleList.render(w),
				invalidate: () => toggleList.invalidate(),
			});
			container.addChild(listContainer);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate · enter/space toggle · S save · esc cancel"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			toggleList.onDone = (tools) => done(tools);
			toggleList.onCancel = () => done(null);

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					toggleList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		// null means user cancelled — loop back to agent selection
		if (selectedTools === null) continue;

		// Patch only this agent's tool field so forward-compatible settings survive.
		const restoredDefaults =
			defaultTools === undefined
				? sameToolSet(selectedTools, allTools)
				: sameToolSet(selectedTools, defaultTools);
		updateAgentToolsSetting(agentName, restoredDefaults ? undefined : selectedTools);
		const safeAgentName = safeTerminalText(agentName);
		const message = restoredDefaults
			? `${safeAgentName}: defaults restored`
			: `${safeAgentName}: ${selectedTools.length} tool${selectedTools.length !== 1 ? "s" : ""} configured`;
		ctx.ui.notify(message, "info");
		// Saved — exit the loop
		break;
	}
}

type ManagerAction = "workflow" | "agents" | "completion" | "advanced" | "help";
type AdvancedAction = "agent-tools" | "status" | "back";
type AgentManagerAction = "back" | "clear";

function registerSubagentPrimaryCommand(pi: ExtensionAPI, runtime: SubagentSettingsRuntime) {
	pi.registerCommand("subagents", {
		description: "Manage current-session subagents and user settings",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const subcommand = args.trim().toLowerCase();
			if (!subcommand) {
				await showSubagentManager(pi, ctx, runtime);
				return;
			}
			switch (subcommand) {
				case "settings":
					await showSubagentSettings(ctx, runtime);
					return;
				case "status":
					showSubagentStatus(ctx, runtime);
					return;
				case "help":
					showSubagentHelp(ctx);
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
) {
	if (ctx.mode !== "tui") {
		showSubagentStatus(ctx, runtime);
		return;
	}
	while (true) {
		const action = await selectManagerAction(ctx, runtime);
		if (!action) return;
		switch (action) {
			case "workflow":
				if (await showDelegationWorkflow(ctx, runtime)) return;
				break;
			case "agents":
				await showCurrentSessionAgents(ctx, runtime);
				break;
			case "completion":
				await showSubagentSettings(ctx, runtime);
				break;
			case "advanced":
				await showAdvancedSettings(pi, ctx, runtime);
				break;
			case "help":
				showSubagentHelp(ctx);
				break;
		}
	}
}

async function selectManagerAction(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
): Promise<ManagerAction | null> {
	const status = runtime.getRuntimeStatus();
	const workflow = inspectDelegationWorkflowSettings();
	const items: SelectItem[] = [
		{
			value: "workflow",
			label: "Change delegation",
			description: "Choose all methods, async only, or blocking only",
		},
		{
			value: "agents",
			label: "Current agents",
			description: `${status.activeAgents} active · ${status.retainedAgents} retained`,
		},
		{
			value: "completion",
			label: "Completion behavior",
			description: "Choose whether async completion waits or resumes automatically",
		},
		{
			value: "advanced",
			label: "Advanced settings",
			description: "Agent permissions, runtime details, and settings path",
		},
		{ value: "help", label: "Help", description: "Show commands and manual configuration" },
	];
	return ctx.ui.custom<ManagerAction | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("muted", formatManagerSummary(runtime, status, workflow)), 1, 0),
		);
		container.addChild(new Spacer(1));
		const selectList = new SelectList(items, Math.min(items.length + 2, 15), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value as ManagerAction);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc close"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function showDelegationWorkflow(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
): Promise<boolean> {
	const snapshot = inspectDelegationWorkflowSettings();
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Edit delegation settings manually: ${safeTerminalText(snapshot.path)}`,
				"info",
			);
		}
		return false;
	}
	if (snapshot.error) {
		ctx.ui.notify(
			`Delegation settings cannot be edited: ${safeTerminalText(snapshot.error)}. Repair ${safeTerminalText(snapshot.path)} and retry.`,
			"error",
		);
		return false;
	}
	const activeWorkflow = currentWorkflow(runtime, runtime.getRuntimeStatus());
	const choices: SelectItem[] = [
		{
			value: "all",
			label: "All delegation methods",
			description: "Allow blocking batches and reusable async agents",
		},
		{
			value: "async-only",
			label: "Async only",
			description: "Keep the root responsive; remove blocking subagent",
		},
		{
			value: "blocking-only",
			label: "Blocking only",
			description: "Keep blocking batches; remove reusable async agents",
		},
	];
	const selected = await ctx.ui.custom<DelegationWorkflow | null>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Change Delegation")), 1, 0));
			container.addChild(
				new Text(
					theme.fg(
						"muted",
						[
							`Current: ${workflowLabel(activeWorkflow)}`,
							...(snapshot.value !== activeWorkflow
								? [`Configured after reload: ${workflowLabel(snapshot.value)}`]
								: []),
						].join("\n"),
					),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));
			const selectList = new SelectList(choices, Math.min(choices.length + 2, 10), {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			});
			selectList.setSelectedIndex(
				Math.max(
					0,
					choices.findIndex((item) => item.value === snapshot.value),
				),
			);
			selectList.onSelect = (item) => done(item.value as DelegationWorkflow);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter preview · esc back"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);
	if (!selected) return false;
	if (selected === activeWorkflow && selected === snapshot.value) {
		ctx.ui.notify(`Delegation already uses ${workflowLabel(selected)}.`, "info");
		return false;
	}
	const requiresReload = selected !== activeWorkflow;
	if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) return false;

	const confirmed = await showWorkflowPreview(ctx, activeWorkflow, selected, requiresReload);
	if (!confirmed) return false;
	if (requiresReload && blockReloadWithRetainedAgents(ctx, runtime)) return false;
	try {
		updateDelegationWorkflowSetting(selected as Exclude<DelegationWorkflow, "disabled">);
	} catch (error) {
		ctx.ui.notify(
			`Delegation settings were not saved: ${formatError(error)}. The current workflow is unchanged.`,
			"error",
		);
		return false;
	}
	if (!requiresReload) {
		ctx.ui.notify(
			`Saved ${workflowLabel(selected)}. The current tool surface already matches.`,
			"info",
		);
		return false;
	}
	ctx.ui.notify(
		`Saved ${workflowLabel(selected)}. Reloading subagent tools… If the tool surface does not refresh, run /reload.`,
		"info",
	);
	await ctx.reload();
	return true;
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
	const workflowChanges = workflowEffects(current, next);
	const effects = (
		workflowChanges.length > 0
			? workflowChanges
			: ["Keep the current registered tools and cancel the pending workflow change"]
	)
		.map((effect) => `- ${effect}`)
		.join("\n");
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Review Delegation Change")), 1, 0));
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					`Current: ${workflowLabel(current)}\nNew: ${workflowLabel(next)}\n\nEffect:\n${effects}\n- ${requiresReload ? "Reload the extension to apply this tool surface" : "No reload is needed because the active tools already match"}`,
				),
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));
		const actions: SelectItem[] = [
			{
				value: "save",
				label: requiresReload ? "Save and reload" : "Save",
				description: requiresReload
					? "Persist and apply this workflow"
					: "Persist the workflow that is already active",
			},
			{ value: "cancel", label: "Cancel", description: "Leave settings and tools unchanged" },
		];
		const selectList = new SelectList(actions, 4, {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value === "save");
		selectList.onCancel = () => done(false);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter choose · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function showAdvancedSettings(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	while (true) {
		const action = await ctx.ui.custom<AdvancedAction | null>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Advanced Subagent Settings")), 1, 0),
			);
			container.addChild(new Spacer(1));
			const items: SelectItem[] = [
				{
					value: "agent-tools",
					label: "Agent tool permissions",
					description: "Customize persistent per-agent tool allow-lists",
				},
				{
					value: "status",
					label: "Runtime details",
					description: "Show transport, configured source, and settings path",
				},
				{ value: "back", label: "Back", description: "Return to the Subagents manager" },
			];
			const selectList = new SelectList(items, 5, {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value as AdvancedAction);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc back"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (!action || action === "back") return;
		if (action === "agent-tools") await showSubagentToolSettings(pi, ctx);
		else showSubagentStatus(ctx, runtime);
	}
}

async function showCurrentSessionAgents(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	while (true) {
		const agents = runtime.listAgents();
		const status = runtime.getRuntimeStatus();
		const action = await ctx.ui.custom<AgentManagerAction | null>(
			(tui, theme, _keybindings, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(
					new Text(theme.fg("accent", theme.bold("Current-session Subagents")), 1, 0),
				);
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							agents.length
								? agents.map(formatStatefulAgentLine).join("\n")
								: formatEmptyRuntime(status),
						),
						1,
						0,
					),
				);
				container.addChild(new Spacer(1));
				const actions: SelectItem[] = [
					{ value: "back", label: "Back", description: "Return to the Subagents manager" },
					...(agents.length > 0
						? [
								{
									value: "clear",
									label: "Clear current-session agents",
									description: "Close and delete retained agents for this session",
								},
							]
						: []),
				];
				const selectList = new SelectList(actions, Math.min(actions.length + 2, 8), {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				});
				selectList.onSelect = (item) => done(item.value as AgentManagerAction);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput(data: string) {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			},
		);
		if (!action || action === "back") return;
		const confirmed = await ctx.ui.confirm(
			"Clear current-session subagents?",
			`Close and delete ${agents.length} retained agent${agents.length === 1 ? "" : "s"}?`,
		);
		if (!confirmed) continue;
		const cleared = await runtime.clearAgents();
		ctx.ui.notify(
			`Cleared ${cleared} current-session subagent${cleared === 1 ? "" : "s"}.`,
			"info",
		);
	}
}

async function showSubagentSettings(
	ctx: ExtensionCommandContext,
	runtime: SubagentSettingsRuntime,
) {
	const snapshot = inspectCompletionDeliverySettings();
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`User settings apply to this and future sessions. Edit settings manually: ${safeTerminalText(snapshot.path)}`,
				"info",
			);
		}
		return;
	}
	if (snapshot.error) {
		ctx.ui.notify(
			`Subagent settings cannot be edited: ${safeTerminalText(snapshot.error)}`,
			"error",
		);
		return;
	}
	let currentValue = snapshot.value;
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const items: SettingItem[] = [
			{
				id: "completionDelivery",
				label: "When async work finishes",
				description:
					"Wait for your next turn, or request one synthesis turn after the root settles.",
				currentValue: completionLabel(currentValue),
				values: ["Wait until my next turn", "Resume automatically when finished"],
			},
		];
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent User Settings")), 1, 0));
		container.addChild(
			new Text(
				theme.fg("muted", `Applies now and to future sessions\n${safeTerminalText(snapshot.path)}`),
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));
		let settingsList: SettingsList;
		settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id !== "completionDelivery") return;
				const previous = currentValue;
				const next: CompletionDelivery =
					newValue === "Resume automatically when finished" ? "auto-resume" : "next-turn";
				try {
					updateCompletionDeliverySetting(next);
					runtime.setCompletionDelivery(next);
					currentValue = next;
					ctx.ui.notify(`Saved and applied: ${completionLabel(next)}.`, "info");
				} catch (error) {
					settingsList.updateValue(id, completionLabel(previous));
					ctx.ui.notify(`Subagent settings were not saved: ${formatError(error)}`, "error");
				}
				tui.requestRender();
			},
			() => done(undefined),
		);
		container.addChild(settingsList);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function showSubagentStatus(ctx: ExtensionCommandContext, runtime: SubagentSettingsRuntime) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		formatStatus(runtime.getRuntimeStatus(), snapshot, runtime),
		snapshot.error ? "warning" : "info",
	);
}

function showSubagentHelp(ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui" && !ctx.hasUI) return;
	const snapshot = inspectCompletionDeliverySettings();
	ctx.ui.notify(
		[
			"/subagents — choose delegation workflow, manage current agents, and configure agent tools",
			"/subagents settings — configure async completion behavior",
			"/subagents status — show current-session and user-setting values",
			"/subagents help — show this help",
			`User settings: ${safeTerminalText(snapshot.path)}`,
		].join("\n"),
		"info",
	);
}

function formatManagerSummary(
	runtime: SubagentSettingsRuntime,
	status: StatefulSubagentRuntimeStatus,
	configured: ReturnType<typeof inspectDelegationWorkflowSettings>,
): string {
	const current = currentWorkflow(runtime, status);
	return [
		`Delegation: ${workflowLabel(current)}`,
		`Completion: ${completionLabel(status.completionDelivery)}`,
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
	const current = runtime ? currentWorkflow(runtime, status) : configuredWorkflow.value;
	return [
		"Current session",
		`  Delegation: ${workflowLabel(current)}`,
		`  Async runtime: ${status.initialized ? "initialized" : status.enabled ? "not initialized" : "disabled"}`,
		`  Transport: ${status.transport}`,
		`  Completion: ${completionLabel(status.completionDelivery)}`,
		`  Agents: ${status.activeAgents} active, ${status.retainedAgents} retained`,
		"User settings",
		`  Delegation source: ${configuredWorkflow.source}`,
		`  Configured delegation: ${workflowLabel(configuredWorkflow.value)}`,
		`  Completion source: ${snapshot.source}`,
		`  Configured completion: ${completionLabel(snapshot.value)}`,
		`  Path: ${safeTerminalText(snapshot.path)}`,
		configuredWorkflow.error || snapshot.error
			? `  Warning: ${safeTerminalText(configuredWorkflow.error ?? snapshot.error ?? "invalid settings")}`
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

function workflowEffects(current: DelegationWorkflow, next: DelegationWorkflow): string[] {
	const blockingEnabled = (value: DelegationWorkflow) =>
		value === "all" || value === "blocking-only";
	const asyncEnabled = (value: DelegationWorkflow) => value === "all" || value === "async-only";
	const effects: string[] = [];
	if (blockingEnabled(current) !== blockingEnabled(next)) {
		effects.push(blockingEnabled(next) ? "Add blocking `subagent`" : "Remove blocking `subagent`");
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
