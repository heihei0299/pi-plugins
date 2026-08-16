import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cachedModuleLoader, throwIfAborted } from "./cached-module-loader.js";
import type { SubagentInspectRuntime } from "./inspect.js";
import { renderInspectCall, renderInspectResult } from "./inspect-render.js";
import { SubagentInspectParams } from "./inspect-tool.js";

interface InspectExecutionModule {
	executeSubagentInspect: typeof import("./inspect.js").executeSubagentInspect;
}

export interface InspectRegistrationDependencies {
	loadExecution?: () => Promise<InspectExecutionModule>;
}

export function registerSubagentInspect(
	pi: ExtensionAPI,
	runtime: SubagentInspectRuntime,
	dependencies: InspectRegistrationDependencies = {},
): void {
	const loadExecution = cachedModuleLoader(
		dependencies.loadExecution ?? (() => import("./inspect.js")),
	);
	let lifecycleGeneration = 0;
	pi.on("session_start", () => {
		lifecycleGeneration += 1;
	});
	pi.on("session_shutdown", () => {
		lifecycleGeneration += 1;
	});
	const definition: ToolDefinition<typeof SubagentInspectParams, Record<string, unknown>> = {
		name: "subagent_inspect",
		label: "Inspect Subagents",
		description:
			"Inspect available subagent definitions, models, retained runs, persisted blocking workflows, runtime status, and diagnostics without changing subagent or workspace state. This tool never starts a child, sends or acknowledges messages, interrupts or closes runs, changes settings, or modifies files.",
		promptSnippet: "Inspect subagent metadata and runtime state without changing it",
		parameters: SubagentInspectParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const ownerGeneration = lifecycleGeneration;
			throwIfAborted(signal, "Subagent inspection loading was cancelled");
			let executionModule: InspectExecutionModule;
			try {
				executionModule = await loadExecution();
			} catch (error) {
				throwIfAborted(signal, "Subagent inspection loading was cancelled");
				if (ownerGeneration !== lifecycleGeneration) {
					throw new DOMException("Subagent inspection session was replaced", "AbortError");
				}
				throw error;
			}
			throwIfAborted(signal, "Subagent inspection loading was cancelled");
			if (ownerGeneration !== lifecycleGeneration) {
				throw new DOMException("Subagent inspection session was replaced", "AbortError");
			}
			return executionModule.executeSubagentInspect(params, ctx, runtime);
		},
		renderCall(args, theme) {
			return renderInspectCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderInspectResult(result, options, theme, context);
		},
	};
	pi.registerTool(definition);
}
