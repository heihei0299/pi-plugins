import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents/discovery.js";
import type { SubagentSettings, SubagentTransportKind } from "./agents/types.js";
import { AutoTransport } from "./auto-transport.js";
import {
	type ChildSessionFactory,
	InProcessTransport,
	type ParentRuntimeSnapshot,
} from "./in-process-transport.js";
import { RpcTransport } from "./rpc-transport.js";
import { SubprocessTransport } from "./subprocess-transport.js";
import type { SubagentTransport } from "./transport.js";

export interface CreateStatefulTransportOptions {
	kind: SubagentTransportKind;
	modelRegistry: ModelRegistry;
	getParentRuntime(): ParentRuntimeSnapshot;
	getSettings(): SubagentSettings | undefined;
	createInProcessSession?: ChildSessionFactory;
}

export function createStatefulTransport(
	options: CreateStatefulTransportOptions,
): SubagentTransport {
	const subprocess = () => new SubprocessTransport({ getSettings: options.getSettings });
	const inProcess = () =>
		new InProcessTransport({
			modelRegistry: options.modelRegistry,
			getParentRuntime: options.getParentRuntime,
			createSession: options.createInProcessSession,
			discoverAgent: (agent) =>
				discoverAgents(agent.cwd, agent.agentScope ?? "user", options.getSettings()).agents.find(
					(candidate) => candidate.name === agent.agent,
				),
		});
	const rpc = () =>
		new RpcTransport({
			getSettings: options.getSettings,
			getParentRuntime: options.getParentRuntime,
		});
	switch (options.kind) {
		case "subprocess":
			return subprocess();
		case "in-process":
			return inProcess();
		case "rpc":
			return rpc();
		case "auto":
			return new AutoTransport({
				subprocess: subprocess(),
				inProcess: inProcess(),
				rpc: rpc(),
				getSettings: options.getSettings,
			});
	}
}
