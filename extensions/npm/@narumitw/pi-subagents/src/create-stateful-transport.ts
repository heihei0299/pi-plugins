import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentSettings, SubagentTransportKind } from "./agents/types.js";
import { cachedModuleLoader, throwIfAborted } from "./cached-module-loader.js";
import type { ChildSessionFactory, ParentRuntimeSnapshot } from "./in-process-transport.js";
import type { ManagedAgent, TurnOutcome } from "./registry.js";
import type { SubagentTransport } from "./transport.js";
import type { TransportProgressCallback } from "./transport-types.js";

export interface CreateStatefulTransportOptions {
	kind: SubagentTransportKind;
	modelRegistry: ModelRegistry;
	getParentRuntime(): ParentRuntimeSnapshot;
	getSettings(): SubagentSettings | undefined;
	createInProcessSession?: ChildSessionFactory;
	loadTransport?: () => Promise<SubagentTransport>;
}

export function createStatefulTransport(
	options: CreateStatefulTransportOptions,
): SubagentTransport {
	return new LazyStatefulTransport(
		options.kind,
		cachedModuleLoader(options.loadTransport ?? (() => loadStatefulTransport(options))),
	);
}

class LazyStatefulTransport implements SubagentTransport {
	private loaded: SubagentTransport | undefined;
	private loading: Promise<SubagentTransport> | undefined;
	private closed = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(
		readonly kind: SubagentTransportKind,
		private readonly loadImplementation: () => Promise<SubagentTransport>,
	) {}

	async runTurn(
		agent: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome> {
		if (this.closed) throw new Error("Subagent transport is shut down");
		throwIfAborted(signal, "Subagent transport loading was cancelled");
		let transport: SubagentTransport;
		try {
			transport = await this.load();
		} catch (error) {
			throwIfAborted(signal, "Subagent transport loading was cancelled");
			throw error;
		}
		throwIfAborted(signal, "Subagent transport loading was cancelled");
		if (this.closed) {
			await this.shutdownLoaded();
			throw new Error("Subagent transport shut down while loading");
		}
		return transport.runTurn(agent, task, signal, onProgress);
	}

	async release(agent: ManagedAgent): Promise<void> {
		const transport =
			this.loaded ?? (this.loading ? await this.loading.catch(() => undefined) : undefined);
		if (!transport || this.closed) return;
		await transport.release?.(agent);
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		if (this.loading && !this.loaded) await this.loading.catch(() => undefined);
		await this.shutdownLoaded();
	}

	private async load(): Promise<SubagentTransport> {
		if (this.loaded) return this.loaded;
		if (!this.loading) {
			this.loading = this.loadImplementation()
				.then((transport) => {
					this.loaded = transport;
					return transport;
				})
				.finally(() => {
					this.loading = undefined;
				});
		}
		return this.loading;
	}

	private async shutdownLoaded(): Promise<void> {
		if (!this.loaded) return;
		if (!this.shutdownPromise) {
			this.shutdownPromise = Promise.resolve(this.loaded.shutdown?.());
		}
		await this.shutdownPromise;
	}
}

async function loadStatefulTransport(
	options: CreateStatefulTransportOptions,
): Promise<SubagentTransport> {
	const subprocess = async () => {
		const { SubprocessTransport } = await import("./subprocess-transport.js");
		return new SubprocessTransport({ getSettings: options.getSettings });
	};
	const inProcess = async () => {
		const [{ discoverAgents }, { InProcessTransport }] = await Promise.all([
			import("./agents/discovery.js"),
			import("./in-process-transport.js"),
		]);
		return new InProcessTransport({
			modelRegistry: options.modelRegistry,
			getParentRuntime: options.getParentRuntime,
			createSession: options.createInProcessSession,
			discoverAgent: (agent) =>
				discoverAgents(agent.cwd, agent.agentScope ?? "user", options.getSettings()).agents.find(
					(candidate) => candidate.name === agent.agent,
				),
		});
	};
	const rpc = async () => {
		const { RpcTransport } = await import("./rpc-transport.js");
		return new RpcTransport({
			getSettings: options.getSettings,
			getParentRuntime: options.getParentRuntime,
		});
	};
	switch (options.kind) {
		case "subprocess":
			return subprocess();
		case "in-process":
			return inProcess();
		case "rpc":
			return rpc();
		case "auto": {
			const { AutoTransport } = await import("./auto-transport.js");
			return new AutoTransport({
				subprocess: new LazyStatefulTransport("subprocess", cachedModuleLoader(subprocess)),
				inProcess: new LazyStatefulTransport("in-process", cachedModuleLoader(inProcess)),
				rpc: new LazyStatefulTransport("rpc", cachedModuleLoader(rpc)),
				getSettings: options.getSettings,
			});
		}
	}
}
