/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports blocking single, parallel, chain, workflow, and panel modes.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { discoverAgentCatalog, formatAgentCatalog } from "./agents/catalog.js";
import type {
	ConsultationCwdPolicy,
	ConsultResourcePolicy,
	DelegationCwdPolicy,
	SubagentSettings,
} from "./agents/types.js";
import { registerSubagentAutomation } from "./automation.js";
import { registerSubagentConfigCommand, registerSubagentConfigLifecycle } from "./config-ui.js";
import { registerSubagentConsult } from "./consult.js";
import { executeSubagent } from "./execution.js";
import { registerSubagentInspect } from "./inspect.js";
import { MAX_BLOCKING_PARALLEL_CONCURRENCY } from "./limits.js";
import { SubagentParams } from "./params.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import type { SubagentDetails } from "./runner.js";
import {
	consumeSubagentSettingsNotice,
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectSubagentSettings,
	readSubagentSettings,
	resolveBlockingMaxParallelTasks,
} from "./settings.js";
import { registerStatefulSubagents } from "./stateful.js";

export default function (pi: ExtensionAPI) {
	const configOwner = registerSubagentConfigLifecycle(pi);
	const settings = readSubagentSettings();
	let currentSettings: SubagentSettings | undefined = settings;
	let currentCatalog = "";
	const blockingEnabled = settings?.blocking?.enabled !== false;
	const refreshBlockingCatalog = blockingEnabled
		? registerBlockingSubagent(pi, () => currentSettings)
		: () => undefined;
	if (blockingEnabled) registerSubagentAutomation(pi, { getSettings: () => currentSettings });
	let refreshStatefulCatalog: (catalog: string) => void = () => undefined;
	let refreshConsultCatalog: (catalog: string) => void = () => undefined;

	pi.on("session_start", (_event, ctx) => {
		// Preserve a one-shot migration notice from extension load while refreshing
		// validation against settings that may have changed before this session.
		const loadNotice = consumeSubagentSettingsNotice();
		const refreshedSettings = readSubagentSettings();
		const refreshedNotice = consumeSubagentSettingsNotice();
		if (!inspectSubagentSettings().error) currentSettings = refreshedSettings;
		const notice = [
			...new Set([loadNotice, refreshedNotice].filter((value) => value !== undefined)),
		].join("\n");
		if (notice) ctx.ui.notify(notice, "warning");

		currentCatalog = formatAgentCatalog(
			discoverAgentCatalog(ctx.cwd, ctx.isProjectTrusted(), refreshedSettings),
		).text;
		refreshBlockingCatalog(currentCatalog);
		refreshStatefulCatalog(currentCatalog);
		refreshConsultCatalog(currentCatalog);
	});

	const statefulRuntime = registerStatefulSubagents(pi, {
		blockingEnabled,
		settings: settings?.stateful,
		getSettings: () => currentSettings,
	});
	refreshStatefulCatalog = statefulRuntime.setAgentCatalog;
	const getBlockingEnabled = () => blockingEnabled;
	const getMaxParallelTasks = () => resolveBlockingMaxParallelTasks(currentSettings);
	const getConsultResourcePolicy = () =>
		currentSettings?.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY;
	const getConsultationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY;
	const getDelegationCwdPolicy = () =>
		currentSettings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY;
	registerSubagentInspect(pi, {
		...statefulRuntime,
		getBlockingEnabled,
		getMaxParallelTasks,
		getConsultResourcePolicy,
		getConsultationCwdPolicy,
		getDelegationCwdPolicy,
	});
	if (blockingEnabled) {
		refreshConsultCatalog = registerSubagentConsult(pi, {
			getSettings: () => currentSettings,
		});
	}
	registerSubagentConfigCommand(
		pi,
		{
			...statefulRuntime,
			getBlockingEnabled,
			getMaxParallelTasks,
			getConsultResourcePolicy,
			getConsultationCwdPolicy,
			getDelegationCwdPolicy,
			setMaxParallelTasks(value: number) {
				const previousSettings = currentSettings;
				currentSettings = {
					...(currentSettings ?? {}),
					blocking: { ...(currentSettings?.blocking ?? {}), maxParallelTasks: value },
				};
				try {
					refreshBlockingCatalog(currentCatalog);
				} catch (applyError) {
					currentSettings = previousSettings;
					try {
						refreshBlockingCatalog(currentCatalog);
					} catch (rollbackError) {
						throw new AggregateError(
							[applyError, rollbackError],
							"Failed to apply and roll back the parallel-worker limit",
						);
					}
					throw applyError;
				}
			},
			setConsultResourcePolicy(value: ConsultResourcePolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					consult: { ...(currentSettings?.consult ?? {}), resources: value },
				};
				refreshConsultCatalog(currentCatalog);
			},
			setConsultationCwdPolicy(value: ConsultationCwdPolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), consultation: value },
				};
				refreshConsultCatalog(currentCatalog);
			},
			setDelegationCwdPolicy(value: DelegationCwdPolicy) {
				currentSettings = {
					...(currentSettings ?? {}),
					cwdPolicy: { ...(currentSettings?.cwdPolicy ?? {}), delegation: value },
				};
				refreshBlockingCatalog(currentCatalog);
				statefulRuntime.refreshSettingsGuidance();
			},
		},
		configOwner,
	);
}

