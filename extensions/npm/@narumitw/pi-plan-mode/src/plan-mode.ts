import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { showActiveImplementationMenu } from "./active-implementation-menu.js";
import { completePlanArguments } from "./command.js";
import {
	normalizePlanModeCompletion,
	PLAN_MODE_COMPLETE_PARAMS,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	planModeCompleted,
	renderPlanModeCompletion,
} from "./completion-tool.js";
import {
	isStaleExtensionContextError,
	onAgentSettled,
	setPlanThinkingLevel,
} from "./extension-runtime.js";
import {
	injectActiveImplementationContext,
	invalidPlanMessage,
	isEmptyAssistantMessage,
	latestAssistantText,
	messageContainsInactivePlanModeArtifact,
	messageContainsLegacyPlanModeContextArtifact,
	messageContainsPlanModeImplementationContextArtifact,
	messageContainsPlanModeImplementationHandoff,
	parseProposedPlan,
	stripPlanModeCompletionCallsFromMessage,
	stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
import {
	clearPlanModeUi,
	planModeStatusText as formatPlanModeStatusText,
	updatePlanModeUi,
} from "./presentation.js";
import { buildPlanModePrompt } from "./prompt.js";
import {
	answerPlanModeQuestions,
	normalizePlanModeQuestionParams,
	PLAN_MODE_QUESTION_PARAMS,
	PLAN_MODE_QUESTION_TOOL_NAME,
	planModeQuestionCancelled,
} from "./question-tool.js";
import { withoutRequiredPlanModeTools, withRequiredPlanModeTools } from "./required-tools.js";
import {
	configuredThinkingLevel,
	type PlanModeSettings,
	readPlanModeSettings,
} from "./settings.js";
import { type PlanCompletionSource, type PlanModeState, restorePlanModeState } from "./state.js";
import { enforcePlanSubagentAllowlist } from "./subagent-policy.js";
import {
	canSelectToolInPlanMode,
	classifyPlanModeTool,
	isBuiltinTool,
	isSafeCommand,
	readCommand,
	SAFE_BUILTIN_PLAN_TOOLS,
} from "./tool-policy.js";
import { compareTools, toolNameFromLegacyKey, toolPolicyLabel, unique } from "./tool-selection.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const TOOL_SELECTOR_VIEWPORT_SIZE = 10;

interface ReadyPresentationIntent {
	nonce: number;
	plan: string;
	source: PlanCompletionSource;
}

export default function planMode(
	pi: ExtensionAPI,
	dependencies: { readSettings?(): ReturnType<typeof readPlanModeSettings> } = {},
) {
	let state: PlanModeState = { enabled: false, awaitingAction: false };
	let settings: PlanModeSettings = { thinkingLevel: "inherit" };
	let previousTools: string[] | undefined;
	let readyPresentationIntent: ReadyPresentationIntent | undefined;
	let nextReadyPresentationNonce = 0;
	let menuGeneration = 0;
	let workflowGeneration = 0;
	let menuController = new AbortController();

	pi.registerFlag("plan", {
		description: "Start in Codex-like Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}

			const sessionGeneration = menuGeneration;
			const questionWorkflowGeneration = workflowGeneration;
			return answerPlanModeQuestions(parsed.questions, ctx, {
				isCurrent: () =>
					sessionGeneration === menuGeneration && questionWorkflowGeneration === workflowGeneration,
				isEnabled: () => state.enabled,
			});
		},
	});

	pi.registerTool({
		name: PLAN_MODE_COMPLETE_TOOL_NAME,
		label: "Complete plan",
		description:
			"Submit the complete decision-ready implementation plan for user review. Only available while Plan mode is active, and must be the final standalone action.",
		promptSnippet: "Submit the final Plan-mode implementation plan",
		promptGuidelines: [
			"Call plan_mode_complete alone as the final action only after the implementation plan is decision-complete.",
		],
		parameters: PLAN_MODE_COMPLETE_PARAMS,
		renderResult: renderPlanModeCompletion,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				throw new Error("plan_mode_complete is only available while Plan mode is active");
			}
			const parsed = normalizePlanModeCompletion(params);
			if (!parsed.ok) throw new Error(parsed.error);

			acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
			return planModeCompleted(parsed.plan);
		},
	});

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "show") {
				showStoredPlan(ctx);
				return;
			}
			if (command === "finalize") {
				requestFinalPlan(ctx);
				return;
			}
			if (command === "implement") {
				if (!state.enabled || !state.latestPlan?.trim()) {
					ctx.ui.notify("No completed plan is available to implement.", "warning");
					return;
				}
				startImplementation(ctx);
				return;
			}
			if (command === "exit" || command === "off") {
				const hadActiveImplementation = state.activeImplementation !== undefined;
				exitPlanMode(ctx);
				ctx.ui.notify(
					hadActiveImplementation
						? "Active implementation plan cleared."
						: "Plan mode disabled. Proposed plan discarded.",
					"info",
				);
				return;
			}
			if (command === "tools") {
				if (!state.enabled) enterPlanMode(ctx);
				await showToolSelector(ctx);
				return;
			}
			if (prompt) {
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!state.enabled) {
				if (state.activeImplementation && ctx.hasUI) {
					await showActivePlanMenu(ctx);
					return;
				}
				enterPlanMode(ctx);
				ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
				return;
			}
			await showPlanMenu(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const generation = ++menuGeneration;
		menuController.abort(new DOMException("Plan-mode session replaced", "AbortError"));
		menuController = new AbortController();
		readyPresentationIntent = undefined;
		settings = { thinkingLevel: "inherit" };
		restoreState(ctx);
		const loadedSettings = await (dependencies.readSettings?.() ?? readPlanModeSettings());
		if (generation !== menuGeneration || menuController.signal.aborted) return;
		if (loadedSettings.kind === "loaded") settings = loadedSettings.settings;
		else if (loadedSettings.kind === "invalid") {
			ctx.ui.notify(`pi-plan-mode settings ignored: ${loadedSettings.reason}`, "warning");
		}
		if (loadedSettings.notice) ctx.ui.notify(loadedSettings.notice, "warning");
		const persistFlagActivation = pi.getFlag("plan") === true && !state.enabled;
		if (persistFlagActivation) {
			state = { ...state, enabled: true, activeImplementation: undefined };
		}
		if (state.enabled) {
			activatePlanModeTools();
			applyPlanThinkingLevel();
		} else deactivatePlanModeQuestionTool();
		if (persistFlagActivation) persistState();
		updateUi(ctx);
	});

	pi.on("thinking_level_select", (event) => {
		if (!state.enabled || !state.appliedThinkingLevel) return;
		if (event.level !== state.appliedThinkingLevel) {
			state = {
				...state,
				manualThinkingLevel: event.level,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			persistState();
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		menuGeneration += 1;
		menuController.abort(new DOMException("Plan-mode session shut down", "AbortError"));
		readyPresentationIntent = undefined;
		captureManualThinkingLevel();
		persistState();
		if (state.enabled) {
			restoreTools();
			restoreThinkingLevel();
		}
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (event.toolName === "update_plan") {
			return {
				block: true,
				reason:
					"Plan mode blocks update_plan because it tracks execution progress rather than conversational planning.",
			};
		}
		if (settings.allowedPlanSubagents !== undefined) {
			const blocked = enforcePlanSubagentAllowlist(
				event.toolName,
				event.input,
				settings.allowedPlanSubagents,
			);
			if (blocked) return blocked;
		}
		const calledTool = toolByName(event.toolName);
		if (calledTool && classifyPlanModeTool(calledTool) === "blocked") {
			return {
				block: true,
				reason: `Plan mode blocks built-in tool '${event.toolName}' because its policy class is blocked.`,
			};
		}
		if (!calledTool && BLOCKED_BUILTIN_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode blocks built-in tool '${event.toolName}' because its metadata is unavailable.`,
			};
		}
		// Built-in-compatible overrides retain the canonical name but replace its source metadata.
		if (event.toolName !== "bash") return;

		const command = readCommand(event.input);
		if (!isSafeCommand(command, settings.safeSubcommands)) {
			return {
				block: true,
				reason: `Plan mode blocks mutating or non-allowlisted bash commands.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		const messagesWithoutPlanContext = event.messages.filter(
			(message: unknown) =>
				!messageContainsLegacyPlanModeContextArtifact(message) &&
				!messageContainsPlanModeImplementationContextArtifact(message),
		);
		if (state.enabled) {
			return {
				messages: messagesWithoutPlanContext.filter(
					(message: unknown) => !messageContainsPlanModeImplementationHandoff(message),
				),
			};
		}
		const inactiveMessages = state.activeImplementation
			? messagesWithoutPlanContext
			: messagesWithoutPlanContext.filter(
					(message: unknown) => !messageContainsPlanModeImplementationHandoff(message),
				);
		const messages = inactiveMessages
			.filter((message: unknown) => !messageContainsInactivePlanModeArtifact(message))
			.map(stripProposedPlanBlocksFromMessage)
			.map(stripPlanModeCompletionCallsFromMessage)
			.filter((message: unknown) => !isEmptyAssistantMessage(message));
		const contextualMessages = state.activeImplementation
			? injectActiveImplementationContext(messages, state.activeImplementation)
			: messages;
		return { messages: contextualMessages as typeof event.messages };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return;
		if (state.latestPlan || state.awaitingAction) {
			readyPresentationIntent = undefined;
			state = {
				...state,
				latestPlan: undefined,
				latestPlanSource: undefined,
				awaitingAction: false,
			};
			persistState();
			updateUi(ctx);
		}
		applyPlanModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;

		const text = latestAssistantText(event.messages);
		const parsedPlan = parseProposedPlan(text);
		if (parsedPlan.kind !== "valid") {
			if (parsedPlan.kind !== "absent") {
				ctx.ui.notify(invalidPlanMessage(parsedPlan.kind), "warning");
			}
			persistState();
			updateUi(ctx);
			return;
		}
		acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
	});

	onAgentSettled(pi, async (_event, ctx) => {
		const intent = readyPresentationIntent;
		if (!intent || !readyPresentationIsCurrent(intent)) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		readyPresentationIntent = undefined;
		try {
			if (intent.source === "legacy_proposed_plan") {
				pi.sendMessage(
					{
						customType: PROPOSED_PLAN_MESSAGE_TYPE,
						content: `**Proposed Plan**\n\n${intent.plan}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			if (ctx.hasUI && completedPlanIsCurrent(intent)) {
				await showPlanReadyMenu(ctx);
			}
		} catch (error: unknown) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	function enterPlanMode(ctx: ExtensionContext) {
		workflowGeneration += 1;
		if (!state.enabled) previousTools = withoutRequiredPlanModeTools(safeGetActiveTools());
		state = {
			...state,
			enabled: true,
			awaitingAction: false,
			activeImplementation: undefined,
		};
		activatePlanModeTools();
		applyPlanThinkingLevel();
		persistState();
		updateUi(ctx);
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const previousState = state;
		const wasEnabled = state.enabled;
		enterPlanMode(ctx);
		if (!wasEnabled) {
			ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
		}
		if (sendPlanModeUserMessage(prompt, ctx)) return;
		if (!previousState.enabled) {
			restoreTools();
			restoreThinkingLevel();
		}
		state = previousState;
		persistState();
		updateUi(ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		workflowGeneration += 1;
		const wasEnabled = state.enabled;
		readyPresentationIntent = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			activeImplementation: undefined,
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreTools();
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		persistState();
		updateUi(ctx);
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
			return true;
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
			return false;
		}
	}

	function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
		const normalized = normalizePlanModeCompletion({ plan });
		if (!normalized.ok) {
			ctx.ui.notify(`Proposed plan is not ready: ${normalized.error}.`, "warning");
			persistState();
			updateUi(ctx);
			return;
		}
		if (
			state.enabled &&
			state.awaitingAction &&
			state.latestPlan === normalized.plan &&
			state.latestPlanSource === source
		) {
			return;
		}
		state = {
			...state,
			latestPlan: normalized.plan,
			latestPlanSource: source,
			awaitingAction: true,
		};
		readyPresentationIntent = {
			nonce: ++nextReadyPresentationNonce,
			plan: normalized.plan,
			source,
		};
		persistState();
		updateUi(ctx);
	}

	function completedPlanIsCurrent(intent: ReadyPresentationIntent) {
		return (
			state.enabled &&
			state.awaitingAction &&
			state.latestPlan === intent.plan &&
			state.latestPlanSource === intent.source
		);
	}

	function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
		return completedPlanIsCurrent(intent) && readyPresentationIntent?.nonce === intent.nonce;
	}

	function showStoredPlan(ctx: ExtensionContext) {
		const readyPlan = state.enabled ? state.latestPlan?.trim() : undefined;
		const activePlan = state.activeImplementation?.plan.trim();
		const plan = readyPlan ?? activePlan;
		if (!plan) {
			ctx.ui.notify(
				"No completed plan is available. Use /plan finalize when planning is complete.",
				"info",
			);
			return;
		}
		try {
			pi.sendMessage(
				{
					customType: PROPOSED_PLAN_MESSAGE_TYPE,
					content: `**${readyPlan ? "Proposed Plan" : "Active Implementation Plan"}**\n\n${plan}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
		}
	}

	function requestFinalPlan(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
			return;
		}
		sendPlanModeUserMessage(
			"Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.",
			ctx,
		);
	}

	function startImplementation(ctx: ExtensionContext) {
		const plan = state.latestPlan?.trim();
		const source = state.latestPlanSource ?? "legacy_proposed_plan";
		if (!plan) {
			ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
			return;
		}

		workflowGeneration += 1;
		const wasEnabled = state.enabled;
		readyPresentationIntent = undefined;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			latestPlanSource: undefined,
			awaitingAction: false,
			activeImplementation: {
				id: randomUUID(),
				plan,
				source,
				startedAt: Date.now(),
			},
			manualThinkingLevel: undefined,
		};
		if (wasEnabled) {
			restoreTools();
			restoreThinkingLevel();
			state = { ...state, manualThinkingLevel: undefined };
		}
		persistState();
		updateUi(ctx);

		const sent = sendPlanModeUserMessage(
			`Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n${plan}`,
			ctx,
		);
		if (!sent) {
			enterPlanMode(ctx);
			state = { ...state, latestPlan: plan, latestPlanSource: source, awaitingAction: true };
			persistState();
			updateUi(ctx);
		}
	}

	async function showActivePlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}
		const lifecycle = captureMenuLifecycle();
		await showActiveImplementationMenu(ctx, {
			statusText: planStatusText(),
			signal: lifecycle.signal,
			isCurrent: lifecycle.isCurrent,
			show: () => showStoredPlan(ctx),
			startNew: () => {
				enterPlanMode(ctx);
				ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
			},
			clear: () => {
				exitPlanMode(ctx);
				ctx.ui.notify("Active implementation plan cleared.", "info");
			},
		});
	}

	async function showPlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}
		const lifecycle = captureMenuLifecycle();
		type Action = "show" | "finalize" | "implement" | "tools" | "stay" | "exit";
		const menu = defineMenu<undefined, "main", Action, ExtensionContext>({
			start: "main",
			screens: {
				main: () => ({
					kind: "actions",
					title: "Plan mode",
					lines: [planStatusText()],
					items: state.latestPlan
						? [
								{ id: "show", label: "Show latest proposed plan", action: "show" },
								{ id: "implement", label: "Implement this plan", action: "implement" },
								{ id: "tools", label: "Configure Plan-mode tools", action: "tools" },
								{ id: "stay", label: "Stay in Plan mode", action: "stay" },
								{ id: "exit", label: "Exit Plan mode", action: "exit" },
							]
						: [
								{ id: "finalize", label: "Request final plan", action: "finalize" },
								{ id: "tools", label: "Configure Plan-mode tools", action: "tools" },
								{ id: "stay", label: "Stay in Plan mode", action: "stay" },
								{ id: "exit", label: "Exit Plan mode", action: "exit" },
							],
					hint: "close",
				}),
			},
			actions: {
				show: async () => {
					showStoredPlan(ctx);
					return { kind: "close" };
				},
				finalize: async () => {
					requestFinalPlan(ctx);
					return { kind: "close" };
				},
				implement: async () => {
					startImplementation(ctx);
					return { kind: "close" };
				},
				tools: async () => {
					await showToolSelector(ctx);
					return { kind: "stay" };
				},
				stay: async () => {
					updateUi(ctx);
					return { kind: "close" };
				},
				exit: async () => {
					exitPlanMode(ctx);
					ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
					return { kind: "close" };
				},
			},
		});
		await runMenu(ctx, menu, {
			getState: () => undefined,
			...lifecycle,
		});
	}

	async function showPlanReadyMenu(ctx: ExtensionContext) {
		const lifecycle = captureMenuLifecycle();
		type Action = "implement" | "stay" | "exit";
		const menu = defineMenu<undefined, "ready", Action, ExtensionContext>({
			start: "ready",
			screens: {
				ready: () => ({
					kind: "actions",
					title: "Proposed plan ready. What next?",
					items: [
						{ id: "implement", label: "Implement this plan", action: "implement" },
						{ id: "stay", label: "Stay in Plan mode", action: "stay" },
						{ id: "exit", label: "Exit Plan mode", action: "exit" },
					],
					hint: "close",
				}),
			},
			actions: {
				implement: async () => {
					startImplementation(ctx);
					return { kind: "close" };
				},
				stay: async () => ({ kind: "close" }),
				exit: async () => {
					exitPlanMode(ctx);
					ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
					return { kind: "close" };
				},
			},
		});
		await runMenu(ctx, menu, {
			getState: () => undefined,
			...lifecycle,
		});
	}

	async function showToolSelector(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatToolSummary(), "info");
			return;
		}
		const lifecycle = captureMenuLifecycle();
		const tools = selectableTools();
		const toolById = new Map(tools.map((tool, index) => [`${index}:${tool.name}`, tool]));
		const menu = defineMenu<undefined, "tools", "toggle", ExtensionContext>({
			start: "tools",
			screens: {
				tools: () => {
					const selectedNames = planModeSelectedNames(tools);
					return {
						kind: "multiSelect",
						title: "Plan-mode tools",
						lines: ["Non-built-in tools run at user risk."],
						enableSearch: true,
						viewportSize: TOOL_SELECTOR_VIEWPORT_SIZE,
						items: tools.map((tool, index) => {
							const selectable = canSelectToolInPlanMode(tool);
							return {
								id: `${index}:${tool.name}`,
								label: tool.name,
								description: `${toolPolicyLabel(tool)} · ${tool.description}`,
								searchText: [toolPolicyLabel(tool), tool.description].filter(Boolean).join(" "),
								selected: selectedNames.has(tool.name),
								disabled: !selectable,
								disabledReason: selectable ? undefined : "Blocked by Plan-mode policy",
							};
						}),
						action: "toggle",
						hint: "close",
						doneLabel: "Done",
					};
				},
			},
			actions: {
				toggle: async ({ itemId, selected }) => {
					const tool = toolById.get(itemId);
					if (!tool || !canSelectToolInPlanMode(tool)) return { kind: "rejected" };
					const names = planModeSelectedNames(tools);
					if (selected) names.add(tool.name);
					else names.delete(tool.name);
					state = {
						...state,
						selectedToolNames: filterAvailableSelectedNames(Array.from(names), tools),
					};
					applyPlanModeTools();
					persistState();
					updateUi(ctx);
					return { kind: "stay" };
				},
			},
		});
		await runMenu(ctx, menu, {
			getState: () => undefined,
			...lifecycle,
		});
		if (!lifecycle.isCurrent()) return;
		applyPlanModeTools();
		persistState();
		updateUi(ctx);
	}

	function captureMenuLifecycle() {
		const sessionGeneration = menuGeneration;
		const planWorkflowGeneration = workflowGeneration;
		const controller = menuController;
		return {
			signal: controller.signal,
			isCurrent: () =>
				sessionGeneration === menuGeneration &&
				planWorkflowGeneration === workflowGeneration &&
				!controller.signal.aborted,
		};
	}

	function activatePlanModeTools() {
		previousTools ??= withoutRequiredPlanModeTools(safeGetActiveTools());
		applyPlanModeTools();
	}

	function applyPlanModeTools() {
		pi.setActiveTools(planModeToolNames());
	}

	function planModeToolNames() {
		const tools = selectableTools();
		if (
			tools.length === 0 &&
			state.selectedToolNames === undefined &&
			state.selectedToolKeys === undefined &&
			settings.defaultPlanTools === undefined
		) {
			return ["read", "bash", PLAN_MODE_QUESTION_TOOL_NAME, PLAN_MODE_COMPLETE_TOOL_NAME];
		}

		const selectedNames = planModeSelectedNames(tools);
		return withRequiredPlanModeTools(
			tools
				.filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
				.map((tool) => tool.name),
		);
	}

	function planModeSelectedNames(tools: ToolInfo[]) {
		const selectedToolNames = state.selectedToolNames ?? migrateSelectedToolKeys(tools);
		if (selectedToolNames === undefined) return new Set(defaultPlanModeToolNames(tools));

		state = {
			...state,
			selectedToolNames: filterAvailableSelectedNames(selectedToolNames, tools),
			selectedToolKeys: undefined,
		};
		return new Set(state.selectedToolNames);
	}

	function defaultPlanModeToolNames(tools: ToolInfo[]) {
		if (settings.defaultPlanTools !== undefined) {
			return filterAvailableSelectedNames(settings.defaultPlanTools, tools);
		}
		return tools
			.filter((tool) => isBuiltinTool(tool) && SAFE_BUILTIN_PLAN_TOOLS.has(tool.name))
			.map((tool) => tool.name);
	}

	function migrateSelectedToolKeys(tools: ToolInfo[]) {
		if (state.selectedToolKeys === undefined) return undefined;
		return state.selectedToolKeys
			.map((key) => toolNameFromLegacyKey(key, tools))
			.filter((name): name is string => name !== undefined);
	}

	function filterAvailableSelectedNames(names: string[], tools: ToolInfo[]) {
		const availableNames = new Set(tools.filter(canSelectToolInPlanMode).map((tool) => tool.name));
		return unique(names.filter((name) => availableNames.has(name)));
	}

	function selectableTools() {
		return safeGetAllTools()
			.filter(
				(tool) =>
					tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME,
			)
			.sort(compareTools);
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function restoreTools() {
		const restoredTools = previousTools ?? DEFAULT_TOOLS;
		pi.setActiveTools(withoutRequiredPlanModeTools(restoredTools));
		previousTools = undefined;
	}

	function applyPlanThinkingLevel() {
		if (state.manualThinkingLevel) {
			if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
				setPlanThinkingLevel(pi, state.manualThinkingLevel);
			}
			return;
		}
		const configured = configuredThinkingLevel(settings);
		if (!configured) {
			state = {
				...state,
				previousThinkingLevel: undefined,
				appliedThinkingLevel: undefined,
			};
			return;
		}
		const current = pi.getThinkingLevel();
		if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
		if (current !== configured) setPlanThinkingLevel(pi, configured);
		state.appliedThinkingLevel = pi.getThinkingLevel();
	}

	function captureManualThinkingLevel() {
		if (!state.appliedThinkingLevel) return;
		const current = pi.getThinkingLevel();
		if (current === state.appliedThinkingLevel) return;
		state = {
			...state,
			manualThinkingLevel: current,
			previousThinkingLevel: undefined,
			appliedThinkingLevel: undefined,
		};
	}

	function restoreThinkingLevel() {
		captureManualThinkingLevel();
		const { appliedThinkingLevel, previousThinkingLevel } = state;
		if (
			appliedThinkingLevel &&
			previousThinkingLevel &&
			pi.getThinkingLevel() === appliedThinkingLevel
		) {
			setPlanThinkingLevel(pi, previousThinkingLevel);
		}
		state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
	}

	function deactivatePlanModeQuestionTool() {
		const activeTools = safeGetActiveTools();
		const filteredTools = withoutRequiredPlanModeTools(activeTools);
		if (filteredTools.length !== activeTools.length) {
			pi.setActiveTools(filteredTools);
		}
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return DEFAULT_TOOLS;
		}
	}

	function persistState() {
		pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext) {
		state = restorePlanModeState(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
	}

	function updateUi(ctx: ExtensionContext) {
		updatePlanModeUi(ctx, state, formatToolSummary);
	}

	function clearUi(ctx: ExtensionContext) {
		clearPlanModeUi(ctx);
	}

	function planStatusText() {
		return formatPlanModeStatusText(state, formatToolSummary);
	}

	function formatToolSummary() {
		const names = planModeToolNames();
		return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
	}

	function toolByName(toolName: string) {
		return safeGetAllTools().find((candidate) => candidate.name === toolName);
	}
}

export { completePlanArguments } from "./command.js";
export {
	extractProposedPlan,
	latestAssistantText,
	parseProposedPlan,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
export { buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { withoutPlanModeQuestionTool, withRequiredPlanModeTools } from "./required-tools.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export { canSelectToolInPlanMode, classifyPlanModeTool, isSafeCommand } from "./tool-policy.js";
