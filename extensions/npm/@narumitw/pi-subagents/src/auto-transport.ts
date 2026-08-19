import { discoverAgents } from "./agents/discovery.js";
import type { SubagentSettings } from "./agents/types.js";
import type { AgentMailboxMessage, ManagedAgent, TurnOutcome } from "./registry.js";
import { isWriteCapable } from "./stateful-safety.js";
import type { SubagentTransport } from "./transport.js";
import type {
	EffectiveSubagentTransportKind,
	TransportProgressCallback,
} from "./transport-types.js";

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface AutoTransportOptions {
	subprocess: SubagentTransport;
	inProcess: SubagentTransport;
	rpc: SubagentTransport;
	getSettings?: () => SubagentSettings | undefined;
}

export interface AutoTransportSelection {
	kind: EffectiveSubagentTransportKind;
	reason: string;
}

export class AutoTransport implements SubagentTransport {
	readonly kind = "auto" as const;
	private readonly selections = new Map<string, AutoTransportSelection>();

	constructor(private readonly options: AutoTransportOptions) {}

	async runTurn(
		agent: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome> {
		const selection = this.selections.get(agent.id) ?? this.select(agent);
		this.selections.set(agent.id, selection);
		const transport = this.transport(selection.kind);
		const outcome = await transport.runTurn(agent, task, signal, (progress) =>
			onProgress?.({ ...progress, selectionReason: selection.reason }),
		);
		return {
			...outcome,
			telemetry: outcome.telemetry
				? { ...outcome.telemetry, selectionReason: selection.reason }
				: outcome.telemetry,
		};
	}

	async deliverMessage(agent: ManagedAgent, message: AgentMailboxMessage): Promise<boolean> {
		const selection = this.selections.get(agent.id);
		if (!selection) return false;
		return this.transport(selection.kind).deliverMessage?.(agent, message) ?? false;
	}

	async release(agent: ManagedAgent): Promise<void> {
		const selection = this.selections.get(agent.id);
		this.selections.delete(agent.id);
		if (selection) await this.transport(selection.kind).release?.(agent);
	}

	async shutdown(): Promise<void> {
		this.selections.clear();
		const transports = [this.options.subprocess, this.options.inProcess, this.options.rpc];
		const results = await Promise.allSettled(transports.map((transport) => transport.shutdown?.()));
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to shut down ${failures.length} auto transport(s)`,
			);
		}
	}

	selectionFor(agentId: string): AutoTransportSelection | undefined {
		const selection = this.selections.get(agentId);
		return selection ? { ...selection } : undefined;
	}

	private select(agent: ManagedAgent): AutoTransportSelection {
		const settings = this.options.getSettings?.();
		const config = discoverAgents(agent.cwd, agent.agentScope ?? "user", settings).agents.find(
			(candidate) => candidate.name === agent.agent,
		);
		if (!config) {
			throw new Error(`Automatic transport cannot resolve subagent ${agent.agent}`);
		}
		const effectiveTools = agent.executionPlan?.effectiveTools ?? config.tools;
		const unsupported = (effectiveTools ?? []).filter((tool) => !BUILT_IN_TOOL_NAMES.has(tool));
		if (unsupported.length > 0) {
			return {
				kind: "subprocess",
				reason: `extension/custom tools require subprocess: ${unsupported.join(", ")}`,
			};
		}
		if (isWriteCapable(effectiveTools)) {
			return {
				kind: "rpc",
				reason: "write-capable built-in tools use a persistent isolated process",
			};
		}
		return {
			kind: "in-process",
			reason: "read-only built-in tools use the lowest-overhead public SDK session",
		};
	}

	private transport(kind: EffectiveSubagentTransportKind): SubagentTransport {
		switch (kind) {
			case "subprocess":
				return this.options.subprocess;
			case "in-process":
				return this.options.inProcess;
			case "rpc":
				return this.options.rpc;
		}
	}
}