function registerBlockingSubagent(
	pi: ExtensionAPI,
	getSettings: () => SubagentSettings | undefined,
): (catalog: string) => void {
	let catalog = "";
	const activeControllers = new Set<AbortController>();
	const activeWork = new Set<Promise<unknown>>();
	const cancelAndWaitForWork = async (reason: string) => {
		for (const controller of activeControllers) {
			controller.abort(new DOMException(reason, "AbortError"));
		}
		await Promise.allSettled([...activeWork]);
	};
	pi.on("session_start", () => cancelAndWaitForWork("Blocking subagent session replaced"));
	pi.on("session_shutdown", () => cancelAndWaitForWork("Blocking subagent session shut down"));
	const baseDescription = () =>
		[
			"Run specialized subagents as a blocking operation with isolated contexts.",
			"The call blocks the main agent until every worker and optional aggregator finishes, so queued steering waits.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), workflow (named dependency tasks with optional capability routing), or panel (independent reviewers plus evidence-preserving synthesis).",
			"Parallel mode may include an aggregator fan-in step; workflow mode validates dependencies, authority, artifacts, scope conflicts, retries, and hedging before scheduling. Use subagent_consult instead for one synchronous child that must be executor-constrained to read-only tools.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, pass agentScope: "both" (or "project") as a top-level argument for that call.`,
			`Maximum parallel worker tasks per call: ${resolveBlockingMaxParallelTasks(getSettings())}. Parallel execution starts at most ${MAX_BLOCKING_PARALLEL_CONCURRENCY} workers at once.`,
			`Working-directory target policy: ${getSettings()?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY}. This controls launch targets and protected project resources, not filesystem access or sandboxing.`,
		].join(" ");
	const promptGuidelines = () => [
		"Use subagent only when delegation fits; the main agent should decide how many subagents to spawn from task shape instead of waiting for the user to specify a count.",
		"Use no subagent for simple answers, quick targeted edits, latency-sensitive one-step work, tasks requiring frequent user back-and-forth, or critical-path work the main agent can perform directly.",
		"Use the blocking subagent tool only when delegated outputs are required before the main agent's next action and waiting is intentional; the main agent cannot process queued steering until the call returns.",
		"Use a blocking subagent single, parallel, chain, workflow, panel, or fan-in call only when synchronous context or output isolation is worth making the main agent unavailable while it runs.",
		`If a blocking parallel subagent call is genuinely required, keep tasks independent, stay within the configured max ${resolveBlockingMaxParallelTasks(getSettings())}, and avoid write-heavy implementation touching the same files or shared state.`,
		"For parallel subagent calls, omit the aggregator key entirely unless a fan-in step is required; do not send null, empty strings, or an empty object for unused optional fields.",
		"Use workflow mode for explicit dependencies or capability routing; declare read/write or ownership scopes, require structured-v2 artifacts when downstream tasks consume them, and use retry or hedging only with the required side-effect contract.",
		"Use panel mode only for consequential review or research that benefits from at least two independent reviewers and one bounded synthesis; agreement is not proof, dissent and blocking objections remain visible, and simple or latency-sensitive work should not use a panel.",
		'Do not use subagent with project-local agents unless the user explicitly wants project agents or sets agentScope to "project" or "both"; keep confirmation enabled for untrusted repositories.',
		"When using subagent, write self-contained tasks with file paths, context, expected output, and whether the subagent may edit files.",
		"Set subagent timeoutMs to the shortest realistic work deadline for the task difficulty, just as thinkingLevel should match reasoning difficulty; split oversized tasks instead of extending the deadline merely to compensate for broad scope. Use totalTimeoutMs to cap an entire blocking workflow, idleTimeoutMs for stalled work, and maxTurns or maxToolCalls to stop repeated work without progress. Every budget stop preserves a bounded checkpoint and may make one separately bounded summary attempt.",
	];
	const definition: ToolDefinition<typeof SubagentParams, SubagentDetails> = {
		name: "subagent",
		label: "Blocking Subagent",
		description: appendAgentCatalog(baseDescription(), catalog),
		promptSnippet:
			"Run blocking isolated subagents only when their outputs are required before the main agent can continue.",
		promptGuidelines: promptGuidelines(),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const lifecycleController = new AbortController();
			activeControllers.add(lifecycleController);
			const effectiveSignal = signal
				? AbortSignal.any([signal, lifecycleController.signal])
				: lifecycleController.signal;
			const work = executeSubagent(
				toolCallId,
				params,
				effectiveSignal,
				onUpdate,
				ctx,
				getSettings(),
			);
			activeWork.add(work);
			try {
				return await work;
			} finally {
				activeControllers.delete(lifecycleController);
				activeWork.delete(work);
			}
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},
	};
	pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		if ((event.details as (SubagentDetails & { isError?: boolean }) | undefined)?.isError)
			return { isError: true };
	});
	return (nextCatalog: string) => {
		catalog = nextCatalog;
		definition.description = appendAgentCatalog(baseDescription(), catalog);
		definition.promptGuidelines = promptGuidelines();
		pi.registerTool<typeof SubagentParams, SubagentDetails>(definition);
	};
}

function appendAgentCatalog(baseDescription: string, catalog: string): string {
	return catalog ? `${baseDescription}\n\n${catalog}` : baseDescription;
}

export { parsePositiveInteger } from "./execution/runtime-policy.js";
export { formatTokens, formatUsageStats } from "./render.js";
export { buildPiArgs } from "./runner.js";
export {
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	inspectBlockingParallelLimitSettings,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectStatefulLimitSettings,
	inspectSubagentSettings,
	normalizeAgentSettings,
	normalizeSubagentSettings,
	readSubagentSettings,
	resolveBlockingMaxParallelTasks,
	resolveSubagentThinkingLevel,
	sameToolSet,
	saveSubagentConfig,
	subagentSettingsFilePath,
	uniqueToolNames,
	updateAgentToolsSetting,
	updateBlockingMaxParallelTasksSetting,
	updateCompletionDeliverySetting,
	updateConsultResourceSetting,
	updateCwdPolicySetting,
	updateDelegationWorkflowSetting,
	updateStatefulLimitSetting,
} from "./settings.js";
