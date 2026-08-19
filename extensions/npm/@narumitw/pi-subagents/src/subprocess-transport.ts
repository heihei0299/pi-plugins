import { discoverAgents } from "./agents/discovery.js";
import type { AgentConfig, SubagentSettings, SubagentThinkingLevel } from "./agents/types.js";
import {
	CHILD_PEER_TOOL_NAMES,
	childPeerBridgePath,
	type PeerTransportRuntime,
	peerBridgeEnvironment,
} from "./peer-transport.js";
import { resolvePiPromptResources } from "./prompt-resources.js";
import type { ManagedAgent, TurnOutcome } from "./registry.js";
import { getResultFinalOutput, runSingleAgent, type SubagentDetails } from "./runner.js";
import { readSubagentSettings, resolveSubagentThinkingLevel } from "./settings.js";
import { buildStatefulTurnPrompt, resolveStatefulTurnTimeout } from "./stateful-prompt.js";
import type { SubagentTransport } from "./transport.js";
import type { TransportProgressCallback, TransportTelemetry } from "./transport-types.js";

export function resolveStatefulSubprocessThinkingLevel(
	agents: readonly Pick<AgentConfig, "name" | "thinkingLevel">[],
	record: Pick<ManagedAgent, "agent" | "thinkingLevel">,
): SubagentThinkingLevel | undefined {
	return resolveSubagentThinkingLevel(agents, record.agent, record.thinkingLevel);
}

export interface SubprocessTransportOptions {
	getSettings?: () => SubagentSettings | undefined;
	peerRuntime?: PeerTransportRuntime;
}

export class SubprocessTransport implements SubagentTransport {
	readonly kind = "subprocess" as const;

	constructor(private readonly options: SubprocessTransportOptions = {}) {}

	async runTurn(
		record: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome> {
		const startedAt = Date.now();
		const starting: TransportTelemetry = {
			transport: "subprocess",
			phase: "starting",
			updatedAt: startedAt,
			timing: { startedAt, transportStartedAt: startedAt },
		};
		onProgress?.(starting);
		const settings = this.options.getSettings ? this.options.getSettings() : readSubagentSettings();
		const discovery = discoverAgents(record.cwd, record.agentScope ?? "user", settings);
		const agent = discovery.agents.find((candidate) => candidate.name === record.agent);
		const boundedTask = buildStatefulTurnPrompt(record, task);
		const projectTrust =
			record.target?.trust.projectTrusted ??
			(record.agentScope === "project" || record.agentScope === "both");
		const promptResources = agent?.systemPrompt.trim()
			? await resolvePiPromptResources(record.cwd, projectTrust)
			: undefined;
		const makeDetails = (results: SubagentDetails["results"]): SubagentDetails => ({
			mode: "single",
			agentScope: record.agentScope ?? "user",
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});
		const credentials = this.options.peerRuntime
			? await this.options.peerRuntime.issueCredentials(
					record.id,
					record.currentTurnGeneration ?? record.turnGeneration ?? 1,
				)
			: undefined;
		let single: Awaited<ReturnType<typeof runSingleAgent>>;
		try {
			single = await runSingleAgent(
				record.cwd,
				discovery.agents,
				record.agent,
				boundedTask.text,
				undefined,
				undefined,
				signal,
				resolveStatefulSubprocessThinkingLevel(discovery.agents, record),
				record.currentTimeoutMs ?? record.timeoutMs ?? resolveStatefulTurnTimeout(agent),
				undefined,
				makeDetails,
				undefined,
				{
					projectTrust,
					...(record.executionPlan ? { tools: record.executionPlan.effectiveTools } : {}),
					appendSystemPromptPaths: promptResources?.appendSystemPromptPaths,
					extensionPaths: credentials ? [childPeerBridgePath()] : undefined,
					additionalTools: credentials ? [...CHILD_PEER_TOOL_NAMES] : undefined,
					env: credentials ? peerBridgeEnvironment(credentials) : undefined,
					timeoutResultFormat: record.resultFormat,
					turnLimits: {
						idleTimeoutMs: record.currentIdleTimeoutMs ?? record.idleTimeoutMs,
						maxTurns: record.currentMaxTurns ?? record.maxTurns,
						maxToolCalls: record.currentMaxToolCalls ?? record.maxToolCalls,
					},
					resultFormat: record.resultFormat,
					contract: record.contract,
					executionPlan: record.executionPlan,
					displayTask: task,
				},
			);
		} finally {
			this.options.peerRuntime?.revoke(record.id);
		}
		const settledAt = Date.now();
		const telemetry: TransportTelemetry = {
			...starting,
			phase: single.aborted ? "interrupted" : single.exitCode === 0 ? "settled" : "failed",
			failurePhase: single.exitCode === 0 ? undefined : "running",
			updatedAt: settledAt,
			timing: {
				...starting.timing,
				promptAcceptedAt: single.processStarted ? startedAt : undefined,
				firstActivityAt: single.messages.length > 0 ? settledAt : undefined,
				settledAt,
			},
			provider: single.actualProvider,
			model: single.actualModel ?? single.model,
			thinkingLevel: single.thinkingLevel,
			usage: {
				input: single.usage.input,
				output: single.usage.output,
				cacheRead: single.usage.cacheRead,
				cacheWrite: single.usage.cacheWrite,
				totalTokens: single.usage.totalTokens ?? 0,
				cost: single.usage.cost,
				turns: single.usage.turns,
			},
		};
		onProgress?.(telemetry);
		return {
			output: getResultFinalOutput(single),
			exitCode: single.exitCode,
			aborted: single.aborted,
			truncated: single.truncated || boundedTask.truncated,
			error: single.errorMessage || single.stderr || undefined,
			policy: single.policy,
			termination: single.termination,
			telemetry,
		};
	}
}
