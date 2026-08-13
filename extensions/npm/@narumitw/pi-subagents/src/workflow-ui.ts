import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DelegationWorkflow } from "./settings/inspection.js";

export async function showWorkflowPreview(
	ctx: ExtensionCommandContext,
	current: DelegationWorkflow,
	next: DelegationWorkflow,
	requiresReload: boolean,
	signal: AbortSignal,
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
		{ signal },
	);
}

export function workflowLabel(value: DelegationWorkflow): string {
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

function workflowEffects(current: DelegationWorkflow, next: DelegationWorkflow): string[] {
	const blockingEnabled = (value: DelegationWorkflow) =>
		value === "all" || value === "blocking-only";
	const asyncEnabled = (value: DelegationWorkflow) => value === "all" || value === "async-only";
	const effects: string[] = [];
	if (blockingEnabled(current) !== blockingEnabled(next)) {
		effects.push(
			blockingEnabled(next)
				? "Add blocking `subagent`, explicit `subagent_auto`, and read-only `subagent_consult`"
				: "Remove blocking `subagent`, explicit `subagent_auto`, and read-only `subagent_consult`",
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
