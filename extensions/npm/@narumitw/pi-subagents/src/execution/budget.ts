import type { AgentConfig } from "../agents/types.js";
import type { TurnLimits } from "../turn-budget.js";

export interface ExecutionBudget {
	timeoutMs: number;
	workTimeoutReason: "work_timeout" | "orchestration_timeout";
	workTimeoutReportLimit: number;
}

export function resolveConfiguredTimeout(
	agents: readonly AgentConfig[],
	agentName: string,
	localTimeoutMs: number | undefined,
	topLevelTimeoutMs: number | undefined,
	defaultTimeoutMs: number,
): number {
	return (
		localTimeoutMs ??
		topLevelTimeoutMs ??
		agents.find((agent) => agent.name === agentName)?.timeoutMs ??
		defaultTimeoutMs
	);
}

export function mergeTurnLimits(local: TurnLimits | undefined, fallback: TurnLimits): TurnLimits {
	return {
		idleTimeoutMs: local?.idleTimeoutMs ?? fallback.idleTimeoutMs,
		maxTurns: local?.maxTurns ?? fallback.maxTurns,
		maxToolCalls: local?.maxToolCalls ?? fallback.maxToolCalls,
	};
}

export function calculateExecutionBudget(input: {
	requestedTimeoutMs: number;
	orchestrationDeadline?: number;
	totalTimeoutMs?: number;
	now: number;
}): ExecutionBudget | undefined {
	if (input.orchestrationDeadline === undefined) {
		return {
			timeoutMs: input.requestedTimeoutMs,
			workTimeoutReason: "work_timeout",
			workTimeoutReportLimit: input.requestedTimeoutMs,
		};
	}
	const remaining = Math.floor(input.orchestrationDeadline - input.now);
	if (remaining < 1) return undefined;
	const orchestrationLimited = remaining < input.requestedTimeoutMs;
	return {
		timeoutMs: Math.min(input.requestedTimeoutMs, remaining),
		workTimeoutReason: orchestrationLimited ? "orchestration_timeout" : "work_timeout",
		workTimeoutReportLimit: orchestrationLimited
			? Math.floor(input.totalTimeoutMs as number)
			: input.requestedTimeoutMs,
	};
}
