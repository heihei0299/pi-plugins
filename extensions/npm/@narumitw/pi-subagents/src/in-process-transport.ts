import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionServices,
	getAgentDir,
	type ModelRegistry,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents/discovery.js";
import type { AgentConfig, SubagentThinkingLevel } from "./agents/types.js";
import { redactPrivateText } from "./context.js";
import { appendDelegationContract } from "./delegation-contract.js";
import { resolveDefaultSubagentTimeoutMs } from "./execution/runtime-policy.js";
import { DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";
import { resolvePiPromptResources } from "./prompt-resources.js";
import type { AgentTurn, ManagedAgent, TurnOutcome } from "./registry.js";
import { appendResultInstruction } from "./result-contract.js";
import { safeTerminalLine } from "./safe-text.js";
import { readSubagentSettings } from "./settings.js";
import {
	formatTimeoutCheckpoint,
	formatTurnTerminationMessage,
	journalMessages,
	TimeoutProgressJournal,
	TURN_TERMINATION_VERSION,
	type TurnTerminationReport,
} from "./timeout-checkpoint.js";
import {
	buildTimeoutFinalizationPrompt,
	resolveTimeoutFinalizationMs,
} from "./timeout-finalization.js";
import type { SubagentTransport } from "./transport.js";
import type { TransportProgressCallback, TransportTelemetry } from "./transport-types.js";
import { TurnBudgetMonitor, type TurnBudgetStop, type TurnLimits } from "./turn-budget.js";

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const DEFAULT_ABORT_GRACE_MS = 5_000;

interface ChildModelRuntime {
	getModel(provider: string, modelId: string): Model<Api> | undefined;
	registerProvider(provider: string, config: unknown): void;
	registerNativeProvider?(provider: unknown): void;
	setRuntimeApiKey(provider: string, apiKey: string): Promise<void> | void;
}

interface CodingAgentRuntimeModule {
	createAgentSessionFromServices?: typeof import("@earendil-works/pi-coding-agent").createAgentSessionFromServices;
	createAgentSessionServices?: typeof import("@earendil-works/pi-coding-agent").createAgentSessionServices;
	resolveCliModel?: typeof import("@earendil-works/pi-coding-agent").resolveCliModel;
}

interface CoreModelSupport {
	modelRuntime: ModelRuntime;
	resolveCliModel: typeof import("@earendil-works/pi-coding-agent").resolveCliModel;
}

interface CoreSessionSupport {
	createAgentSessionFromServices: typeof import("@earendil-works/pi-coding-agent").createAgentSessionFromServices;
	createAgentSessionServices: typeof import("@earendil-works/pi-coding-agent").createAgentSessionServices;
	resolveCliModel: typeof import("@earendil-works/pi-coding-agent").resolveCliModel;
}

interface RegisteredProviderRegistry {
	getRegisteredProviderConfig?(provider: string): unknown;
	getRegisteredProviderIds?(): readonly string[];
	getRegisteredNativeProvider?(provider: string): unknown;
}

export interface ParentRuntimeSnapshot {
	model: Model<Api> | undefined;
	thinkingLevel: SubagentThinkingLevel;
}

export interface ChildSession {
	readonly sessionId: string;
	readonly messages: readonly unknown[];
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: SubagentThinkingLevel;
	prompt(text: string): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	abort(): Promise<void>;
	dispose(): void;
	getActiveToolNames(): string[];
}

export interface ChildSessionCreateOptions {
	agent: ManagedAgent;
	agentConfig: AgentConfig;
	context?: string;
	history: AgentTurn[];
	modelRegistry: ModelRegistry;
	parentRuntime: ParentRuntimeSnapshot;
	tools?: string[];
}

export type ChildSessionFactory = (options: ChildSessionCreateOptions) => Promise<ChildSession>;

export interface InProcessTransportOptions {
	modelRegistry: ModelRegistry;
	getParentRuntime: () => ParentRuntimeSnapshot;
	createSession?: ChildSessionFactory;
	discoverAgent?: (agent: ManagedAgent) => AgentConfig | undefined;
	defaultTimeoutMs?: number;
	abortGraceMs?: number;
	timeoutFinalizationMs?: number;
}

interface ChildSessionRecord {
	session: ChildSession;
	unsubscribe: () => void;
	lastOutput: string;
	disposed: boolean;
}

type PromptSettlement =
	| { kind: "completed" }
	| { kind: "failed"; error: unknown }
	| { kind: "timeout" }
	| { kind: "limit"; stop: TurnBudgetStop }
	| { kind: "aborted" };

export class InProcessTransport implements SubagentTransport {
	readonly kind = "in-process" as const;
	private readonly sessions = new Map<string, ChildSessionRecord>();
	private readonly createSession: ChildSessionFactory;
	private readonly discoverAgent: (agent: ManagedAgent) => AgentConfig | undefined;
	private readonly defaultTimeoutMs: number;
	private readonly abortGraceMs: number;

	constructor(private readonly options: InProcessTransportOptions) {
		this.createSession = options.createSession ?? createSdkChildSession;
		this.discoverAgent =
			options.discoverAgent ??
			((agent) =>
				discoverAgents(agent.cwd, agent.agentScope ?? "user", readSubagentSettings()).agents.find(
					(candidate) => candidate.name === agent.agent,
				));
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? resolveDefaultSubagentTimeoutMs();
		this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
	}

	async runTurn(
		agent: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome> {
		const startedAt = Date.now();
		let telemetry: TransportTelemetry = {
			transport: "in-process",
			phase: "starting",
			updatedAt: startedAt,
			timing: { startedAt, transportStartedAt: startedAt },
		};
		const publish = (patch: Partial<TransportTelemetry>) => {
			telemetry = {
				...telemetry,
				...patch,
				timing: { ...telemetry.timing, ...patch.timing },
				updatedAt: Date.now(),
			};
			onProgress?.({ ...telemetry, timing: { ...telemetry.timing } });
		};
		publish({});
		if (signal.aborted) {
			publish({ phase: "interrupted", failurePhase: "starting" });
			return { ...interruptedOutcome(""), telemetry };
		}
		const agentConfig = this.discoverAgent(agent);
		if (!agentConfig) {
			publish({ phase: "failed", failurePhase: "starting" });
			return {
				output: "",
				exitCode: 1,
				error: `Unknown subagent: ${agent.agent}`,
				telemetry,
			};
		}
		let tools: string[] | undefined;
		try {
			tools = validateInProcessTools(agent.executionPlan?.effectiveTools ?? agentConfig.tools);
		} catch (error) {
			publish({ phase: "failed", failurePhase: "starting" });
			return { output: "", exitCode: 1, error: errorMessage(error), telemetry };
		}
		let record: ChildSessionRecord;
		try {
			record = await this.getOrCreate(agent, agentConfig, tools);
		} catch (error) {
			publish({ phase: "failed", failurePhase: "starting" });
			return { output: "", exitCode: 1, error: errorMessage(error), telemetry };
		}
		publish({
			phase: "ready",
			provider: record.session.provider,
			model: record.session.model,
			thinkingLevel: record.session.thinkingLevel,
			timing: { readyAt: Date.now() },
		});
		if (signal.aborted) {
			await this.releaseById(agent.id).catch(() => undefined);
			publish({ phase: "interrupted", failurePhase: "ready" });
			return { ...interruptedOutcome(""), telemetry };
		}
		const prompt = buildCurrentTurnPrompt(agent, task);
		const timeoutMs =
			agent.currentTimeoutMs ?? agent.timeoutMs ?? agentConfig.timeoutMs ?? this.defaultTimeoutMs;
		const startingMessageCount = record.session.messages.length;
		record.lastOutput = "";
		publish({ phase: "running", timing: { promptAcceptedAt: Date.now() } });
		const settlement = await this.runPrompt(record, prompt, signal, timeoutMs, {
			idleTimeoutMs: agent.currentIdleTimeoutMs ?? agent.idleTimeoutMs,
			maxTurns: agent.currentMaxTurns ?? agent.maxTurns,
			maxToolCalls: agent.currentMaxToolCalls ?? agent.maxToolCalls,
		});
		const final = latestAssistant(record.session.messages.slice(startingMessageCount));
		const output = truncateUtf8(final.output || record.lastOutput, DEFAULT_MAX_OUTPUT_BYTES);
		const truncated = output.truncated || agent.contextTruncated;
		const policy = inProcessPolicy(agentConfig, agent);
		const settledAt = Date.now();
		if (signal.aborted && (settlement.kind === "timeout" || settlement.kind === "limit")) {
			publish({ phase: "interrupted", failurePhase: "running", timing: { settledAt } });
			return {
				...interruptedOutcome(output.text),
				truncated,
				policy,
				telemetry,
			};
		}

		switch (settlement.kind) {
			case "completed":
				publish({
					phase: final.stopReason === "error" ? "failed" : "settled",
					timing: { settledAt },
				});
				if (final.stopReason === "error") {
					return {
						output: output.text,
						exitCode: 1,
						truncated,
						error: final.error || "In-process subagent returned an error",
						policy,
						telemetry,
					};
				}
				if (final.stopReason === "aborted") {
					publish({ phase: "interrupted", failurePhase: "running" });
					return {
						...interruptedOutcome(output.text),
						truncated,
						policy,
						telemetry,
					};
				}
				return {
					output: output.text,
					exitCode: 0,
					truncated,
					policy,
					telemetry,
				};
			case "failed":
				publish({ phase: "failed", failurePhase: "running", timing: { settledAt } });
				return {
					output: output.text,
					exitCode: 1,
					truncated,
					error: errorMessage(settlement.error),
					policy,
					telemetry,
				};
			case "timeout":
			case "limit": {
				const stop =
					settlement.kind === "limit"
						? settlement.stop
						: ({ reason: "work_timeout", limit: timeoutMs } as const);
				const journal = new TimeoutProgressJournal();
				journalMessages(journal, record.session.messages.slice(startingMessageCount));
				const termination: TurnTerminationReport = {
					version: TURN_TERMINATION_VERSION,
					reason: stop.reason,
					limit: stop.limit,
					checkpoint: journal.checkpoint(task, output.text),
					finalization: { attempted: false, status: "skipped", durationMs: 0 },
				};
				let finalizedOutput = output.text || formatTimeoutCheckpoint(termination.checkpoint);
				let finalizationError: string | undefined;
				if (!signal.aborted && this.sessions.get(agent.id) === record) {
					publish({ phase: "finalizing", failurePhase: "running" });
					const summaryStart = record.session.messages.length;
					const finalizationStartedAt = Date.now();
					record.lastOutput = "";
					const summarySettlement = await this.runPrompt(
						record,
						buildTimeoutFinalizationPrompt({
							task,
							partialOutput: output.text,
							checkpoint: termination.checkpoint,
							terminationReason: stop.reason,
							resultFormat: agent.resultFormat,
						}),
						signal,
						resolveTimeoutFinalizationMs(timeoutMs, this.options.timeoutFinalizationMs),
					);
					const summary = latestAssistant(record.session.messages.slice(summaryStart));
					const boundedSummary = truncateUtf8(
						summary.output || record.lastOutput,
						DEFAULT_MAX_OUTPUT_BYTES,
					);
					if (
						summarySettlement.kind === "completed" &&
						summary.stopReason !== "error" &&
						boundedSummary.text.trim()
					) {
						finalizedOutput = boundedSummary.text;
						termination.finalization = {
							attempted: true,
							status: "completed",
							durationMs: Date.now() - finalizationStartedAt,
						};
					} else {
						finalizationError =
							summarySettlement.kind === "failed"
								? errorMessage(summarySettlement.error)
								: `timeout summary ${summarySettlement.kind}`;
						termination.finalization = {
							attempted: true,
							status: summarySettlement.kind === "timeout" ? "timed_out" : "failed",
							durationMs: Date.now() - finalizationStartedAt,
							error: finalizationError,
						};
					}
				}
				publish({ phase: "failed", failurePhase: "running", timing: { settledAt: Date.now() } });
				return {
					output: finalizedOutput,
					exitCode: 124,
					truncated,
					error: [
						formatTurnTerminationMessage(stop.reason, stop.limit, "In-process subagent"),
						finalizationError,
					]
						.filter(Boolean)
						.join("; "),
					policy,
					termination,
					telemetry,
				};
			}
			case "aborted":
				publish({ phase: "interrupted", failurePhase: "running", timing: { settledAt } });
				return {
					...interruptedOutcome(output.text),
					truncated,
					policy,
					telemetry,
				};
		}
	}

	async release(agent: ManagedAgent): Promise<void> {
		await this.releaseById(agent.id);
	}

	async shutdown(): Promise<void> {
		const agentIds = [...this.sessions.keys()];
		const results = await Promise.allSettled(agentIds.map((agentId) => this.releaseById(agentId)));
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to dispose ${failures.length} in-process subagent session(s)`,
			);
		}
	}

	private async releaseById(agentId: string): Promise<void> {
		const record = this.sessions.get(agentId);
		if (!record) return;
		this.sessions.delete(agentId);
		if (record.disposed) return;
		record.disposed = true;
		const failures: unknown[] = [];
		try {
			record.unsubscribe();
		} catch (error) {
			failures.push(error);
		}
		if (record.session.messages.length > 0) {
			await settleWithin(record.session.abort(), this.abortGraceMs);
		}
		try {
			record.session.dispose();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`Failed to release in-process subagent ${agentId}: ${failures.map(errorMessage).join("; ")}`,
			);
		}
	}

	private async getOrCreate(
		agent: ManagedAgent,
		agentConfig: AgentConfig,
		tools: string[] | undefined,
	): Promise<ChildSessionRecord> {
		const existing = this.sessions.get(agent.id);
		if (existing) return existing;
		const session = await this.createSession({
			agent,
			agentConfig,
			context: agent.context,
			history: agent.history.map((turn) => ({ ...turn })),
			modelRegistry: this.options.modelRegistry,
			parentRuntime: this.options.getParentRuntime(),
			tools,
		});
		const record: ChildSessionRecord = {
			session,
			lastOutput: "",
			disposed: false,
			unsubscribe: () => undefined,
		};
		try {
			record.unsubscribe = session.subscribe((event) => {
				const message = eventMessage(event);
				if (!message) return;
				const output = assistantText(message);
				if (output) record.lastOutput = truncateUtf8(output, DEFAULT_MAX_OUTPUT_BYTES).text;
			});
		} catch (error) {
			record.disposed = true;
			try {
				session.dispose();
			} catch {
				// Preserve the subscription failure, which explains why creation was rejected.
			}
			throw error;
		}
		this.sessions.set(agent.id, record);
		return record;
	}

	private async runPrompt(
		record: ChildSessionRecord,
		prompt: string,
		signal: AbortSignal,
		timeoutMs: number,
		limits: TurnLimits = {},
	): Promise<PromptSettlement> {
		if (signal.aborted) return { kind: "aborted" };
		let timeout: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;
		let resolveLimit!: (settlement: PromptSettlement) => void;
		const limitSettlement = new Promise<PromptSettlement>((resolve) => {
			resolveLimit = resolve;
		});
		const monitor = new TurnBudgetMonitor({
			...limits,
			onExceeded: (stop) => resolveLimit({ kind: "limit", stop }),
		});
		const unsubscribeBudget = record.session.subscribe((event) => {
			const type = childEventType(event);
			if (type === "tool_execution_end") monitor.recordActivity();
			if (type !== "message_end") return;
			const message = eventMessage(event);
			if (!message || typeof message !== "object" || Array.isArray(message)) return;
			const value = message as Record<string, unknown>;
			if (value.role === "toolResult") {
				monitor.recordActivity();
				return;
			}
			if (value.role !== "assistant") return;
			monitor.recordToolCalls(assistantToolCallCount(value.content));
			monitor.recordAssistantTurn(
				typeof value.stopReason === "string" ? value.stopReason : undefined,
			);
		});
		const promptSettlement: Promise<PromptSettlement> = Promise.resolve()
			.then(() => {
				if (signal.aborted) throw new Error("In-process subagent prompt aborted before start");
				return record.session.prompt(prompt);
			})
			.then(() => ({ kind: "completed" as const }))
			.catch((error: unknown) => ({ kind: "failed" as const, error }));
		const timeoutSettlement = new Promise<PromptSettlement>((resolve) => {
			timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
		});
		const abortSettlement = new Promise<PromptSettlement>((resolve) => {
			abortHandler = () => resolve({ kind: "aborted" });
			signal.addEventListener("abort", abortHandler, { once: true });
			if (signal.aborted) abortHandler();
		});
		const settlement = await Promise.race([
			promptSettlement,
			timeoutSettlement,
			abortSettlement,
			limitSettlement,
		]);
		if (timeout) clearTimeout(timeout);
		if (abortHandler) signal.removeEventListener("abort", abortHandler);
		try {
			unsubscribeBudget();
		} catch {
			// The owning record's unsubscribe/dispose path remains authoritative.
		}
		monitor.dispose();
		if (
			settlement.kind === "timeout" ||
			settlement.kind === "limit" ||
			settlement.kind === "aborted"
		) {
			const [, settledAfterAbort] = await Promise.all([
				settleWithin(record.session.abort(), this.abortGraceMs),
				completesWithin(promptSettlement, this.abortGraceMs),
			]);
			if (!settledAfterAbort) this.discardRecord(record);
		}
		return settlement;
	}

	private discardRecord(record: ChildSessionRecord): void {
		for (const [agentId, candidate] of this.sessions) {
			if (candidate === record) this.sessions.delete(agentId);
		}
		if (record.disposed) return;
		record.disposed = true;
		record.unsubscribe();
		record.session.dispose();
	}
}

export function validateInProcessTools(tools: string[] | undefined): string[] | undefined {
	if (tools === undefined) return undefined;
	const unique = [...new Set(tools)];
	const unsupported = unique.filter((tool) => !BUILT_IN_TOOL_NAMES.has(tool));
	if (unsupported.length > 0) {
		throw new Error(
			`In-process subagents cannot load extension/custom tools: ${unsupported.map((tool) => safeTerminalLine(tool, 256)).join(", ")}. Use stateful.transport "subprocess" for this agent.`,
		);
	}
	return unique;
}

export async function createSdkChildSession(
	options: ChildSessionCreateOptions,
): Promise<ChildSession> {
	const agentDir = getAgentDir();
	const projectTrusted =
		options.agent.target?.trust.projectTrusted ??
		(options.agent.agentScope === "project" || options.agent.agentScope === "both");
	const { services, support: coreSupport } = await prepareInProcessServices(
		options.agent.cwd,
		agentDir,
		options.agentConfig.systemPrompt,
		projectTrusted,
	);
	copyRegisteredProviders(
		options.modelRegistry as unknown as RegisteredProviderRegistry,
		services.modelRuntime as unknown as ChildModelRuntime,
	);
	const modelSupport: CoreModelSupport = {
		modelRuntime: services.modelRuntime,
		resolveCliModel: coreSupport.resolveCliModel,
	};
	const resolved = await resolveChildModel(options, modelSupport);
	await transferChildModelAuth(options.modelRegistry, resolved.model, services.modelRuntime);
	const model = resolved.model;
	const sessionManager = SessionManager.inMemory(options.agent.cwd);
	seedChildSessionManager(sessionManager, options, model);
	const created = await coreSupport.createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		thinkingLevel: resolved.thinkingLevel,
		tools: options.tools,
		noTools: options.tools?.length === 0 ? "all" : undefined,
	});
	const session = created.session;
	if (options.tools !== undefined) {
		const active = session.getActiveToolNames();
		const expected = [...options.tools].sort();
		if (
			active.length !== expected.length ||
			[...active].sort().some((name, index) => name !== expected[index])
		) {
			session.dispose();
			throw new Error(
				`In-process child activated an unexpected tool set (${active.join(", ") || "none"}); use stateful.transport "subprocess".`,
			);
		}
	}
	return {
		get sessionId() {
			return session.sessionId;
		},
		get messages() {
			return session.messages;
		},
		get provider() {
			return session.model?.provider;
		},
		get model() {
			return session.model?.id;
		},
		get thinkingLevel() {
			return session.thinkingLevel;
		},
		prompt: (text) => session.prompt(text),
		subscribe: (listener) => session.subscribe((event) => listener(event)),
		abort: () => session.abort(),
		dispose: () => session.dispose(),
		getActiveToolNames: () => session.getActiveToolNames(),
	};
}

async function loadCoreSessionSupport(): Promise<CoreSessionSupport | undefined> {
	const codingAgentModule = (await import(
		"@earendil-works/pi-coding-agent"
	)) as unknown as CodingAgentRuntimeModule;
	if (
		!codingAgentModule.createAgentSessionFromServices ||
		!codingAgentModule.createAgentSessionServices ||
		!codingAgentModule.resolveCliModel
	) {
		return undefined;
	}
	return {
		createAgentSessionFromServices: codingAgentModule.createAgentSessionFromServices,
		createAgentSessionServices: codingAgentModule.createAgentSessionServices,
		resolveCliModel: codingAgentModule.resolveCliModel,
	};
}

async function transferChildModelAuth(
	modelRegistry: ModelRegistry,
	model: Model<Api>,
	modelRuntime: ModelRuntime,
): Promise<void> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok && auth.apiKey) await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
}

export function copyRegisteredProviders(
	registeredProviders: RegisteredProviderRegistry,
	modelRuntime: ChildModelRuntime,
): void {
	for (const provider of registeredProviders.getRegisteredProviderIds?.() ?? []) {
		const config = registeredProviders.getRegisteredProviderConfig?.(provider);
		if (config !== undefined) {
			modelRuntime.registerProvider(provider, config);
			continue;
		}
		const nativeProvider = registeredProviders.getRegisteredNativeProvider?.(provider);
		if (nativeProvider) modelRuntime.registerNativeProvider?.(nativeProvider);
	}
}

export async function resolveChildModel(
	options: ChildSessionCreateOptions,
	support?: CoreModelSupport,
): Promise<{
	model: Model<Api>;
	thinkingLevel: SubagentThinkingLevel;
}> {
	if (!support) throw unsupportedInProcessCoreError();
	let model = options.parentRuntime.model;
	let modelThinkingLevel: SubagentThinkingLevel | undefined;
	if (options.agentConfig.model !== undefined) {
		const requested = options.agentConfig.model.trim();
		if (!requested) throw new Error("In-process subagent model cannot be empty");
		const resolved = support.resolveCliModel({
			cliModel: requested,
			modelRuntime: support.modelRuntime,
		});
		if (resolved.error) throw new Error(resolved.error);
		if (!resolved.model)
			throw new Error(`Unable to resolve in-process subagent model ${requested}`);
		model = resolved.model;
		modelThinkingLevel = resolved.thinkingLevel;
	}
	if (!model) model = options.modelRegistry.getAvailable()[0];
	if (!model)
		throw new Error("No model with configured authentication is available for in-process subagent");
	model = support.modelRuntime.getModel(model.provider, model.id) ?? model;
	return {
		model,
		thinkingLevel:
			options.agent.thinkingLevel ??
			options.agentConfig.thinkingLevel ??
			modelThinkingLevel ??
			options.parentRuntime.thinkingLevel,
	};
}

function unsupportedInProcessCoreError(): Error {
	return new Error(
		'In-process subagents require Pi core createAgentSessionServices, createAgentSessionFromServices, and resolveCliModel support; set stateful.transport to "subprocess".',
	);
}

async function prepareInProcessServices(
	cwd: string,
	agentDir: string,
	agentSystemPrompt: string,
	projectTrusted: boolean,
): Promise<{ services: AgentSessionServices; support: CoreSessionSupport }> {
	const promptResources = await resolvePiPromptResources(cwd, projectTrusted, agentDir);
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const support = await loadCoreSessionSupport();
	if (!support) throw unsupportedInProcessCoreError();
	const services = await support.createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			appendSystemPrompt: [
				...promptResources.appendSystemPromptPaths,
				...(agentSystemPrompt.trim() ? [agentSystemPrompt] : []),
			],
		},
	});
	return { services, support };
}

export async function createInProcessServices(
	cwd: string,
	agentDir: string,
	agentSystemPrompt: string,
	projectTrusted = false,
): Promise<AgentSessionServices> {
	return (await prepareInProcessServices(cwd, agentDir, agentSystemPrompt, projectTrusted))
		.services;
}

export function seedChildSessionManager(
	sessionManager: SessionManager,
	options: ChildSessionCreateOptions,
	model: Model<Api>,
): void {
	let timestamp = Date.now() - (options.history.length * 2 + 1);
	if (options.context?.trim()) {
		sessionManager.appendMessage({
			role: "user",
			content: `Parent context:\n${redactPrivateText(options.context)}`,
			timestamp: timestamp++,
		});
	}
	for (const turn of options.history) {
		sessionManager.appendMessage({
			role: "user",
			content: redactPrivateText(turn.task),
			timestamp: timestamp++,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: redactPrivateText(turn.output) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: turn.exitCode === 0 ? "stop" : "error",
			timestamp: timestamp++,
		});
	}
}

export function buildCurrentTurnPrompt(agent: ManagedAgent, task: string): string {
	const ids = new Set(agent.currentMailboxMessageIds ?? []);
	const messages = agent.mailbox
		.filter((message) => ids.has(message.id))
		.slice(-20)
		.map((message) => `From ${message.senderId}: ${redactPrivateText(message.content)}`)
		.join("\n");
	const base = messages
		? `${redactPrivateText(task)}\n\nMailbox messages:\n${messages}`
		: redactPrivateText(task);
	const contracted = appendDelegationContract(base, agent.contract, DEFAULT_MAX_CONTEXT_BYTES);
	return truncateUtf8(
		appendResultInstruction(contracted.text, agent.resultFormat),
		DEFAULT_MAX_CONTEXT_BYTES,
	).text;
}

function latestAssistant(messages: readonly unknown[]): {
	output: string;
	stopReason?: string;
	error?: string;
} {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const candidate = message as { role?: string; stopReason?: string; errorMessage?: string };
		if (candidate.role !== "assistant") continue;
		return {
			output: assistantText(message),
			stopReason: candidate.stopReason,
			error: candidate.errorMessage,
		};
	}
	return { output: "" };
}

function childEventType(event: unknown): string | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" ? type : undefined;
}

function assistantToolCallCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter(
		(part) =>
			part &&
			typeof part === "object" &&
			!Array.isArray(part) &&
			(part as { type?: unknown }).type === "toolCall",
	).length;
}

function eventMessage(event: unknown): unknown {
	if (!event || typeof event !== "object") return undefined;
	const candidate = event as { type?: string; message?: unknown };
	return candidate.type === "message_update" || candidate.type === "message_end"
		? candidate.message
		: undefined;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			),
		)
		.map((part) => part.text)
		.join("\n");
}

function interruptedOutcome(output: string): TurnOutcome {
	return { output, exitCode: 130, aborted: true, error: "In-process subagent was aborted" };
}

function inProcessPolicy(
	agentConfig: AgentConfig,
	managedAgent: ManagedAgent,
): NonNullable<TurnOutcome["policy"]> {
	return {
		inherited: ["modelRegistry", "authentication", "cwdResources"],
		overridden: [
			...(agentConfig.model ? ["model"] : []),
			...(managedAgent.thinkingLevel || agentConfig.thinkingLevel ? ["thinkingLevel"] : []),
			...(agentConfig.tools ? ["tools"] : []),
		],
		unsupported: ["approvalPolicy", "sandboxProfile", "providerHeaders", "extensionState"],
	};
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	await completesWithin(
		promise.catch(() => undefined),
		timeoutMs,
	);
}

async function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function errorMessage(error: unknown): string {
	return truncateUtf8(
		error instanceof Error ? error.message : String(error),
		DEFAULT_MAX_OUTPUT_BYTES,
	).text;
}
