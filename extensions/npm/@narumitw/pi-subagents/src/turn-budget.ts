import { MAX_SUBAGENT_TIMEOUT_MS } from "./limits.js";
import type { TurnTerminationReason } from "./timeout-checkpoint.js";

export const MAX_SUBAGENT_TURNS = 1_000_000;
export const MAX_SUBAGENT_TOOL_CALLS = 1_000_000;

export interface TurnLimits {
	idleTimeoutMs?: number;
	maxTurns?: number;
	maxToolCalls?: number;
}

export interface TurnBudgetStop {
	reason: Extract<TurnTerminationReason, "idle_timeout" | "turn_limit" | "tool_call_limit">;
	limit: number;
}

export interface TurnBudgetMonitorOptions extends TurnLimits {
	onExceeded(stop: TurnBudgetStop): void;
}

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

export function validateTurnLimits(limits: TurnLimits): TurnLimits {
	validateOptionalInteger("idleTimeoutMs", limits.idleTimeoutMs, MAX_SUBAGENT_TIMEOUT_MS);
	validateOptionalInteger("maxTurns", limits.maxTurns, MAX_SUBAGENT_TURNS);
	validateOptionalInteger("maxToolCalls", limits.maxToolCalls, MAX_SUBAGENT_TOOL_CALLS);
	return { ...limits };
}

export class TurnBudgetMonitor {
	private readonly limits: TurnLimits;
	private readonly onExceeded: (stop: TurnBudgetStop) => void;
	private idleTimer?: NodeJS.Timeout;
	private assistantTurns = 0;
	private toolCalls = 0;
	private stopped = false;

	constructor(options: TurnBudgetMonitorOptions) {
		this.limits = validateTurnLimits({
			idleTimeoutMs: options.idleTimeoutMs,
			maxTurns: options.maxTurns,
			maxToolCalls: options.maxToolCalls,
		});
		this.onExceeded = options.onExceeded;
		this.resetIdleTimer();
	}

	recordActivity(): void {
		if (this.stopped) return;
		this.resetIdleTimer();
	}

	recordAssistantTurn(stopReason?: string): void {
		if (this.stopped) return;
		this.assistantTurns++;
		this.recordActivity();
		if (
			this.limits.maxTurns !== undefined &&
			this.assistantTurns >= this.limits.maxTurns &&
			!TERMINAL_STOP_REASONS.has(stopReason ?? "")
		) {
			this.exceed({ reason: "turn_limit", limit: this.limits.maxTurns });
		}
	}

	recordToolCalls(count = 1): void {
		if (this.stopped || count < 1) return;
		this.toolCalls += count;
		if (this.limits.maxToolCalls !== undefined && this.toolCalls > this.limits.maxToolCalls) {
			this.exceed({ reason: "tool_call_limit", limit: this.limits.maxToolCalls });
		}
	}

	dispose(): void {
		this.stopped = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const idleTimeoutMs = this.limits.idleTimeoutMs;
		if (idleTimeoutMs === undefined || this.stopped) {
			this.idleTimer = undefined;
			return;
		}
		this.idleTimer = setTimeout(
			() => this.exceed({ reason: "idle_timeout", limit: idleTimeoutMs }),
			idleTimeoutMs,
		);
		this.idleTimer.unref?.();
	}

	private exceed(stop: TurnBudgetStop): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.onExceeded(stop);
	}
}

function validateOptionalInteger(name: string, value: number | undefined, maximum: number): void {
	if (value === undefined) return;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
}
