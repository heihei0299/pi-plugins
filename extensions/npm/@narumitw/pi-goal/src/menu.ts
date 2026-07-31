import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ActionMenuItem, defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { formatDuration } from "./accounting.js";
import { parseTokenBudget } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import type { ActiveGoal, PendingQueueAction } from "./persistence.js";
import { goalQueueIdentity } from "./queue.js";
import { type GoalRuntime, goalSummary } from "./runtime.js";

export const GOAL_MENU_ACTIONS = {
	start: "Start a goal…",
	startBudget: "Start with token budget…",
	pause: "Pause goal",
	resume: "Resume goal",
	increaseBudget: "Increase budget and resume…",
	edit: "Edit goal…",
	replace: "Replace goal…",
	status: "View full status",
	queue: "Queue…",
	settings: "Settings…",
	help: "Help",
	clear: "Clear goal…",
	close: "Close",
} as const;

const QUEUE_ACTIONS = {
	add: "Add goal…",
	prioritize: "Prioritize goal…",
	skip: "Skip current goal…",
	dropLast: "Drop last goal…",
	back: "Back",
} as const;

interface GoalMenuRuntimeView {
	activeGoal?: ActiveGoal;
	queuedGoals: ActiveGoal[];
	pendingQueueAction?: PendingQueueAction;
	queueFrozen: boolean;
	settings: GoalRuntime["settings"];
	recordGoalUsage?: GoalRuntime["recordGoalUsage"];
	persistGoal?: GoalRuntime["persistGoal"];
	updateStatus?: GoalRuntime["updateStatus"];
}

export interface GoalMenuState {
	title: string;
	actions: string[];
}

type ShowSettings = (ctx: ExtensionCommandContext) => Promise<void>;
type GoalMenuScreen = "main" | "queue" | "status" | "help";
type GoalMenuAction =
	| "start"
	| "start-budget"
	| "pause"
	| "resume"
	| "increase-budget"
	| "edit"
	| "replace"
	| "settings"
	| "clear"
	| "queue-add"
	| "queue-prioritize"
	| "queue-skip"
	| "queue-drop"
	| "back";

