import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";

export function updatePlanModeUi(
	ctx: ExtensionContext,
	state: PlanModeState,
	toolSummary: () => string,
) {
	ctx.ui.setStatus(STATUS_KEY, formatStatus(state));
	if (state.enabled && state.latestPlan) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Proposed plan ready",
			"Use /plan to implement, revise, or exit Plan mode.",
		]);
	} else if (state.enabled) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Plan mode: planning",
			toolSummary(),
			"Finish with plan_mode_complete when decision-ready.",
		]);
	} else if (state.activeImplementation) {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, [
			"Implementation plan active",
			"Use /plan to show, replace, or clear it.",
		]);
	} else {
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}
}

export function clearPlanModeUi(ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export function planModeStatusText(state: PlanModeState, toolSummary: () => string) {
	if (state.enabled) {
		if (state.latestPlan) {
			return `Plan mode is active and a proposed plan is ready. ${toolSummary()}`;
		}
		return `Plan mode is active. ${toolSummary()} Explore, ask, and finish with plan_mode_complete when decision-ready.`;
	}
	if (state.activeImplementation) return "An implementation plan is active.";
	return "Plan mode is off.";
}

function formatStatus(state: PlanModeState) {
	if (state.enabled) {
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan active";
	}
	if (state.activeImplementation) return "plan implementing";
	return undefined;
}
