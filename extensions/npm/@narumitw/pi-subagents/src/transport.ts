import type { ManagedAgent, TurnOutcome } from "./registry.js";
import type { TransportProgressCallback } from "./transport-types.js";

export interface SubagentTransport {
	readonly kind: "subprocess" | "in-process" | "rpc" | "auto" | "fake";
	runTurn(
		agent: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome>;
	release?(agent: ManagedAgent): Promise<void>;
	shutdown?(): Promise<void>;
}

export type AgentTurnRunner = (
	agent: ManagedAgent,
	task: string,
	signal: AbortSignal,
	onProgress?: TransportProgressCallback,
) => Promise<TurnOutcome>;

export class FunctionTransport implements SubagentTransport {
	readonly kind = "fake" as const;

	constructor(private readonly runner: AgentTurnRunner) {}

	runTurn(
		agent: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome> {
		return this.runner(agent, task, signal, onProgress);
	}
}

export function normalizeTransport(
	transport: SubagentTransport | AgentTurnRunner,
): SubagentTransport {
	return typeof transport === "function" ? new FunctionTransport(transport) : transport;
}
