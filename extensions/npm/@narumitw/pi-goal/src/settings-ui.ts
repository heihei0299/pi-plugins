import { join } from "node:path";
import {
	type ExtensionCommandContext,
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { checkpointGoalActiveTime } from "./accounting.js";
import { abortCurrentTurn, type GoalRuntime, STATUS_KEY } from "./runtime.js";
import {
	DEFAULT_GOAL_SETTINGS,
	GOAL_SETTINGS_FILE,
	type GoalSettings,
	saveGoalSettings,
} from "./settings.js";

interface GoalSettingsUiOptions {
	settingsPath?: string;
	save?: (settings: GoalSettings, settingsPath: string) => void;
	onQueueUnfrozen?: (ctx: ExtensionCommandContext) => Promise<void>;
}

interface GoalSettingsApplyOptions {
	save?: (settings: GoalSettings) => void;
}

type LimitField = "automaticTurns" | "noProgressTurns";
type LimitSelection = "unlimited" | "default" | "custom" | "off";
type SettingsScreenResult =
	| {
			kind: "limit";
			field: LimitField;
			selection: LimitSelection;
			activeGoalId: string | null;
	  }
	| { kind: "queue"; enabled: boolean }
	| undefined;

interface LimitChoiceStyles {
	title: (text: string) => string;
	muted: (text: string) => string;
}

type EnqueueSettingsChange = (operation: () => void | Promise<void>) => Promise<void>;

export async function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions = {},
) {
	const settingsPath = options.settingsPath ?? join(getAgentDir(), GOAL_SETTINGS_FILE);
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Edit pi-goal settings manually: ${safeTerminalText(settingsPath)}`, "info");
		return;
	}

	while (true) {
		const result = await showSettingsScreen(runtime, ctx, settingsPath, options);
		if (!result) return;
		if (result.kind === "queue") {
			const next = await nextQueueSettings(runtime, ctx, result.enabled);
			if (!next) continue;
			const wasFrozen = runtime.queueFrozen;
			try {
				applyGoalSettings(runtime, next, ctx, {
					save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
				});
				if (wasFrozen && !runtime.queueFrozen) {
					try {
						await options.onQueueUnfrozen?.(ctx);
					} catch (error) {
						ctx.ui.notify(
							`Goal queue enabled, but automatic resume failed: ${safeTerminalText(formatError(error))}. Reopen /goal to retry.`,
							"warning",
						);
					}
				}
				ctx.ui.notify(`Ordered goal queue: ${result.enabled ? "Experimental" : "Off"}.`, "info");
			} catch (error) {
				notifySettingsFailure(ctx, settingsPath, error);
			}
			return;
		}

		if ((runtime.activeGoal?.id ?? null) !== result.activeGoalId) {
			ctx.ui.notify(
				"The active goal changed while the safety setting was open. No settings were changed.",
				"warning",
			);
			continue;
		}
		const previous = runtime.settings.continuationLimits[result.field];
		const limit = await resolveLimitSelection(result, previous, ctx);
		if (limit === undefined || limit === previous) continue;
		if ((runtime.activeGoal?.id ?? null) !== result.activeGoalId) {
			ctx.ui.notify(
				"The active goal changed while editing the safety setting. No settings were changed.",
				"warning",
			);
			continue;
		}
		const confirmation = await confirmLowerActiveLimit(runtime, ctx, result.field, limit);
		if (!confirmation.apply) continue;
		if (confirmation.goalId !== undefined && runtime.activeGoal?.id !== confirmation.goalId) {
			ctx.ui.notify(
				"The active goal changed while confirming the limit. No settings were changed.",
				"warning",
			);
			continue;
		}
		const next = withLimit(runtime.settings, result.field, limit);
		try {
			applyGoalSettings(runtime, next, ctx, {
				save: (settings) => (options.save ?? saveGoalSettings)(settings, settingsPath),
			});
			ctx.ui.notify(formatLimitSuccess(result.field, limit), "info");
		} catch (error) {
			notifySettingsFailure(ctx, settingsPath, error);
		}
	}
}

export function applyGoalSettings(
	runtime: GoalRuntime,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
	options: GoalSettingsApplyOptions = {},
) {
	const snapshot = runtime.snapshotSettingsApplicationState();
	let fileSaved = false;
	try {
		runtime.settings = structuredClone(next);
		applyToolVisibility(runtime, snapshot.settings, next, ctx);
		options.save?.(next);
		fileSaved = options.save !== undefined;
		applyQueueSetting(runtime, ctx);
		const activeGoalId = runtime.activeGoal?.id;
		const abortOwnedRun = activeGoalId !== undefined && runtime.agentRunGoalId === activeGoalId;
		const pausedByAutomaticLimit = runtime.enforceAutomaticTurnLimit(ctx, abortOwnedRun);
		if (!pausedByAutomaticLimit) runtime.enforceNoProgressLimit(ctx, abortOwnedRun);
	} catch (error) {
		const rollbackErrors: unknown[] = [];
		try {
			runtime.restoreSettingsApplicationState(snapshot);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (fileSaved) {
			try {
				options.save?.(snapshot.settings);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			try {
				restorePersistedRuntime(runtime, ctx);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`pi-goal settings application failed and rollback was incomplete: ${formatError(error)}`,
			);
		}
		throw error;
	}
}

export function parseGoalLimit(value: string): number | undefined {
	const normalized = value.trim();
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatGoalLimit(value: number | null) {
	return value === null ? "Unlimited" : String(value);
}

async function showSettingsScreen(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	settingsPath: string,
	options: GoalSettingsUiOptions,
): Promise<SettingsScreenResult> {
	if (runtime.settingsLoadIssue?.kind === "invalid") {
		return showReadOnlySettingsScreen(runtime, ctx, settingsPath);
	}

	let saveQueue = Promise.resolve();
	const enqueueSettingsChange: EnqueueSettingsChange = (operation) => {
		const queued = saveQueue.then(operation);
		saveQueue = queued.catch(() => undefined);
		return queued;
	};
	return ctx.ui.custom<SettingsScreenResult>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(
			dynamicText("Pi Goal Settings", (text) => theme.fg("accent", theme.bold(text))),
		);
		container.addChild(
			dynamicText(`User settings · ${safeTerminalText(settingsPath)}`, (text) =>
				theme.fg("muted", text),
			),
		);
		let closing = false;
		const closeAfterSaves = (result: SettingsScreenResult) => {
			if (closing) return;
			closing = true;
			void saveQueue.then(() => done(result));
		};
		const requestRender = () => tui.requestRender();
		const previewGoalIds = new Map<LimitField, string | null>();
		const styles: LimitChoiceStyles = {
			title: (text) => theme.fg("accent", theme.bold(text)),
			muted: (text) => theme.fg("muted", text),
		};
		let limitChoiceOpen = false;
		const items: SettingItem[] = [
			limitItem(
				"automaticTurns",
				"Automatic work",
				"Choose whether Goal can continue without a response-count cap.",
				runtime.settings.continuationLimits.automaticTurns,
				(doneSelection) => {
					previewGoalIds.set("automaticTurns", runtime.activeGoal?.id ?? null);
					limitChoiceOpen = true;
					return createLimitChoiceComponent(runtime, "automaticTurns", styles, (selection) => {
						limitChoiceOpen = false;
						doneSelection(selection);
					});
				},
			),
			limitItem(
				"noProgressTurns",
				"No-progress guard",
				"Pause after repeated or empty tool-free automatic runs.",
				runtime.settings.continuationLimits.noProgressTurns,
				(doneSelection) => {
					previewGoalIds.set("noProgressTurns", runtime.activeGoal?.id ?? null);
					limitChoiceOpen = true;
					return createLimitChoiceComponent(runtime, "noProgressTurns", styles, (selection) => {
						limitChoiceOpen = false;
						doneSelection(selection);
					});
				},
			),
			{
				id: "toolVisibility",
				label: "Goal tools",
				description: "Keep terminal Goal tools visible, or reveal them after the first goal.",
				currentValue: visibilityLabel(runtime.settings.toolVisibility),
				values: ["Always", "After first goal"],
			},
			{
				id: "experimentalGoals",
				label: "Ordered goal queue",
				description: "Enable experimental add, prioritize, skip, and drop-last workflows.",
				currentValue: runtime.settings.experimental.goals ? "Experimental" : "Off",
				values: ["Off", "Experimental"],
			},
		];
		const latestRequested = new Map<string, string>();
		let settingsList: SettingsList;
		settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			goalSettingsListTheme("Goal menu"),
			(id, newValue) => {
				if (closing) return;
				if (id === "automaticTurns" || id === "noProgressTurns") {
					if (!isLimitSelection(newValue)) return;
					closeAfterSaves({
						kind: "limit",
						field: id,
						selection: newValue,
						activeGoalId: previewGoalIds.get(id) ?? null,
					});
					return;
				}
				if (id === "experimentalGoals") {
					closeAfterSaves({ kind: "queue", enabled: newValue === "Experimental" });
					return;
				}
				if (id !== "toolVisibility") return;
				latestRequested.set(id, newValue);
				void enqueueSettingsChange(async () => {
					const previousValue = visibilityLabel(runtime.settings.toolVisibility);
					try {
						const next = {
							...structuredClone(runtime.settings),
							toolVisibility: newValue === "Always" ? "always" : "after-first-goal",
						} satisfies GoalSettings;
						applyGoalSettings(runtime, next, ctx, {
							save: (value) => (options.save ?? saveGoalSettings)(value, settingsPath),
						});
						requestRender();
						ctx.ui.notify(`Goal tools: ${newValue}.`, "info");
					} catch (error) {
						if (latestRequested.get(id) === newValue) {
							settingsList.updateValue(id, previousValue);
						}
						notifySettingsFailure(ctx, settingsPath, error);
					}
				});
			},
			() => closeAfterSaves(undefined),
			{ enableSearch: false },
		);
		container.addChild(goalSettingsListComponent(settingsList, () => limitChoiceOpen));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (closing) return;
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function showReadOnlySettingsScreen(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	settingsPath: string,
): Promise<SettingsScreenResult> {
	return ctx.ui.custom<SettingsScreenResult>((_tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(
			dynamicText("Pi Goal Settings · Read only", (text) => theme.fg("accent", theme.bold(text))),
		);
		container.addChild(
			dynamicText(
				`Invalid settings file. Pi-goal is using built-in defaults. Fix ${safeTerminalText(settingsPath)} and run /reload. The file will not be overwritten.`,
				(text) => theme.fg("warning", text),
			),
		);
		container.addChild(
			dynamicText(() =>
				[
					`Automatic work: ${formatAutomaticWork(runtime.settings.continuationLimits.automaticTurns)}`,
					`No-progress guard: ${formatNoProgressProtection(runtime.settings.continuationLimits.noProgressTurns)}`,
					`Goal tools: ${visibilityLabel(runtime.settings.toolVisibility)}`,
					`Ordered goal queue: ${runtime.settings.experimental.goals ? "Experimental" : "Off"}`,
				].join("\n"),
			),
		);
		container.addChild(dynamicText("Esc back to Goal menu", (text) => theme.fg("dim", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.cancel") ||
					matchesKey(data, "escape") ||
					matchesKey(data, "ctrl+c")
				) {
					done(undefined);
				}
			},
		};
	});
}

function createLimitChoiceComponent(
	runtime: GoalRuntime,
	field: LimitField,
	styles: LimitChoiceStyles,
	done: (selectedValue?: string) => void,
): Component {
	const value = runtime.settings.continuationLimits[field];
	const goal = runtime.activeGoal;
	const items = limitChoices(field, value, goal?.automaticModelTurns);
	const selectionItems = items.map(({ value: itemValue, label }) => ({
		value: itemValue,
		label,
	}));
	const descriptions = new Map(items.map((item) => [item.value, item.description ?? ""]));
	const container = new Container();
	container.addChild(
		dynamicText(field === "automaticTurns" ? "Automatic work" : "No-progress guard", styles.title),
	);
	container.addChild(
		dynamicText(
			field === "automaticTurns"
				? `Current: ${formatAutomaticWork(value)}`
				: `Current: ${formatNoProgressProtection(value)}`,
			styles.muted,
		),
	);
	if (goal) {
		container.addChild(
			dynamicText(
				field === "automaticTurns"
					? `Active goal: ${goal.automaticModelTurns} automatic responses used`
					: `Active goal: ${goal.toolFreeRepeatCount} repeated or empty runs detected`,
				styles.muted,
			),
		);
	}
	const selectedIndex = selectedLimitChoiceIndex(field, value);
	const selectList = new SelectList(
		selectionItems,
		Math.min(selectionItems.length, 8),
		getSelectListTheme(),
	);
	selectList.setSelectedIndex(selectedIndex);
	let selectedDescription = descriptions.get(selectionItems[selectedIndex]?.value ?? "") ?? "";
	const description = dynamicText(() => selectedDescription, styles.muted);
	selectList.onSelectionChange = (item) => {
		selectedDescription = descriptions.get(item.value) ?? "";
	};
	selectList.onSelect = (item) => done(item.value);
	selectList.onCancel = () => done();
	container.addChild(selectList);
	container.addChild(description);
	container.addChild(dynamicText("↑↓ navigate · Enter select · Esc back", styles.muted));
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput(data: string) {
			selectList.handleInput(data);
		},
	};
}

function limitChoices(
	field: LimitField,
	value: number | null,
	automaticTurnsUsed: number | undefined,
): SelectItem[] {
	if (field === "automaticTurns") {
		const unlimitedDescription =
			value === null
				? "No response-count cap. Completion, manual pause, blockers, provider limits, and other configured guards still apply."
				: automaticTurnsUsed === undefined
					? `Remove the current ${value}-response cap. Goal work will have no response-count cap; other configured stop conditions remain.`
					: `Remove the current ${value}-response cap. The active goal has used ${automaticTurnsUsed} responses; other configured stop conditions remain.`;
		return [
			{ value: "unlimited", label: "Unlimited (default)", description: unlimitedDescription },
			{
				value: "custom",
				label: "Set a maximum…",
				description: "Pause after a whole number of Goal-owned automatic responses.",
			},
		];
	}
	const defaultLimit = DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;
	return [
		{
			value: "default",
			label: `After ${defaultLimit} repeated runs (default)`,
			description: "Pause after the default number of repeated or empty tool-free runs.",
		},
		{
			value: "custom",
			label: "Set threshold…",
			description: "Choose a whole number of repeated or empty runs before pausing.",
		},
		{
			value: "off",
			label: "Off",
			description: "Do not pause based on repeated or empty tool-free runs.",
		},
	];
}

function selectedLimitChoiceIndex(field: LimitField, value: number | null) {
	if (field === "automaticTurns") return value === null ? 0 : 1;
	if (value === null) return 2;
	return value === DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns ? 0 : 1;
}

async function resolveLimitSelection(
	result: Extract<SettingsScreenResult, { kind: "limit" }>,
	previous: number | null,
	ctx: ExtensionCommandContext,
): Promise<number | null | undefined> {
	if (result.selection === "unlimited" || result.selection === "off") return null;
	if (result.selection === "default") {
		return DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;
	}
	while (true) {
		const raw = await ctx.ui.input(
			result.field === "automaticTurns"
				? "Maximum automatic responses (whole number greater than 0)"
				: "Repeated-run threshold (whole number greater than 0)",
			previous === null ? "Positive whole number" : String(previous),
		);
		if (raw === undefined) return undefined;
		const parsed = parseGoalLimit(raw);
		if (parsed !== undefined) return parsed;
		ctx.ui.notify(
			`Enter a whole number greater than 0. Choose ${result.field === "automaticTurns" ? "Unlimited" : "Off"} from the previous screen if you do not want a limit.`,
			"warning",
		);
	}
}

async function nextQueueSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	enabled: boolean,
) {
	if (runtime.settings.experimental.goals === enabled) return undefined;
	if (enabled && !runtime.settings.experimental.goals) {
		const confirmed = await ctx.ui.confirm(
			"Enable experimental goal queue?",
			"Queue behavior and persisted state may change between releases. Existing single-goal behavior remains available.",
		);
		if (!confirmed) return undefined;
	}
	if (
		!enabled &&
		(runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined) &&
		!(await ctx.ui.confirm(
			"Freeze ordered goal queue?",
			`Disabling the experiment preserves ${retainedGoalCount(runtime)} goal(s) but freezes automatic work until the setting is re-enabled. No goal data will be deleted.`,
		))
	) {
		return undefined;
	}
	return {
		...structuredClone(runtime.settings),
		experimental: { goals: enabled },
	} satisfies GoalSettings;
}

function applyToolVisibility(
	runtime: GoalRuntime,
	previous: GoalSettings,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
) {
	if (previous.toolVisibility === next.toolVisibility) return;
	if (next.toolVisibility === "always") {
		if (runtime.goalToolsHiddenByPolicy.size > 0 && ctx.isIdle() !== true) {
			throw new Error("Wait for Pi to become idle before revealing Goal tools.");
		}
		runtime.restoreGoalToolsHiddenByPolicy();
		runtime.goalToolsUnlocked = true;
		return;
	}
	if (runtime.activeGoal) {
		runtime.goalToolsUnlocked = true;
		runtime.goalToolsHiddenByPolicy.clear();
		return;
	}
	if (ctx.isIdle() !== true) {
		throw new Error("Wait for Pi to become idle before hiding Goal tools.");
	}
	runtime.goalToolsUnlocked = false;
	runtime.hideGoalToolsIfLocked();
}

function applyQueueSetting(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	const hasQueueState = runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined;
	const shouldFreeze = !runtime.settings.experimental.goals && hasQueueState;
	// Keep the freeze guard until the aborted Goal-owned run reaches agent_settled.
	// Releasing it earlier lets the old agent_end pause newly resumed work.
	if (runtime.queueFrozen && !shouldFreeze && runtime.queueFreezeAwaitingSettle) return;
	if (runtime.queueFrozen === shouldFreeze) return;
	const activeGoal = runtime.activeGoal?.status === "active" ? runtime.activeGoal : undefined;
	const goalOwnedRun = activeGoal && runtime.agentRunGoalId === activeGoal.id;
	if (shouldFreeze && activeGoal) {
		if (goalOwnedRun) runtime.recordGoalUsage(activeGoal, ctx, false);
		else {
			const now = Date.now();
			checkpointGoalActiveTime(activeGoal, now, false);
			activeGoal.updatedAt = now;
		}
	}
	runtime.queueFrozen = shouldFreeze;
	if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
	if (shouldFreeze) ctx.ui.setStatus(STATUS_KEY, "queue off");
	else if (runtime.activeGoal) runtime.updateStatus(ctx, runtime.activeGoal);
	else ctx.ui.setStatus(STATUS_KEY, undefined);
	if (!shouldFreeze) return;

	runtime.cancelContinuationWork();
	runtime.clearGoalRecovery();
	runtime.clearBudgetWrapUp();
	if (goalOwnedRun) {
		runtime.blockStaleGoalToolCalls();
		runtime.guardAbortGoalId = activeGoal.id;
		runtime.queueFreezeAwaitingSettle = true;
		runtime.clearAgentRun();
		abortCurrentTurn(ctx);
	}
}

function restorePersistedRuntime(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	if (runtime.activeGoal) {
		runtime.persistGoal(runtime.activeGoal);
		if (runtime.queueFrozen) ctx.ui.setStatus(STATUS_KEY, "queue off");
		else runtime.updateStatus(ctx, runtime.activeGoal);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function confirmLowerActiveLimit(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	field: LimitField,
	limit: number | null,
) {
	const goal = runtime.activeGoal;
	if (goal?.status !== "active" || limit === null) return { apply: true };
	const used = field === "automaticTurns" ? goal.automaticModelTurns : goal.toolFreeRepeatCount;
	if (used < limit) return { apply: true };
	return {
		apply: await ctx.ui.confirm(
			"Apply limit and pause now?",
			`The active goal has already used ${used}. Setting this limit to ${limit} will pause it immediately without deleting progress.`,
		),
		goalId: goal.id,
	};
}

function withLimit(settings: GoalSettings, field: LimitField, value: number | null): GoalSettings {
	return {
		...structuredClone(settings),
		continuationLimits: { ...settings.continuationLimits, [field]: value },
	};
}

function limitItem(
	id: LimitField,
	label: string,
	description: string,
	value: number | null,
	submenu: (done: (selectedValue?: string) => void) => Component,
): SettingItem {
	return {
		id,
		label,
		description,
		currentValue:
			id === "automaticTurns"
				? formatAutomaticSettingValue(value)
				: formatNoProgressSettingValue(value),
		submenu: (_currentValue, done) => submenu(done),
	};
}

function formatAutomaticSettingValue(value: number | null) {
	return value === null ? "Unlimited" : `≤${value}`;
}

function formatNoProgressSettingValue(value: number | null) {
	if (value === null) return "Off";
	return `${value} ${value === 1 ? "run" : "runs"}`;
}

function formatAutomaticWork(value: number | null) {
	return value === null ? "Unlimited" : `Up to ${value} responses`;
}

function formatNoProgressProtection(value: number | null) {
	if (value === null) return "Off";
	return `After ${value} repeated ${value === 1 ? "run" : "runs"}`;
}

function formatLimitSuccess(field: LimitField, value: number | null) {
	return field === "automaticTurns"
		? `Automatic work: ${formatAutomaticWork(value)}.`
		: `No-progress guard: ${formatNoProgressProtection(value)}.`;
}

function goalSettingsListTheme(backTarget: string) {
	const theme = getSettingsListTheme();
	return {
		...theme,
		hint(text: string) {
			return text.includes("Enter/Space to change")
				? theme.hint(`  Enter/Space to select · Esc back to ${backTarget}`)
				: theme.hint(text);
		},
	};
}

function isLimitSelection(value: string): value is LimitSelection {
	return value === "unlimited" || value === "default" || value === "custom" || value === "off";
}

function visibilityLabel(value: GoalSettings["toolVisibility"]) {
	return value === "always" ? "Always" : "After first goal";
}

function retainedGoalCount(runtime: GoalRuntime) {
	return (
		(runtime.activeGoal ? 1 : 0) +
		runtime.queuedGoals.length +
		(runtime.pendingQueueAction?.kind === "prioritize" ? 1 : 0)
	);
}

function notifySettingsFailure(ctx: ExtensionCommandContext, settingsPath: string, error: unknown) {
	const path = safeTerminalText(settingsPath);
	const detail = safeTerminalText(formatError(error));
	ctx.ui.notify(
		error instanceof AggregateError
			? `Could not apply Goal settings, and rollback was incomplete. Check ${path}, run /reload, and verify the effective settings before retrying: ${detail}`
			: `Could not save Goal settings; the previous value remains. Check ${path} and retry: ${detail}`,
		"error",
	);
}

function goalSettingsListComponent(
	settingsList: SettingsList,
	isLimitChoiceOpen: () => boolean,
): Component {
	return {
		render(width: number) {
			// Reclaim one of SettingsList's two trailing cells so a safe 16-digit cap stays exact at 40 columns.
			const renderWidth = isLimitChoiceOpen() ? width : width + 1;
			return settingsList.render(renderWidth).map((line) => truncateToWidth(line, width, ""));
		},
		invalidate: () => settingsList.invalidate(),
	};
}

function dynamicText(
	content: string | (() => string),
	style: (text: string) => string = (text) => text,
): Component {
	return {
		render(width: number) {
			const value = typeof content === "function" ? content() : content;
			return new Text(style(value), 1, 0).render(width);
		},
		invalidate() {},
	};
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
