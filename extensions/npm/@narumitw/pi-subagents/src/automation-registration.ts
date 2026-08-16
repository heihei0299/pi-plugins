import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AutomationExecutionOptions } from "./automation.js";
import { type AutomationDetails, SubagentAutomationParams } from "./automation-tool.js";
import { cachedModuleLoader, throwIfAborted } from "./cached-module-loader.js";
import { renderFallbackResult, safeLine, toolHeader } from "./render-common.js";

interface AutomationExecutionModule {
	executeAutomationRequest: typeof import("./automation.js").executeAutomationRequest;
}

export interface AutomationRegistrationDependencies {
	loadExecution?: () => Promise<AutomationExecutionModule>;
}

export function registerSubagentAutomation(
	pi: ExtensionAPI,
	options: AutomationExecutionOptions,
	dependencies: AutomationRegistrationDependencies = {},
): void {
	const loadExecution = cachedModuleLoader(
		dependencies.loadExecution ?? (() => import("./automation.js")),
	);
	let generation = 0;
	const activeControllers = new Set<AbortController>();
	const activeWork = new Set<Promise<unknown>>();
	const cancelAndWait = async (reason: string) => {
		generation++;
		for (const controller of activeControllers) {
			controller.abort(new DOMException(reason, "AbortError"));
		}
		await Promise.allSettled([...activeWork]);
	};
	pi.on("session_start", () => cancelAndWait("Autonomous workflow session replaced"));
	pi.on("session_shutdown", () => cancelAndWait("Autonomous workflow session shut down"));
	const definition: ToolDefinition<typeof SubagentAutomationParams, AutomationDetails> = {
		name: "subagent_auto",
		label: "Autonomous Subagent Workflow",
		description: [
			"Explicitly opt in to one bounded read-only planning turn that compiles a high-level objective into the smallest justified existing workflow.",
			"The deterministic compiler may return parent-owned work, request missing input, or reject without launching execution workers.",
			"Mutating workflows require an authoritative integration path and an independent verifier, allow at most two concurrent mutating workers, and never allow workflow grandchildren.",
			"The first version routes only built-in and user-scoped agents; use caller-authored workflow mode for project-local agents.",
		].join(" "),
		promptSnippet:
			"Explicitly compile one high-level objective into a bounded capability-matched workflow",
		promptGuidelines: [
			"Use subagent_auto only when the caller explicitly opts into autonomous workflow planning.",
			"Provide a complete authority ceiling and aggregate budget; parent-owned and insufficient-evidence results launch no execution workers.",
			"Use caller-authored subagent workflow mode as the compatibility fallback when deterministic task control is required.",
		],
		parameters: SubagentAutomationParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const ownerGeneration = generation;
			const controller = new AbortController();
			activeControllers.add(controller);
			const combined = combineSignals(signal, controller.signal);
			const work = (async () => {
				throwIfAborted(combined.signal, "Autonomous workflow loading was cancelled");
				let executionModule: AutomationExecutionModule;
				try {
					executionModule = await loadExecution();
				} catch (error) {
					throwIfAborted(combined.signal, "Autonomous workflow loading was cancelled");
					throw error;
				}
				throwIfAborted(combined.signal, "Autonomous workflow loading was cancelled");
				if (ownerGeneration !== generation) {
					throw new DOMException("Autonomous workflow owner was replaced", "AbortError");
				}
				return executionModule.executeAutomationRequest(
					toolCallId,
					params,
					combined.signal,
					onUpdate,
					ctx,
					options,
					() => ownerGeneration === generation,
				);
			})();
			activeWork.add(work);
			try {
				return await work;
			} finally {
				combined.dispose();
				activeControllers.delete(controller);
				activeWork.delete(work);
			}
		},
		renderCall(args, theme) {
			const request = (args as { request?: { objective?: string; version?: string } }).request;
			return new Text(
				toolHeader(theme, "subagent_auto", request?.objective, [request?.version ?? "request"]),
				0,
				0,
			);
		},
		renderResult(result, renderOptions, theme) {
			const status = safeLine(result.details?.status, "completed", 128);
			return renderFallbackResult(
				result,
				renderOptions,
				theme,
				result.details?.isError === true ||
					status.endsWith("failed") ||
					status.endsWith("rejected"),
			);
		},
	};
	pi.registerTool<typeof SubagentAutomationParams, AutomationDetails>(definition);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent_auto") return;
		if ((event.details as AutomationDetails | undefined)?.isError) return { isError: true };
	});
}

function combineSignals(
	external: AbortSignal | undefined,
	owned: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const signals = [external, owned].filter((value): value is AbortSignal => value !== undefined);
	const listeners = signals.map((source) => {
		const listener = () => {
			if (!controller.signal.aborted) controller.abort(source.reason);
		};
		if (source.aborted) listener();
		else source.addEventListener("abort", listener, { once: true });
		return { source, listener };
	});
	return {
		signal: controller.signal,
		dispose() {
			for (const { source, listener } of listeners) source.removeEventListener("abort", listener);
		},
	};
}
