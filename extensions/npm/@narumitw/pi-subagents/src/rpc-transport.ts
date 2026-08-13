import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents/discovery.js";
import type { AgentConfig, SubagentSettings } from "./agents/types.js";
import {
	buildCurrentTurnPrompt,
	type ParentRuntimeSnapshot,
	validateInProcessTools,
} from "./in-process-transport.js";
import {
	appendBounded,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_MAX_STDERR_BYTES,
	truncateUtf8,
} from "./limits.js";
import { type PiInvocation, resolvePiInvocation } from "./pi-invocation.js";
import { resolvePiPromptResources } from "./prompt-resources.js";
import { JsonLineDecoder } from "./protocol.js";
import type { ManagedAgent, TurnOutcome } from "./registry.js";
import { finalizeTimedOutRpcTurn } from "./rpc-timeout-finalization.js";
import {
	boundedError,
	interruptedRpcOutcome,
	modelIdentity,
	normalizeThinking,
	rpcPolicy,
} from "./rpc-transport-metadata.js";
import {
	captureRpcEvent,
	createRpcTurnCapture,
	observeRpcBudgetEvent,
} from "./rpc-turn-capture.js";
import { terminateProcess } from "./runner.js";
import { safeTerminalText } from "./safe-text.js";
import { readSubagentSettings } from "./settings.js";
import { buildStatefulTurnPrompt, resolveStatefulTurnTimeout } from "./stateful-prompt.js";
import {
	formatTimeoutCheckpoint,
	formatTurnTerminationMessage,
	TURN_TERMINATION_VERSION,
	type TurnTerminationReport,
} from "./timeout-checkpoint.js";
import type { SubagentTransport } from "./transport.js";
import {
	PI_SUBAGENTS_RPC_PROTOCOL,
	type TransportProgressCallback,
	type TransportTelemetry,
} from "./transport-types.js";
import { TurnBudgetMonitor, type TurnBudgetStop } from "./turn-budget.js";

const COMMAND_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 30_000;
const ABORT_GRACE_MS = 5_000;
const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

interface RpcCommandInput {
	type: string;
	[key: string]: unknown;
}

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

interface PendingRequest {
	command: string;
	resolve(value: RpcResponse): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export interface RpcProtocolClientOptions {
	cwd: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	startupTimeoutMs?: number;
	commandTimeoutMs?: number;
	abortTimeoutMs?: number;
	terminationGraceMs?: number;
	invocation?: PiInvocation;
}

export interface RpcProtocolSnapshot {
	state: RpcSessionState;
	stderr: string;
	malformedLines: number;
	oversizedLines: number;
}

export class RpcProtocolClient {
	private process?: ChildProcess;
	private processClosed = false;
	private decoder?: JsonLineDecoder;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: unknown) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private nextRequestId = 0;
	private stderr = "";
	private malformedLines = 0;
	private oversizedLines = 0;
	private closedError?: Error;
	private closePromise?: Promise<void>;
	private cleanupTermination?: () => void;

	constructor(private readonly options: RpcProtocolClientOptions) {}