export function buildGoalMenuState(runtime: GoalMenuRuntimeView): GoalMenuState {
	const goal = runtime.activeGoal;
	const queueCount = runtime.queuedGoals.length;
	const state = runtime.queueFrozen
		? "Queue frozen"
		: runtime.pendingQueueAction
			? "Waiting for Pi to settle"
			: displayStatus(goal?.status);
	const automaticTurnLimit = runtime.settings.continuationLimits.automaticTurns;
	const automaticResponses =
		automaticTurnLimit === null
			? `${goal?.automaticModelTurns ?? 0} automatic responses · Unlimited`
			: `${goal?.automaticModelTurns ?? 0}/${automaticTurnLimit} automatic responses`;
	const details = goal
		? [
				goal.tokenBudget === undefined
					? formatDuration(goal.timeUsedSeconds)
					: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`,
				automaticResponses,
				...(queueCount > 0 ? [`${queueCount} queued`] : []),
			].join(" · ")
		: "No goal is currently set";
	const title = goal
		? `Goal · ${state}\n${safeGoalMenuText(goal.text)}\n${details}`
		: `Goal · ${state}\n${details}`;

	if (runtime.queueFrozen || runtime.pendingQueueAction) {
		return {
			title,
			actions: [
				GOAL_MENU_ACTIONS.status,
				GOAL_MENU_ACTIONS.settings,
				GOAL_MENU_ACTIONS.help,
				GOAL_MENU_ACTIONS.clear,
				GOAL_MENU_ACTIONS.close,
			],
		};
	}

	const actions: string[] = [];
	if (!goal || goal.status === "complete") {
		actions.push(GOAL_MENU_ACTIONS.start, GOAL_MENU_ACTIONS.startBudget);
	} else if (goal.status === "active") {
		actions.push(GOAL_MENU_ACTIONS.pause);
	} else if (goal.status === "budget_limited") {
		actions.push(GOAL_MENU_ACTIONS.increaseBudget);
	} else {
		actions.push(GOAL_MENU_ACTIONS.resume);
	}
	if (goal && goal.status !== "complete") {
		actions.push(GOAL_MENU_ACTIONS.edit, GOAL_MENU_ACTIONS.replace);
	}
	if (goal) actions.push(GOAL_MENU_ACTIONS.status);
	if (goal && (runtime.settings.experimental.goals || queueCount > 0)) {
		actions.push(GOAL_MENU_ACTIONS.queue);
	}
	actions.push(GOAL_MENU_ACTIONS.settings, GOAL_MENU_ACTIONS.help);
	if (goal) actions.push(GOAL_MENU_ACTIONS.clear);
	actions.push(GOAL_MENU_ACTIONS.close);
	return { title, actions };
}

export async function showGoalManager(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	showSettings: ShowSettings,
): Promise<void> {
	if (ctx.mode !== "tui") {
		commands.showGoal(ctx);
		return;
	}
	const owner = runtime as GoalRuntime;
	const generation = owner.menuGeneration;
	const ownerSignal = owner.menuController?.signal;
	let displayedGoal: ActiveGoal | undefined;
	let displayedQueueHead: ActiveGoal | undefined;
	let displayedQueueFirst: ActiveGoal | undefined;
	let displayedQueueLast: ActiveGoal | undefined;
	const menu = defineMenu<undefined, GoalMenuScreen, GoalMenuAction, ExtensionCommandContext>({
		start: "main",
		screens: {
			main: () => {
				refreshGoalMenuState(runtime, ctx);
				const state = buildGoalMenuState(runtime);
				displayedGoal = runtime.activeGoal;
				return {
					kind: "actions",
					title: "Goal",
					lines: state.title.split("\n").slice(1),
					items: state.actions.map(goalMainMenuItem),
					hint: "close",
				};
			},
			queue: () => {
				displayedQueueHead = runtime.activeGoal;
				displayedQueueFirst = runtime.queuedGoals[0];
				displayedQueueLast = runtime.queuedGoals.at(-1) ?? runtime.activeGoal;
				return {
					kind: "actions",
					title: "Goal queue",
					lines: [
						`${runtime.queuedGoals.length + (runtime.activeGoal ? 1 : 0)} total`,
						...(runtime.activeGoal
							? [`Current: ${safeGoalMenuText(runtime.activeGoal.text)}`]
							: []),
					],
					items: [
						{ id: "add", label: QUEUE_ACTIONS.add, action: "queue-add" },
						{ id: "prioritize", label: QUEUE_ACTIONS.prioritize, action: "queue-prioritize" },
						...(runtime.queuedGoals.length > 0
							? [
									{ id: "skip", label: QUEUE_ACTIONS.skip, action: "queue-skip" as const },
									{
										id: "drop-last",
										label: QUEUE_ACTIONS.dropLast,
										action: "queue-drop" as const,
									},
								]
							: []),
						{ id: "back", label: QUEUE_ACTIONS.back, action: "back" },
					],
					hint: "back",
				};
			},
			status: () => ({
				kind: "detail",
				title: "Goal status",
				lines: runtime.activeGoal
					? goalSummary(
							runtime.activeGoal,
							runtime.queuedGoals,
							runtime.settings.experimental.goals,
							runtime.queueFrozen,
							runtime.pendingQueueAction,
						).split("\n")
					: ["No goal is currently set."],
				hint: "back",
			}),
			help: () => ({
				kind: "detail",
				title: "Goal help",
				lines: goalHelp().split("\n").slice(1),
				hint: "back",
			}),
		},
		actions: {
			start: async () => {
				await startFromMenu(commands, ctx);
				return { kind: "close" };
			},
			"start-budget": async () => {
				await startFromMenu(commands, ctx, true);
				return { kind: "close" };
			},
			pause: async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				commands.pauseGoal(ctx);
				return { kind: "close" };
			},
			resume: async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				await commands.resumeGoal(ctx);
				return { kind: "close" };
			},
			"increase-budget": async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				await increaseBudget(runtime, commands, ctx);
				return { kind: "close" };
			},
			edit: async () => {
				if (!displayedGoal || !requireCurrentMenuGoal(runtime, displayedGoal, ctx)) {
					return { kind: "stay" };
				}
				await editFromMenu(runtime, commands, ctx);
				return { kind: "close" };
			},
			replace: async () => {
				await startFromMenu(commands, ctx);
				return { kind: "close" };
			},
			settings: async () => {
				await showSettings(ctx);
				return { kind: "stay" };
			},
			clear: async () => {
				const previewedQueue = goalQueueIdentity(
					runtime.activeGoal,
					runtime.queuedGoals,
					runtime.pendingQueueAction,
				);
				if (!(await confirmClear(runtime, ctx))) return { kind: "stay" };
				if (
					goalQueueIdentity(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction) !==
					previewedQueue
				) {
					ctx.ui.notify(
						"The goal queue changed while the dialog was open. Reopen /goal and try again.",
						"warning",
					);
					return { kind: "stay" };
				}
				commands.clearGoal(ctx);
				return { kind: "close" };
			},
			"queue-add": async () => {
				const objective = (await ctx.ui.editor("Add goal to queue", ""))?.trim();
				if (objective) await commands.addGoal(objective, undefined, ctx);
				return { kind: "close" };
			},
			"queue-prioritize": async () => {
				const goal = displayedQueueHead;
				if (!goal) return { kind: "stay" };
				const objective = (await ctx.ui.editor("Prioritize goal", ""))?.trim();
				if (!objective || !requireCurrentQueueHead(runtime, goal, ctx)) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"Prioritize goal?",
					`New priority goal:\n${safeGoalMenuText(objective, 4_000)}\n\nCurrent goal moved to the queue:\n${safeGoalMenuText(goal.text, 4_000)}`,
				);
				if (confirmed && requireCurrentQueueHead(runtime, goal, ctx)) {
					await commands.prioritizeGoal(objective, undefined, ctx);
				}
				return { kind: "close" };
			},
			"queue-skip": async () => {
				const goal = displayedQueueHead;
				if (!goal) return { kind: "stay" };
				const next = displayedQueueFirst;
				const nextEffect = !next
					? "No goal remains"
					: next.status === "queued"
						? `Start next goal:\n${safeGoalMenuText(next.text, 4_000)}`
						: `Next goal remains ${displayStatus(next.status).toLowerCase()}:\n${safeGoalMenuText(next.text, 4_000)}`;
				const confirmed = await ctx.ui.confirm(
					"Skip current goal?",
					`Remove current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\n${nextEffect}`,
				);
				if (confirmed && requireCurrentQueueSelection(runtime, goal, next, "first", ctx)) {
					await commands.skipGoal(ctx);
				}
				return { kind: "close" };
			},
			"queue-drop": async () => {
				const goal = displayedQueueHead;
				const last = displayedQueueLast;
				if (!goal || !last) return { kind: "stay" };
				const confirmed = await ctx.ui.confirm(
					"Drop last goal?",
					`Remove from queue:\n${safeGoalMenuText(last.text, 4_000)}`,
				);
				if (confirmed && requireCurrentQueueSelection(runtime, goal, last, "last", ctx)) {
					commands.dropLastGoal(ctx);
				}
				return { kind: "close" };
			},
			back: async () => ({ kind: "back" }),
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: ownerSignal,
		isCurrent: () =>
			owner.menuController === undefined ||
			(generation === owner.menuGeneration && !owner.menuController.signal.aborted),
	});
}

function goalMainMenuItem(label: string): ActionMenuItem<GoalMenuScreen, GoalMenuAction> {
	if (label === GOAL_MENU_ACTIONS.status) return { id: "status", label, to: "status" as const };
	if (label === GOAL_MENU_ACTIONS.queue) return { id: "queue", label, to: "queue" as const };
	if (label === GOAL_MENU_ACTIONS.help) return { id: "help", label, to: "help" as const };
	if (label === GOAL_MENU_ACTIONS.close) return { id: "close", label, close: true as const };
	const actions = new Map<string, GoalMenuAction>([
		[GOAL_MENU_ACTIONS.start, "start"],
		[GOAL_MENU_ACTIONS.startBudget, "start-budget"],
		[GOAL_MENU_ACTIONS.pause, "pause"],
		[GOAL_MENU_ACTIONS.resume, "resume"],
		[GOAL_MENU_ACTIONS.increaseBudget, "increase-budget"],
		[GOAL_MENU_ACTIONS.edit, "edit"],
		[GOAL_MENU_ACTIONS.replace, "replace"],
		[GOAL_MENU_ACTIONS.settings, "settings"],
		[GOAL_MENU_ACTIONS.clear, "clear"],
	]);
	return { id: actions.get(label) ?? label, label, action: actions.get(label) ?? "settings" };
}

function refreshGoalMenuState(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goal = runtime.activeGoal;
	if (!goal || runtime.queueFrozen) return;
	runtime.recordGoalUsage?.(goal, ctx);
	runtime.persistGoal?.(goal);
	runtime.updateStatus?.(ctx, goal);
}

export function safeGoalMenuText(value: string, maxCharacters = 120) {
	const sanitized = [...value]
		.map((character) => (isTerminalControl(character) ? " " : character))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...sanitized];
	return characters.length <= maxCharacters
		? sanitized
		: `${characters.slice(0, maxCharacters).join("")}…`;
}

async function startFromMenu(
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	withBudget = false,
) {
	const objective = (await ctx.ui.editor("Goal objective", ""))?.trim();
	if (!objective) return;
	const tokenBudget = withBudget ? await askTokenBudget(ctx) : undefined;
	if (withBudget && tokenBudget === undefined) return;
	await commands.startGoal(objective, tokenBudget, ctx);
}

async function editFromMenu(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
) {
	const goal = runtime.activeGoal;
	if (!goal) return;
	const objective = (await ctx.ui.editor("Edit goal objective", goal.text))?.trim();
	if (!objective || objective === goal.text) return;
	if (!requireCurrentMenuGoal(runtime, goal, ctx)) return;
	if (goal.status === "active") {
		const confirmed = await ctx.ui.confirm(
			"Apply goal edit?",
			`Current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\nUpdated goal:\n${safeGoalMenuText(objective, 4_000)}\n\nApplying this edit starts a new guarded goal instance.`,
		);
		if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	}
	await commands.editGoal(objective, undefined, ctx);
}

async function increaseBudget(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
) {
	const goal = runtime.activeGoal;
	if (!goal) return;
	const budget = await askTokenBudget(ctx, goal.tokenBudget);
	if (budget === undefined || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	if (budget <= goal.tokensUsed) {
		ctx.ui.notify(
			`Token budget must be greater than current usage (${formatTokenCount(goal.tokensUsed)}).`,
			"warning",
		);
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Increase goal budget?",
		`Goal: ${safeGoalMenuText(goal.text, 4_000)}\n\nBudget: ${formatTokenCount(goal.tokenBudget ?? 0)} → ${formatTokenCount(budget)}\nCurrent usage: ${formatTokenCount(goal.tokensUsed)}\n\nThe goal will resume immediately.`,
	);
	if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
	await commands.editGoal(goal.text, budget, ctx);
}

async function askTokenBudget(ctx: ExtensionCommandContext, current?: number) {
	const raw = await ctx.ui.input(
		"Token budget",
		current === undefined ? "100k" : formatTokenCount(current),
	);
	if (raw === undefined) return undefined;
	const budget = parseTokenBudget(raw);
	if (budget === undefined)
		ctx.ui.notify(`Invalid token budget: ${safeGoalMenuText(raw)}`, "warning");
	return budget;
}

async function confirmClear(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goals = [runtime.activeGoal, ...runtime.queuedGoals].filter(
		(goal): goal is ActiveGoal => goal !== undefined,
	);
	const pendingPriority =
		runtime.pendingQueueAction?.kind === "prioritize"
			? runtime.pendingQueueAction.objective
			: undefined;
	const summaries = [
		...goals.map((goal) => safeGoalMenuText(goal.text, 4_000)),
		...(pendingPriority ? [`Pending priority: ${safeGoalMenuText(pendingPriority, 4_000)}`] : []),
	];
	if (summaries.length === 0) return false;
	return ctx.ui.confirm(
		summaries.length > 1 ? "Clear goal queue?" : "Clear goal?",
		`Remove ${summaries.length === 1 ? "this goal" : `all ${summaries.length} goals`}:\n\n${summaries
			.map((summary, index) => `${index + 1}. ${summary}`)
			.join("\n")}\n\nThis cannot be undone.`,
	);
}

function requireCurrentQueueHead(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	ctx: ExtensionCommandContext,
) {
	if (runtime.activeGoal?.id === expectedGoal.id) return true;
	ctx.ui.notify(
		"The goal queue changed while the dialog was open. Reopen /goal and try again.",
		"warning",
	);
	return false;
}

function requireCurrentQueueSelection(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	expectedQueuedGoal: ActiveGoal | undefined,
	position: "first" | "last",
	ctx: ExtensionCommandContext,
) {
	const currentQueuedGoal =
		position === "first"
			? runtime.queuedGoals[0]
			: (runtime.queuedGoals.at(-1) ?? runtime.activeGoal);
	if (
		runtime.activeGoal?.id === expectedGoal.id &&
		currentQueuedGoal?.id === expectedQueuedGoal?.id
	) {
		return true;
	}
	ctx.ui.notify(
		"The goal queue changed while the dialog was open. Reopen /goal and try again.",
		"warning",
	);
	return false;
}

function requireCurrentMenuGoal(
	runtime: GoalMenuRuntimeView,
	expected: ActiveGoal,
	ctx: ExtensionCommandContext,
) {
	if (runtime.activeGoal?.id === expected.id) return true;
	ctx.ui.notify(
		"The active goal changed while the dialog was open. Reopen /goal and try again.",
		"warning",
	);
	return false;
}

function displayStatus(status?: ActiveGoal["status"]) {
	if (!status) return "No goal";
	if (status === "usage_limited") return "Usage limited";
	if (status === "budget_limited") return "Budget limited";
	return status[0]?.toUpperCase() + status.slice(1);
}

function formatTokenCount(tokens: number) {
	return String(tokens);
}

function isTerminalControl(character: string) {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function goalHelp() {
	return [
		"Goal menu",
		"Use the menu for guided status, edits, queue management, settings, and confirmations.",
		"Direct routes remain available for deterministic workflows:",
		"/goal <objective>",
		"/goal status | pause | resume | edit | clear",
		"/goal --tokens 100k <objective>",
		"Escape cancels the current menu or input without changing goal state.",
	].join("\n");
}
