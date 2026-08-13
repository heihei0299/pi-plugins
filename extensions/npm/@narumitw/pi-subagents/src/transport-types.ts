import type { SubagentThinkingLevel } from "./agents/types.js";

export const PI_SUBAGENTS_RPC_PROTOCOL = "pi-subagents:v1" as const;

export type EffectiveSubagentTransportKind = "subprocess" | "in-process" | "rpc";

export type TransportProgressPhase =
	| "queued"
	| "starting"
	| "ready"
	| "accepted"
	| "running"
	| "finalizing"
	| "retrying"
	| "compacting"
	| "settled"
	| "failed"
	| "interrupted";

export interface TransportUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

export interface TransportTiming {
	queuedAt?: number;
	startedAt?: number;
	transportStartedAt?: number;
	readyAt?: number;
	promptAcceptedAt?: number;
	firstActivityAt?: number;
	settledAt?: number;
	completionDeliveredAt?: number;
}

export interface TransportTelemetry {
	transport?: EffectiveSubagentTransportKind;
	selectionReason?: string;
	protocol?: typeof PI_SUBAGENTS_RPC_PROTOCOL;
	phase: TransportProgressPhase;
	queuePosition?: number;
	updatedAt: number;
	timing: TransportTiming;
	provider?: string;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	usage?: TransportUsage;
	failurePhase?: TransportProgressPhase;
}

export type TransportProgressCallback = (progress: TransportTelemetry) => void;

export function emptyTransportUsage(): TransportUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		turns: 0,
	};
}