	async start(signal?: AbortSignal): Promise<RpcProtocolSnapshot> {
		if (this.process) throw new Error("RPC subagent client already started");
		if (signal?.aborted) throw abortError("RPC subagent start aborted");
		const invocation = this.options.invocation
			? {
					command: this.options.invocation.command,
					args: [...this.options.invocation.args, ...this.options.args],
				}
			: resolvePiInvocation(this.options.args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.options.cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...this.options.env },
		});
		this.process = proc;
		this.processClosed = false;
		this.decoder = new JsonLineDecoder({
			onValue: (value) => this.handleValue(value),
			onMalformed: () => {
				this.malformedLines++;
				this.fail(new Error("RPC subagent emitted malformed JSONL"));
			},
			onOversized: () => {
				this.oversizedLines++;
				this.fail(new Error("RPC subagent emitted an oversized JSONL record"));
			},
		});
		proc.stdout?.on("data", (chunk) => this.decoder?.push(chunk));
		proc.stdin?.on("error", (error) => this.fail(errorMessage("RPC stdin failed", error)));
		proc.stderr?.on("data", (chunk) => {
			this.stderr = appendBounded(
				this.stderr,
				Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
				DEFAULT_MAX_STDERR_BYTES,
			).text;
		});
		proc.once("error", (error) => this.fail(errorMessage("RPC process failed", error)));
		proc.once("close", (code, childSignal) => {
			this.processClosed = true;
			this.decoder?.finish();
			this.fail(
				new Error(
					`RPC subagent exited (code=${code ?? "null"}, signal=${childSignal ?? "null"})${this.stderr ? `: ${safeTerminalText(this.stderr)}` : ""}`,
				),
			);
		});
		try {
			await waitForSpawn(proc, signal, this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
			if (signal?.aborted) throw abortError("RPC subagent start aborted");
			const state = await raceWithAbort(
				this.requestData<RpcSessionState>(
					{ type: "get_state" },
					this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
				),
				signal,
				"RPC subagent readiness aborted",
			);
			return {
				state,
				stderr: this.stderr,
				malformedLines: this.malformedLines,
				oversizedLines: this.oversizedLines,
			};
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	onEvent(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: (error: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	async prompt(message: string, timeoutMs?: number): Promise<void> {
		await this.request({ type: "prompt", message }, timeoutMs);
	}

	async abort(): Promise<void> {
		await this.request(
			{ type: "abort" },
			this.options.abortTimeoutMs ?? Math.min(COMMAND_TIMEOUT_MS, ABORT_GRACE_MS),
		);
	}

	async getState(): Promise<RpcSessionState> {
		return this.requestData<RpcSessionState>({ type: "get_state" });
	}

	getStderr(): string {
		return this.stderr;
	}

	async stop(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		const proc = this.process;
		if (!proc) return;
		if (this.processClosed) {
			this.cleanupTermination?.();
			this.cleanupTermination = undefined;
			this.process = undefined;
			this.rejectPending(this.closedError ?? new Error("RPC subagent process already exited"));
			this.listeners.clear();
			this.closeListeners.clear();
			return;
		}
		this.closePromise = new Promise<void>((resolve) => {
			let settled = false;
			let terminationDeadline: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (terminationDeadline) clearTimeout(terminationDeadline);
				proc.off("close", finish);
				this.cleanupTermination?.();
				this.cleanupTermination = undefined;
				resolve();
			};
			proc.once("close", finish);
			try {
				proc.stdin?.end();
			} catch {
				// Termination below remains authoritative.
			}
			const graceMs = this.options.terminationGraceMs ?? ABORT_GRACE_MS;
			this.cleanupTermination?.();
			this.cleanupTermination = terminateProcess(proc, graceMs);
			terminationDeadline = setTimeout(() => {
				proc.stdin?.destroy();
				proc.stdout?.destroy();
				proc.stderr?.destroy();
				finish();
			}, graceMs + 1_000);
		});
		await this.closePromise;
		this.process = undefined;
		this.rejectPending(new Error("RPC subagent client stopped"));
		this.listeners.clear();
		this.closeListeners.clear();
	}

	private async requestData<T>(
		command: RpcCommandInput,
		timeoutMs = this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
	): Promise<T> {
		const response = await this.request(command, timeoutMs);
		return response.data as T;
	}

	private request(
		command: RpcCommandInput,
		timeoutMs = this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
	): Promise<RpcResponse> {
		const proc = this.process;
		if (!proc?.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
			return Promise.reject(this.closedError ?? new Error("RPC subagent stdin is unavailable"));
		}
		const id = `psa_${++this.nextRequestId}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(rpcTimeoutError(`RPC ${command.type} response timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { command: command.type, resolve, reject, timer });
			try {
				proc.stdin?.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
					if (!error) return;
					this.fail(errorMessage("RPC stdin write failed", error));
				});
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		}).then((response) => {
			if (!response.success) throw new Error(response.error || `RPC ${command.type} failed`);
			return response;
		});
	}

	private handleValue(value: unknown): void {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const event = value as Record<string, unknown>;
		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (!pending) return;
			if (typeof event.command !== "string" || event.command !== pending.command) {
				this.fail(
					new Error(`RPC response command mismatch for ${event.id}: expected ${pending.command}`),
				);
				return;
			}
			this.pending.delete(event.id);
			clearTimeout(pending.timer);
			pending.resolve(event as unknown as RpcResponse);
			return;
		}
		if (event.type === "extension_ui_request" && typeof event.id === "string") {
			this.writeFireAndForget({
				type: "extension_ui_response",
				id: event.id,
				cancelled: true,
			});
		}
		for (const listener of this.listeners) listener(value);
	}

	private writeFireAndForget(value: Record<string, unknown>): void {
		try {
			this.process?.stdin?.write(`${JSON.stringify(value)}\n`);
		} catch {
			// Process failure will be reported through close/error handling.
		}
	}

	private fail(error: Error): void {
		if (this.closedError) return;
		this.closedError = error;
		this.rejectPending(error);
		for (const listener of this.closeListeners) listener(error);
		if (this.process && !this.closePromise) {
			this.cleanupTermination = terminateProcess(
				this.process,
				this.options.terminationGraceMs ?? ABORT_GRACE_MS,
			);
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

export interface RpcTransportOptions {
	getSettings?: () => SubagentSettings | undefined;
	getParentRuntime: () => ParentRuntimeSnapshot;
	createClient?: (options: RpcProtocolClientOptions) => RpcProtocolClient;
	resolvePromptResources?: typeof resolvePiPromptResources;
	defaultTimeoutMs?: number;
	abortGraceMs?: number;
	timeoutFinalizationMs?: number;
}

interface RpcChildRecord {
	client: RpcProtocolClient;
	state: RpcSessionState;
	started: boolean;
	temporaryPrompt?: { dir: string; filePath: string };
}

export class RpcTransport implements SubagentTransport {
	readonly kind = "rpc" as const;
	private readonly children = new Map<string, RpcChildRecord>();
	private readonly createClient: (options: RpcProtocolClientOptions) => RpcProtocolClient;

	constructor(private readonly options: RpcTransportOptions) {
		this.createClient =
			options.createClient ?? ((clientOptions) => new RpcProtocolClient(clientOptions));
	}

	async runTurn(
		agent: ManagedAgent,
		task: string,
		signal: AbortSignal,
		onProgress?: TransportProgressCallback,
	): Promise<TurnOutcome> {
		const startedAt = Date.now();
		let telemetry: TransportTelemetry = {
			transport: "rpc",
			protocol: PI_SUBAGENTS_RPC_PROTOCOL,
			phase: "starting",
			updatedAt: startedAt,
			timing: { startedAt, transportStartedAt: startedAt },
		};
		const publish = (patch: Partial<TransportTelemetry>) => {
			telemetry = {
				...telemetry,
				...patch,
				timing: { ...telemetry.timing, ...patch.timing },
				usage: patch.usage ? { ...patch.usage } : telemetry.usage,
				updatedAt: Date.now(),
			};
			onProgress?.({
				...telemetry,
				timing: { ...telemetry.timing },
				usage: telemetry.usage ? { ...telemetry.usage } : undefined,
			});
		};
		publish({});
		if (signal.aborted) return interruptedRpcOutcome("", telemetry, "starting");
		const settings = this.options.getSettings ? this.options.getSettings() : readSubagentSettings();
		const agentConfig = discoverAgents(agent.cwd, agent.agentScope ?? "user", settings).agents.find(
			(candidate) => candidate.name === agent.agent,
		);
		if (!agentConfig) {
			publish({ phase: "failed", failurePhase: "starting" });
			return { output: "", exitCode: 1, error: `Unknown subagent: ${agent.agent}`, telemetry };
		}
		const effectiveAgentConfig = {
			...agentConfig,
			tools: agent.executionPlan?.effectiveTools ?? agentConfig.tools,
		};
		try {
			validateRpcTools(effectiveAgentConfig.tools);
		} catch (error) {
			publish({ phase: "failed", failurePhase: "starting" });
			return { output: "", exitCode: 1, error: boundedError(error), telemetry };
		}
		let child: RpcChildRecord;
		try {
			child = await this.getOrCreate(agent, effectiveAgentConfig, signal);
		} catch (error) {
			publish({ phase: signal.aborted ? "interrupted" : "failed", failurePhase: "starting" });
			return {
				output: "",
				exitCode: signal.aborted ? 130 : 1,
				aborted: signal.aborted,
				error: boundedError(error),
				telemetry,
			};
		}
		const stateModel = modelIdentity(child.state.model);
		publish({
			phase: "ready",
			provider: stateModel.provider,
			model: stateModel.model,
			thinkingLevel: normalizeThinking(child.state.thinkingLevel),
			timing: { readyAt: Date.now() },
		});
		if (signal.aborted) {
			await this.releaseById(agent.id).catch(() => undefined);
			return interruptedRpcOutcome("", telemetry, "ready");
		}
		const timeoutMs =
			agent.currentTimeoutMs ??
			agent.timeoutMs ??
			agentConfig.timeoutMs ??
			this.options.defaultTimeoutMs ??
			resolveStatefulTurnTimeout(agentConfig);
		const capture = createRpcTurnCapture();
		let resolveBudget!: (stop: TurnBudgetStop) => void;
		let resolvePreAcceptanceIdle!: (stop: TurnBudgetStop) => void;
		const budgetExceeded = new Promise<TurnBudgetStop>((resolve) => {
			resolveBudget = resolve;
		});
		const preAcceptanceIdleExceeded = new Promise<TurnBudgetStop>((resolve) => {
			resolvePreAcceptanceIdle = resolve;
		});
		const budgetMonitor = new TurnBudgetMonitor({
			idleTimeoutMs: agent.currentIdleTimeoutMs ?? agent.idleTimeoutMs,
			maxTurns: agent.currentMaxTurns ?? agent.maxTurns,
			maxToolCalls: agent.currentMaxToolCalls ?? agent.maxToolCalls,
			onExceeded(stop) {
				resolveBudget(stop);
				if (stop.reason === "idle_timeout") resolvePreAcceptanceIdle(stop);
			},
		});
		let settledResolve!: () => void;
		let settledReject!: (error: Error) => void;
		const settled = new Promise<void>((resolve, reject) => {
			settledResolve = resolve;
			settledReject = reject;
		});
		void settled.catch(() => undefined);
		const unsubscribeEvent = child.client.onEvent((event) => {
			captureRpcEvent(event, capture);
			observeRpcBudgetEvent(event, budgetMonitor);
			if (!capture.firstActivityAt && isActivityEvent(event)) {
				capture.firstActivityAt = Date.now();
				publish({ phase: "running", timing: { firstActivityAt: capture.firstActivityAt } });
			}
			const type = eventType(event);
			if (type === "auto_retry_start") publish({ phase: "retrying" });
			if (type === "compaction_start" || type === "summarization_retry_attempt_start") {
				publish({ phase: "compacting" });
			}
			if (type === "agent_settled") settledResolve();
		});
		const unsubscribeClose = child.client.onClose(settledReject);
		const prompt = child.started
			? buildCurrentTurnPrompt(agent, task)
			: buildStatefulTurnPrompt(agent, task).text;
		let accepted = false;
		let preAcceptanceStop: TurnBudgetStop | undefined;
		const deadline = Date.now() + timeoutMs;
		try {
			await Promise.race([
				raceWithAbort(
					child.client.prompt(prompt, remainingMs(deadline)),
					signal,
					"RPC subagent prompt acceptance aborted",
				),
				preAcceptanceIdleExceeded.then((stop) => {
					preAcceptanceStop = stop;
					throw new Error(formatTurnTerminationMessage(stop.reason, stop.limit, "RPC subagent"));
				}),
			]);
			accepted = true;
			child.started = true;
			publish({ phase: "accepted", timing: { promptAcceptedAt: Date.now() } });
			const settlement = await Promise.race([
				waitForTurnSettlement(settled, signal, remainingMs(deadline)).then((kind) => ({
					kind,
				})),
				budgetExceeded.then((stop) => ({ kind: "limit" as const, stop })),
			]);
			if (settlement.kind !== "settled") {
				const [, stopped] = await Promise.all([
					child.client.abort().catch(() => undefined),
					settlesWithin(settled, this.options.abortGraceMs ?? ABORT_GRACE_MS),
				]);
				const partial = truncateUtf8(capture.output || capture.partial, DEFAULT_MAX_OUTPUT_BYTES);
				const stop =
					settlement.kind === "limit"
						? settlement.stop
						: ({ reason: "work_timeout", limit: timeoutMs } as const);
				const explicitAbort = settlement.kind === "aborted" || signal.aborted;
				const termination: TurnTerminationReport | undefined = explicitAbort
					? undefined
					: {
							version: TURN_TERMINATION_VERSION,
							reason: stop.reason,
							limit: stop.limit,
							checkpoint: capture.journal.checkpoint(task, partial.text),
							finalization: {
								attempted: false,
								status: "skipped",
								durationMs: 0,
							},
						};
				if (explicitAbort || !stopped) {
					if (!stopped) await this.releaseById(agent.id);
					publish({
						phase: explicitAbort ? "interrupted" : "failed",
						failurePhase: "running",
						timing: { settledAt: Date.now() },
						usage: capture.usage,
					});
					const checkpointOutput = termination
						? formatTimeoutCheckpoint(termination.checkpoint)
						: partial.text;
					return {
						output: partial.text || checkpointOutput,
						exitCode: explicitAbort ? 130 : 124,
						aborted: explicitAbort,
						truncated: partial.truncated || agent.contextTruncated,
						error: explicitAbort
							? "RPC subagent was aborted"
							: `${formatTurnTerminationMessage(stop.reason, stop.limit, "RPC subagent")}; abort did not settle`,
						policy: rpcPolicy(agentConfig, agent),
						termination,
						telemetry,
					};
				}

				publish({ phase: "finalizing", failurePhase: "running" });
				const finalizationStartedAt = Date.now();
				const summary = await finalizeTimedOutRpcTurn({
					client: child.client,
					task,
					partialOutput: partial.text,
					checkpoint: termination?.checkpoint,
					terminationReason: stop.reason,
					resultFormat: agent.resultFormat,
					signal,
					workTimeoutMs: timeoutMs,
					finalizationTimeoutMs: this.options.timeoutFinalizationMs,
					abortGraceMs: this.options.abortGraceMs ?? ABORT_GRACE_MS,
					resetCapture() {
						capture.output = "";
						capture.partial = "";
						capture.stopReason = undefined;
						capture.error = undefined;
					},
					getCapture: () => capture,
					release: () => this.releaseById(agent.id),
				});
				if (termination) {
					termination.finalization = {
						attempted: true,
						status: summary.status,
						durationMs: Date.now() - finalizationStartedAt,
						error: summary.error,
					};
				}
				publish({
					phase: "failed",
					failurePhase: "running",
					timing: { settledAt: Date.now() },
					usage: capture.usage,
				});
				const checkpointOutput = termination ? formatTimeoutCheckpoint(termination.checkpoint) : "";
				return {
					output: summary.error ? partial.text || checkpointOutput : summary.output,
					exitCode: 124,
					truncated: partial.truncated || summary.truncated || agent.contextTruncated,
					error: [
						formatTurnTerminationMessage(stop.reason, stop.limit, "RPC subagent"),
						summary.error,
					]
						.filter(Boolean)
						.join("; "),
					policy: rpcPolicy(agentConfig, agent),
					termination,
					telemetry,
				};
			}
			const output = truncateUtf8(capture.output || capture.partial, DEFAULT_MAX_OUTPUT_BYTES);
			const failed = capture.stopReason === "error" || !output.text.trim();
			publish({
				phase: failed ? "failed" : "settled",
				failurePhase: failed ? "running" : undefined,
				timing: { settledAt: Date.now() },
				provider: capture.provider ?? telemetry.provider,
				model: capture.model ?? telemetry.model,
				usage: capture.usage,
			});
			return {
				output: output.text,
				exitCode: failed ? 1 : 0,
				truncated: output.truncated || agent.contextTruncated,
				error: failed ? capture.error || "RPC subagent completed without final text" : undefined,
				policy: rpcPolicy(agentConfig, agent),
				telemetry,
			};
		} catch (error) {
			await this.releaseById(agent.id).catch(() => undefined);
			const timedOut = isTimeoutError(error);
			const stop =
				preAcceptanceStop ??
				(timedOut ? ({ reason: "work_timeout", limit: timeoutMs } as const) : undefined);
			const partial = truncateUtf8(capture.output || capture.partial, DEFAULT_MAX_OUTPUT_BYTES);
			const termination: TurnTerminationReport | undefined =
				stop && !signal.aborted
					? {
							version: TURN_TERMINATION_VERSION,
							reason: stop.reason,
							limit: stop.limit,
							checkpoint: capture.journal.checkpoint(task, partial.text),
							finalization: {
								attempted: false,
								status: "skipped",
								durationMs: 0,
							},
						}
					: undefined;
			publish({
				phase: signal.aborted ? "interrupted" : "failed",
				failurePhase: accepted ? "running" : "ready",
				timing: { settledAt: Date.now() },
			});
			return {
				output:
					partial.text || (termination ? formatTimeoutCheckpoint(termination.checkpoint) : ""),
				exitCode: signal.aborted ? 130 : stop ? 124 : 1,
				aborted: signal.aborted,
				error: stop
					? formatTurnTerminationMessage(stop.reason, stop.limit, "RPC subagent")
					: boundedError(error),
				policy: rpcPolicy(agentConfig, agent),
				termination,
				telemetry,
			};
		} finally {
			budgetMonitor.dispose();
			unsubscribeEvent();
			unsubscribeClose();
		}
	}

	async release(agent: ManagedAgent): Promise<void> {
		await this.releaseById(agent.id);
	}

	async shutdown(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.children.keys()].map((agentId) => this.releaseById(agentId)),
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to release ${failures.length} RPC subagent(s)`);
		}
	}

	private async getOrCreate(
		agent: ManagedAgent,
		agentConfig: AgentConfig,
		signal: AbortSignal,
	): Promise<RpcChildRecord> {
		const existing = this.children.get(agent.id);
		if (existing) return existing;
		const hasRolePrompt = agentConfig.systemPrompt.trim().length > 0;
		const resources = hasRolePrompt
			? await (this.options.resolvePromptResources ?? resolvePiPromptResources)(
					agent.cwd,
					agent.target?.trust.projectTrusted ?? false,
				)
			: { appendSystemPromptPaths: [] };
		if (signal.aborted) throw abortError("RPC subagent start aborted");
		const temporaryPrompt = hasRolePrompt
			? await writeRolePrompt(agentConfig.name, agentConfig.systemPrompt)
			: undefined;
		if (signal.aborted) {
			cleanupRolePrompt(temporaryPrompt);
			throw abortError("RPC subagent start aborted");
		}
		const client = this.createClient({
			cwd: agent.cwd,
			abortTimeoutMs: this.options.abortGraceMs ?? ABORT_GRACE_MS,
			terminationGraceMs: this.options.abortGraceMs ?? ABORT_GRACE_MS,
			args: buildRpcArgs(
				agent,
				agentConfig,
				this.options.getParentRuntime(),
				temporaryPrompt?.filePath,
				resources.appendSystemPromptPaths,
			),
			env: {
				PI_SUBAGENT_DEPTH: String(
					(Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0) + 1,
				),
				PI_SUBAGENT_RPC_PROTOCOL: PI_SUBAGENTS_RPC_PROTOCOL,
			},
		});
		try {
			const snapshot = await client.start(signal);
			const record: RpcChildRecord = {
				client,
				state: snapshot.state,
				started: false,
				temporaryPrompt,
			};
			if (signal.aborted) {
				await client.stop();
				cleanupRolePrompt(temporaryPrompt);
				throw abortError("RPC subagent start aborted");
			}
			this.children.set(agent.id, record);
			return record;
		} catch (error) {
			await client.stop().catch(() => undefined);
			cleanupRolePrompt(temporaryPrompt);
			throw error;
		}
	}

	private async releaseById(agentId: string): Promise<void> {
		const child = this.children.get(agentId);
		if (!child) return;
		this.children.delete(agentId);
		try {
			await child.client.abort().catch(() => undefined);
			await child.client.stop();
		} finally {
			cleanupRolePrompt(child.temporaryPrompt);
		}
	}
}

export function validateRpcTools(tools: string[] | undefined): string[] | undefined {
	const validated = validateInProcessTools(tools);
	if (validated?.some((tool) => !BUILT_IN_TOOL_NAMES.has(tool))) {
		throw new Error("RPC subagents support only built-in Pi tools in pi-subagents:v1");
	}
	return validated;
}

export function buildRpcArgs(
	agent: ManagedAgent,
	agentConfig: AgentConfig,
	parentRuntime: ParentRuntimeSnapshot,
	rolePromptPath?: string,
	appendSystemPromptPaths: readonly string[] = [],
): string[] {
	const args = ["--mode", "rpc", "--no-session", "--no-extensions"];
	const model =
		agentConfig.model ??
		(parentRuntime.model ? `${parentRuntime.model.provider}/${parentRuntime.model.id}` : undefined);
	if (model) args.push("--model", model);
	const modelSelectsThinking = agentConfig.model
		? /:(?:off|minimal|low|medium|high|xhigh|max)$/u.test(agentConfig.model.trim())
		: false;
	const thinking =
		agent.thinkingLevel ??
		agentConfig.thinkingLevel ??
		(modelSelectsThinking ? undefined : parentRuntime.thinkingLevel);
	if (thinking) args.push("--thinking", thinking);
	if (agent.target?.trust.projectTrusted ?? false) args.push("--approve");
	else args.push("--no-approve");
	if (Array.isArray(agentConfig.tools)) {
		if (agentConfig.tools.length > 0) args.push("--tools", agentConfig.tools.join(","));
		else args.push("--no-tools");
	}
	for (const promptPath of appendSystemPromptPaths) {
		args.push("--append-system-prompt", promptPath);
	}
	if (rolePromptPath) args.push("--append-system-prompt", rolePromptPath);
	return args;
}

function eventType(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const type = (value as Record<string, unknown>).type;
	return typeof type === "string" ? type : undefined;
}

function isActivityEvent(value: unknown): boolean {
	return [
		"message_start",
		"message_update",
		"message_end",
		"tool_execution_start",
		"tool_execution_update",
		"auto_retry_start",
		"compaction_start",
	].includes(eventType(value) ?? "");
}

async function writeRolePrompt(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-rpc-"));
	const safeName = agentName.replace(/[^\w.-]+/gu, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, {
		encoding: "utf8",
		mode: 0o600,
	});
	return { dir, filePath };
}

function cleanupRolePrompt(value: { dir: string; filePath: string } | undefined): void {
	if (!value) return;
	try {
		fs.rmSync(value.dir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup is repeated when the owning runtime shuts down.
	}
}

function waitForSpawn(
	proc: ChildProcess,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			proc.off("spawn", onSpawn);
			proc.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onSpawn = () => finish();
		const onError = (error: Error) => finish(error);
		const onAbort = () => finish(abortError("RPC subagent start aborted"));
		const timer = setTimeout(
			() => finish(new Error(`RPC subagent start timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref();
		proc.once("spawn", onSpawn);
		proc.once("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

async function raceWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	message: string,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortError(message);
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				onAbort = () => reject(abortError(message));
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function waitForTurnSettlement(
	settled: Promise<void>,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<"settled" | "aborted" | "timeout"> {
	if (signal.aborted) return Promise.resolve("aborted");
	return new Promise((resolve, reject) => {
		let finished = false;
		const finish = (value: "settled" | "aborted" | "timeout", error?: unknown) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(value);
		};
		const onAbort = () => finish("aborted");
		const timer = setTimeout(() => finish("timeout"), timeoutMs);
		timer.unref();
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		settled.then(
			() => finish("settled"),
			(error) => finish("settled", error),
		);
	});
}

async function settlesWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			settled.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function remainingMs(deadline: number): number {
	return Math.max(1, deadline - Date.now());
}

function rpcTimeoutError(message: string): Error {
	const error = new Error(message);
	error.name = "RpcTimeoutError";
	return error;
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "RpcTimeoutError";
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function errorMessage(prefix: string, error: Error): Error {
	return new Error(`${prefix}: ${error.message}`);
}
