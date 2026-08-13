import type { AgentConfig, SubagentThinkingLevel } from "./agents/types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./limits.js";
import type { ManagedAgent, TurnOutcome } from "./registry.js";
import { boundedPrivateText } from "./safe-text.js";
import type { TransportTelemetry } from "./transport-types.js";

export function modelIdentity(value: unknown): { provider?: string; model?: string } {
	if (!value || typeof value !== "object") return {};
	const model = value as Record<string, unknown>;
	return {
		provider:
			typeof model.provider === "string" ? boundedPrivateText(model.provider, 256) : undefined,
		model: typeof model.id === "string" ? boundedPrivateText(model.id, 256) : undefined,
	};
}

export function normalizeThinking(value: unknown): SubagentThinkingLevel | undefined {
	return typeof value === "string" &&
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
		? (value as SubagentThinkingLevel)
		: undefined;
}

export function rpcPolicy(
	config: AgentConfig,
	agent: ManagedAgent,
): NonNullable<TurnOutcome["policy"]> {
	return {
		inherited: ["environment", "cwdResources"],
		overridden: [
			"cwd",
			"extensions",
			...(config.model ? ["model"] : []),
			...(agent.thinkingLevel || config.thinkingLevel ? ["thinkingLevel"] : []),
			...(config.tools ? ["tools"] : []),
		],
		unsupported: ["approvalPolicy", "sandboxProfile", "providerHeaders", "extensionState"],
	};
}

export function interruptedRpcOutcome(
	output: string,
	telemetry: TransportTelemetry,
	failurePhase: TransportTelemetry["phase"],
): TurnOutcome {
	return {
		output,
		exitCode: 130,
		aborted: true,
		error: "RPC subagent was aborted",
		telemetry: {
			...telemetry,
			phase: "interrupted",
			failurePhase,
			updatedAt: Date.now(),
		},
	};
}

export function boundedError(error: unknown): string {
	return boundedPrivateText(
		error instanceof Error ? error.message : String(error),
		DEFAULT_MAX_OUTPUT_BYTES,
	);
}
