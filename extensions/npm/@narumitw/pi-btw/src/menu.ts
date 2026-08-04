import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { defineMenu, type MenuContext, type RunMenuResult, runMenu } from "@narumitw/pi-tui-kit";
import {
	type BtwSettings,
	btwSettingsPath,
	effectiveRememberThinkingLevelChanges,
	readBtwSettings,
	type UpdateBtwSettingsOptions,
	updateBtwSettings,
} from "./settings.js";
import { BTW_THINKING_LEVELS, type BtwThinkingLevel } from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

interface BtwMenuState {
	kind: "valid" | "invalid";
	settings: BtwSettings;
	reason?: string;
}

export interface ShowBtwCommandMenuOptions {
	currentThinkingLevel: BtwThinkingLevel;
	availableThinkingLevels: readonly BtwThinkingLevel[];
	settingsPath?: string;
	readSettings?: typeof readBtwSettings;
	updateSettings?: (
		patch: Partial<Pick<BtwSettings, "thinkingLevel" | "rememberThinkingLevelChanges">>,
		options: UpdateBtwSettingsOptions,
	) => Promise<BtwSettings>;
}

export type BtwCommandMenuResult = "start" | "closed";

type BtwMenuScreen = "main" | "settings" | "invalid";
type BtwMenuAction = "start" | "set-thinking" | "set-remember";
type BtwCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];

type BtwCustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => Component;

export async function showBtwCommandMenu(
	ctx: ExtensionCommandContext,
	options: ShowBtwCommandMenuOptions,
): Promise<BtwCommandMenuResult> {
	if (ctx.mode !== "tui") return "closed";
	const settingsPath = options.settingsPath ?? btwSettingsPath();
	const readSettings = options.readSettings ?? readBtwSettings;
	const updateSettings = options.updateSettings ?? updateBtwSettings;
	const levels =
		options.availableThinkingLevels.length > 0
			? [...options.availableThinkingLevels]
			: (["off"] satisfies BtwThinkingLevel[]);
	const displaySettingsPath = sanitizeSingleLine(settingsPath);
	let startSelected = false;

	const loadState = async (): Promise<BtwMenuState> => {
		const loaded = await readSettings(settingsPath);
		if (loaded.kind === "invalid") {
			return { kind: "invalid", settings: {}, reason: loaded.reason };
		}
		return { kind: "valid", settings: loaded.kind === "loaded" ? loaded.settings : {} };
	};
	const displayThinkingLevel = (settings: BtwSettings): BtwThinkingLevel =>
		clampToAvailableThinkingLevel(settings.thinkingLevel ?? options.currentThinkingLevel, levels);

	const menu = defineMenu<BtwMenuState, BtwMenuScreen, BtwMenuAction, MenuContext>({
		start: "main",
		screens: {
			main: ({ state }) => ({
				kind: "actions",
				title: "Pi BTW",
				lines: [
					`Thinking: ${displayThinkingLevel(state.settings)} · Remember changes: ${effectiveRememberThinkingLevelChanges(state.settings) ? "On" : "Off"}`,
				],
				items: [
					{
						id: "start",
						label: "Start side thread",
						description: "Open an empty side thread",
						action: "start",
					},
					{
						id: "settings",
						label: "Settings",
						description: "Choose pi-btw thinking and whether shortcut changes are remembered",
						to: state.kind === "invalid" ? "invalid" : "settings",
					},
				],
				hint: "close",
			}),
			settings: ({ state }) => ({
				kind: "settings",
				title: "Pi BTW Settings",
				lines: [`User settings · ${displaySettingsPath}`],
				items: [
					{
						id: "thinkingLevel",
						label: "Thinking level",
						description: "Set the starting level for future pi-btw side threads.",
						currentValue: displayThinkingLevel(state.settings),
						values: levels,
						action: "set-thinking",
					},
					{
						id: "rememberThinkingLevelChanges",
						label: "Remember thinking level changes",
						description: "Save side-thread shortcut changes to pi-btw.json for next time.",
						currentValue: effectiveRememberThinkingLevelChanges(state.settings) ? "On" : "Off",
						values: ["On", "Off"],
						action: "set-remember",
					},
				],
			}),
			invalid: ({ state }) => ({
				kind: "detail",
				title: "Pi BTW Settings · Read only",
				lines: [
					`Invalid settings file. Fix ${displaySettingsPath} before saving.`,
					sanitizeSingleLine(state.reason ?? "The settings file is invalid."),
				],
				hint: "back",
			}),
		},
		actions: {
			start: async () => {
				startSelected = true;
				return { kind: "close" };
			},
			"set-thinking": async ({ value, signal }) => {
				if (!value || !levels.includes(value as BtwThinkingLevel)) return { kind: "rejected" };
				try {
					await updateSettings(
						{ thinkingLevel: value as BtwThinkingLevel },
						{ settingsPath, signal },
					);
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Pi BTW thinking level: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
			"set-remember": async ({ value, signal }) => {
				if (value !== "On" && value !== "Off") return { kind: "rejected" };
				try {
					await updateSettings(
						{ rememberThinkingLevelChanges: value === "On" },
						{ settingsPath, signal },
					);
					if (signal.aborted) return { kind: "rejected" };
					notifySafely(ctx, `Remember thinking level changes: ${value}.`, "info");
					return { kind: "stay" };
				} catch (error) {
					if (!signal.aborted) notifySaveFailure(ctx, error);
					return { kind: "rejected" };
				}
			},
		},
	});

	const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
		runMenu(menuContext, menu, { getState: loadState }),
	);
	return startSelected && result.kind === "closed" && result.reason === "close"
		? "start"
		: "closed";
}

export async function runBtwMenuPreservingEditor(
	ctx: ExtensionCommandContext,
	run: (menuContext: MenuContext) => Promise<RunMenuResult>,
): Promise<RunMenuResult> {
	let liveEditorText = ctx.ui.getEditorText();
	let completed = false;
	const ui = new Proxy(ctx.ui, {
		get(target, property) {
			if (property === "custom") {
				return <Value>(factory: BtwCustomFactory<Value>, customOptions?: BtwCustomOptions) =>
					target.custom<Value>(
						(tui, theme, keybindings, done) =>
							factory(tui, theme, keybindings, (value) => {
								try {
									liveEditorText = target.getEditorText();
								} catch {
									// Keep completion finite if session replacement invalidates the editor context.
								}
								completed = true;
								done(value);
							}),
						customOptions,
					);
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const result = await run({ mode: ctx.mode, hasUI: ctx.hasUI, ui });
	if (result.kind !== "stale" && completed) {
		try {
			if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
		} catch {
			// A replaced context owns a different editor and must not receive stale restoration.
		}
	}
	return result;
}

function clampToAvailableThinkingLevel(
	requested: BtwThinkingLevel,
	available: readonly BtwThinkingLevel[],
): BtwThinkingLevel {
	if (available.includes(requested)) return requested;
	const requestedIndex = BTW_THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < BTW_THINKING_LEVELS.length; index += 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = BTW_THINKING_LEVELS[index];
		if (candidate && available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown): void {
	notifySafely(
		ctx,
		`Pi BTW settings were not saved; the previous value remains active: ${formatError(error)}`,
		"error",
	);
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// A completed save remains valid if its command context was replaced before notification.
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
