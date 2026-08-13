import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { projectAgentRecords } from "./agent-projection.js";
import type { ManagedAgent } from "./registry.js";
import { safeTerminalLine as safeTerminalText } from "./safe-text.js";
import { inspectStatefulLimitSettings, updateStatefulLimitSetting } from "./settings.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";
import {
	isValidStatefulLimit,
	resolveStatefulLimits,
	STATEFUL_LIMIT_DEFINITIONS,
	type StatefulLimitField,
	type StatefulLimits,
	statefulLimitDefinition,
} from "./stateful-limits.js";

export interface StatefulLimitRuntime {
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listAgents(includeClosed?: boolean): ManagedAgent[];
}

export interface StatefulLimitApplyOptions {
	signal: AbortSignal;
	isCurrent(): boolean;
}

export function statefulLimitListScreen(runtime: StatefulLimitRuntime) {
	const inspected = inspectStatefulLimitSettings();
	const current = runtime.getRuntimeStatus().limits;
	return {
		kind: "actions" as const,
		title: "Detached Agent Limits",
		lines: [
			"These limits apply after /reload or the next Pi session.",
			"Reloading can interrupt retained detached work.",
			...(inspected.error
				? [
						`Settings cannot be edited: ${safeTerminalText(inspected.error)}`,
						`Repair ${safeTerminalText(inspected.path)} and retry.`,
					]
				: []),
		],
		items: [
			...(inspected.values
				? STATEFUL_LIMIT_DEFINITIONS.map((definition) => {
						const configured = inspected.values?.[definition.field];
						return {
							id: definition.field,
							label: definition.label,
							description: `Current ${current[definition.field]} · configured ${configured?.value ?? "unavailable"} (${configured?.source ?? "unknown"})`,
							action: "pick-stateful-limit" as const,
						};
					})
				: []),
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export function statefulLimitInputScreen(field: StatefulLimitField, runtime: StatefulLimitRuntime) {
	const definition = statefulLimitDefinition(field);
	const inspected = inspectStatefulLimitSettings();
	const configured = inspected.values?.[field];
	return {
		kind: "input" as const,
		title: definition.label,
		lines: [
			definition.description,
			`Current session: ${runtime.getRuntimeStatus().limits[field]}`,
			`Configured after reload: ${configured?.value ?? "unavailable"} (${configured?.source ?? "unknown"})`,
			`Allowed: whole numbers ${definition.minimum === 0 ? "0 or greater" : "1 or greater"}`,
			`Read from: ${safeTerminalText(inspected.path)}`,
			...(inspected.writePath !== inspected.path
				? [`Saves to: ${safeTerminalText(inspected.writePath)}`]
				: []),
		],
		placeholder: "Enter a whole number",
		action: "set-stateful-limit" as const,
		hint: "back" as const,
	};
}

export async function applyStatefulLimitSetting(
	field: StatefulLimitField,
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: StatefulLimitRuntime,
	options: StatefulLimitApplyOptions,
) {
	const next = parseStatefulLimit(field, value);
	if (next === undefined) {
		notifyValidationError(field, ctx);
		return { kind: "rejected" as const };
	}
	const inspected = inspectStatefulLimitSettings();
	if (inspected.error || !inspected.values) {
		if (options.isCurrent() && !options.signal.aborted) {
			ctx.ui.notify(
				`Subagent settings cannot be edited: ${safeTerminalText(inspected.error ?? "settings are unavailable")}`,
				"error",
			);
		}
		return { kind: "rejected" as const };
	}
	const expected = configuredValues(inspected.values);
	if (next === expected[field]) return { kind: "back" as const };

	const beforeAgents = runtime.listAgents();
	const affectedBefore = projectedRemovedAgentIds(beforeAgents, expected, {
		...expected,
		[field]: next,
	});
	if (affectedBefore.length > 0) {
		const confirmed = await ctx.ui.confirm(
			`Lower ${statefulLimitDefinition(field).label}?`,
			[
				`This configured value would omit ${affectedBefore.length} currently retained agent record${affectedBefore.length === 1 ? "" : "s"} from projected recovery after reload.`,
				"No agent is closed now, and this menu will not reload Pi.",
				"A later state rewrite can make omitted records unavailable for recovery.",
			].join("\n\n"),
			{ signal: options.signal },
		);
		if (options.signal.aborted || !options.isCurrent()) return { kind: "close" as const };
		if (!confirmed) return { kind: "rejected" as const };
		const affectedAfter = projectedRemovedAgentIds(runtime.listAgents(), expected, {
			...expected,
			[field]: next,
		});
		if (!sameIds(affectedBefore, affectedAfter)) {
			ctx.ui.notify("Detached agents changed while confirming; review the limit again.", "warning");
			return { kind: "rejected" as const };
		}
	}

	if (options.signal.aborted || !options.isCurrent()) return { kind: "close" as const };
	try {
		updateStatefulLimitSetting(field, next, expected);
	} catch (error) {
		if (options.isCurrent() && !options.signal.aborted) {
			ctx.ui.notify(
				`Detached limit was not saved; the previous setting is unchanged: ${formatError(error)}`,
				"error",
			);
		}
		return { kind: "rejected" as const };
	}
	if (options.signal.aborted || !options.isCurrent()) return { kind: "close" as const };
	ctx.ui.notify(
		`Saved ${statefulLimitDefinition(field).label.toLowerCase()}: ${next}. Applies after /reload; clear retained agents before reloading if their work must not be interrupted.`,
		"info",
	);
	return { kind: "back" as const };
}

export function formatDetachedLimitSummary(status: StatefulSubagentRuntimeStatus): string {
	return [
		`${status.limits.maxAgents} retained`,
		`${status.limits.maxActiveTurns} active turns`,
		`${status.limits.maxChildrenPerAgent} children`,
		`depth ${status.limits.maxDepth}`,
		`${status.limits.maxStoredAgents} stored`,
	].join(" · ");
}

export function formatConfiguredDetachedLimitDivergence(
	status: StatefulSubagentRuntimeStatus,
	values: NonNullable<ReturnType<typeof inspectStatefulLimitSettings>["values"]>,
): string | undefined {
	const changed = STATEFUL_LIMIT_DEFINITIONS.flatMap((definition) => {
		const configured = values[definition.field].value;
		return configured === status.limits[definition.field]
			? []
			: [`${definition.label.toLowerCase()} ${configured}`];
	});
	return changed.length > 0 ? `Configured after reload: ${changed.join(" · ")}` : undefined;
}

export function formatConfiguredDetachedLimits(
	values: NonNullable<ReturnType<typeof inspectStatefulLimitSettings>["values"]>,
): string {
	return STATEFUL_LIMIT_DEFINITIONS.map((definition) => {
		const snapshot = values[definition.field];
		return `${definition.label.toLowerCase()} ${snapshot.value} (${snapshot.source})`;
	}).join(" · ");
}

export function formatEmptyStatefulRuntime(status: StatefulSubagentRuntimeStatus): string {
	if (!status.enabled) return "Stateful subagents are disabled in user settings.";
	if (!status.initialized) return "Stateful subagents are not initialized for this session.";
	return "No current-session subagents.";
}

function parseStatefulLimit(
	field: StatefulLimitField,
	value: string | undefined,
): number | undefined {
	const normalized = value?.trim() ?? "";
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return isValidStatefulLimit(field, parsed) ? parsed : undefined;
}

function notifyValidationError(field: StatefulLimitField, ctx: ExtensionCommandContext): void {
	const definition = statefulLimitDefinition(field);
	ctx.ui.notify(
		`${definition.label} must be a safe whole number ${definition.minimum === 0 ? "0 or greater" : "1 or greater"}.`,
		"warning",
	);
}

function configuredValues(
	values: NonNullable<ReturnType<typeof inspectStatefulLimitSettings>["values"]>,
): StatefulLimits {
	return resolveStatefulLimits(
		Object.fromEntries(Object.entries(values).map(([field, snapshot]) => [field, snapshot.value])),
	);
}

function projectedRemovedAgentIds(
	agents: readonly ManagedAgent[],
	current: StatefulLimits,
	next: StatefulLimits,
): string[] {
	const restorable = agents.filter(
		(agent) => agent.state !== "closed" && agent.workspaceMode !== "worktree",
	);
	const before = projectForReload(restorable, current);
	const afterIds = new Set(projectForReload(restorable, next).map((agent) => agent.id));
	return before.filter((agent) => !afterIds.has(agent.id)).map((agent) => agent.id);
}

function projectForReload(agents: readonly ManagedAgent[], limits: StatefulLimits): ManagedAgent[] {
	const stored = projectAgentRecords(agents, { maxAgents: limits.maxStoredAgents });
	return projectAgentRecords(stored, {
		maxAgents: limits.maxAgents,
		maxDepth: limits.maxDepth,
	});
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

function formatError(error: unknown): string {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
