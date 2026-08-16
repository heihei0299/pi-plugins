import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENT_CATALOG_MAX_ITEMS } from "./agents/catalog.js";
import { type AgentDiscoveryResult, discoverAgents } from "./agents/discovery.js";
import {
	type AgentConfig,
	type AgentScope,
	type ConsultResourcePolicy,
	isThinkingLevel,
	type SubagentSettings,
	type THINKING_LEVELS,
} from "./agents/types.js";
import { resolveConsultTools } from "./consult-policy.js";
import { resolveConsultResourceLaunchPolicy } from "./consult-resources.js";
import type {
	ConsultDetails,
	ConsultProgress,
	ConsultProgressActivity,
	SubagentConsultParams,
} from "./consult-tool.js";
import {
	assertConsultationTargetAllowed,
	type ResolvedSubagentTarget,
	resolveSubagentTarget,
} from "./cwd-policy.js";
import {
	assertSubagentDepthAllowed,
	resolveDefaultSubagentTimeoutMs,
} from "./execution/runtime-policy.js";
import {
	DEFAULT_MAX_CONTEXT_BYTES,
	DEFAULT_MAX_STDERR_BYTES,
	MAX_SUBAGENT_TIMEOUT_MS,
} from "./limits.js";
import {
	type ChildLaunchPolicy,
	getResultFinalOutput,
	isResultError,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
} from "./runner.js";
import { boundedPrivateText, boundText, safeDisplayPath, safeTerminalLine } from "./safe-text.js";
import {
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
} from "./settings/inspection.js";
import { resolveSubagentThinkingLevel } from "./settings.js";

export { registerSubagentConsult } from "./consult-registration.js";
export type {
	ConsultDetails,
	ConsultProgress,
	ConsultProgressActivity,
} from "./consult-tool.js";
export { SubagentConsultParams } from "./consult-tool.js";

export interface ConsultChildRequest {
	agent: AgentConfig;
	task: string;
	cwd: string;
	agentScope: AgentScope;
	thinkingLevel?: (typeof THINKING_LEVELS)[number];
	timeoutMs: number;
	effectiveTools: string[];
	resourcePolicy: ConsultResourcePolicy;
	launchPolicy: ChildLaunchPolicy;
	signal: AbortSignal;
	onUpdate?: (result: SingleResult) => void;
}

export interface RegisterSubagentConsultOptions {
	getSettings(): SubagentSettings | undefined;
	runChild?: (request: ConsultChildRequest) => Promise<SingleResult>;
	invocationOverride?: { command: string; argsPrefix?: string[] };
	resolveResourceLaunchPolicy?: typeof resolveConsultResourceLaunchPolicy;
}

const READ_ONLY_INSTRUCTION = [
	"This is a read-only consultation.",
	"Use only the tools made available by the executor to inspect and reason about existing content.",
	"Do not claim to edit files, run shell commands, mutate state, or persist a session.",
	"If the task asks for implementation, return analysis or instructions instead of claiming changes.",
].join("\n");

const MAX_UNKNOWN_AGENT_NAME_BYTES = 128;

export async function executeSubagentConsult(
	params: SubagentConsultParams,
	signal: AbortSignal,
	onUpdate: ((partial: AgentToolResult<ConsultDetails>) => void) | undefined,
	ctx: ExtensionContext,
	options: RegisterSubagentConsultOptions,
	isCurrent: () => boolean = () => true,
): Promise<AgentToolResult<ConsultDetails>> {
	const operation = validateConsultParams(params);
	assertSubagentDepthAllowed();
	if (signal.aborted) throw abortError("Subagent consultation was aborted before start");
	return executeConsult(
		operation,
		ctx,
		signal,
		options,
		(partial) => {
			if (signal.aborted || !isCurrent()) return;
			onUpdate?.(partial);
		},
		isCurrent,
		() => undefined,
	);
}

function formatAvailableConsultAgents(discovery: AgentDiscoveryResult): string {
	const listed = discovery.agents.slice(0, DEFAULT_AGENT_CATALOG_MAX_ITEMS);
	const labels = listed.map(
		(agent) => `${safeTerminalLine(agent.name, MAX_UNKNOWN_AGENT_NAME_BYTES)} (${agent.source})`,
	);
	const omitted =
		discovery.agents.length - listed.length + (discovery.omittedAgentDefinitions ?? 0);
	const parts = [labels.join(", ") || "none"];
	if (omitted > 0) {
		parts.push(`[${omitted} additional agent definition${omitted === 1 ? "" : "s"} omitted.]`);
	}
	if (discovery.metadataDiscoveryIncomplete) {
		parts.push("[Agent metadata discovery was incomplete; some definitions may be unavailable.]");
	}
	return parts.join(" ");
}

function validateConsultParams(
	params: unknown,
): Required<Pick<SubagentConsultParams, "agent" | "task" | "agentScope" | "confirmProjectAgents">> &
	Pick<SubagentConsultParams, "cwd" | "timeoutMs" | "thinkingLevel"> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("subagent_consult parameters must be an object");
	}
	const values = params as Record<string, unknown>;
	const allowed = [
		"agent",
		"task",
		"agentScope",
		"confirmProjectAgents",
		"cwd",
		"timeoutMs",
		"thinkingLevel",
	];
	const unexpected = Object.keys(values).find(
		(key) => values[key] !== undefined && !allowed.includes(key),
	);
	if (unexpected) throw new Error(`subagent_consult does not accept ${unexpected}`);
	const agent = requiredString(values.agent, "agent");
	const task = requiredString(values.task, "task");
	if (task.includes("\0")) throw new Error("subagent_consult task must not contain NUL bytes");
	if (Buffer.byteLength(task, "utf8") > DEFAULT_MAX_CONTEXT_BYTES) {
		throw new Error(
			`subagent_consult task must be at most ${DEFAULT_MAX_CONTEXT_BYTES} UTF-8 bytes`,
		);
	}
	const agentScope = optionalScope(values.agentScope);
	if (
		values.confirmProjectAgents !== undefined &&
		typeof values.confirmProjectAgents !== "boolean"
	) {
		throw new Error("subagent_consult confirmProjectAgents must be boolean");
	}
	if (values.cwd !== undefined && (typeof values.cwd !== "string" || !values.cwd.trim())) {
		throw new Error("subagent_consult cwd must be a non-empty string");
	}
	if (
		values.timeoutMs !== undefined &&
		(typeof values.timeoutMs !== "number" ||
			!Number.isFinite(values.timeoutMs) ||
			values.timeoutMs < 1 ||
			values.timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)
	) {
		throw new Error(`subagent_consult timeoutMs must be between 1 and ${MAX_SUBAGENT_TIMEOUT_MS}`);
	}
	if (values.thinkingLevel !== undefined && !isThinkingLevel(values.thinkingLevel)) {
		throw new Error("subagent_consult thinkingLevel is invalid");
	}
	return {
		agent,
		task,
		agentScope,
		confirmProjectAgents: values.confirmProjectAgents !== false,
		cwd: values.cwd as string | undefined,
		timeoutMs: values.timeoutMs as number | undefined,
		thinkingLevel: values.thinkingLevel as (typeof THINKING_LEVELS)[number] | undefined,
	};
}

async function executeConsult(
	operation: ReturnType<typeof validateConsultParams>,
	ctx: ExtensionContext,
	signal: AbortSignal,
	options: RegisterSubagentConsultOptions,
	emitUpdate: (partial: AgentToolResult<ConsultDetails>) => void,
	isCurrent: () => boolean,
	trackWork: (work: Promise<unknown>) => void,
): Promise<AgentToolResult<ConsultDetails>> {
	if (
		(operation.agentScope === "project" || operation.agentScope === "both") &&
		!ctx.isProjectTrusted()
	) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
	const settings = options.getSettings();
	const target = resolveSubagentTarget({
		workspace: ctx.cwd,
		requestedCwd: operation.cwd,
		currentProjectTrusted: ctx.isProjectTrusted(),
	});
	assertConsultationTargetAllowed(
		target,
		settings?.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY,
	);
	const discovery = discoverAgents(ctx.cwd, operation.agentScope, settings);
	const agent = discovery.agents.find((candidate) => candidate.name === operation.agent);
	if (!agent) {
		throw new Error(
			`Unknown subagent definition: ${boundedPrivateText(operation.agent, 256)}. ` +
				`Available agents for agentScope "${operation.agentScope}": ${formatAvailableConsultAgents(discovery)}`,
		);
	}
	const setupWork = resolveConsultSetup(operation, agent, settings, target, options);
	trackWork(setupWork);
	const setup = await setupWork;
	assertCurrentRequest(signal, isCurrent);

	if (agent.source === "project" && operation.confirmProjectAgents) {
		if (!ctx.hasUI) {
			throw new Error(
				"Project-local subagent confirmation requires UI; pass confirmProjectAgents: false explicitly in a trusted project",
			);
		}
		const approved = await ctx.ui.confirm(
			"Run project-local read-only agent?",
			`Agent: ${safeTerminalLine(agent.name, 256)}\nSource: ${safeTerminalLine(path.posix.join(CONFIG_DIR_NAME, "agents", path.basename(agent.filePath)))}`,
		);
		assertCurrentRequest(signal, isCurrent);
		if (!approved) {
			return {
				content: [{ type: "text", text: "Read-only subagent consultation cancelled." }],
				details: { ...setup.details, cancelled: true },
			};
		}
	}
	assertCurrentRequest(signal, isCurrent);
	emitUpdate(consultStartingUpdate(setup.details));
	assertCurrentRequest(signal, isCurrent);
	const runChild = options.runChild ?? ((request) => runConsultChild(request, options));
	const child = runChild({
		agent: setup.agent,
		task: operation.task,
		cwd: setup.cwd,
		agentScope: operation.agentScope,
		thinkingLevel: setup.thinkingLevel,
		timeoutMs: setup.timeoutMs,
		effectiveTools: setup.effectiveTools,
		resourcePolicy: setup.resourcePolicy,
		launchPolicy: setup.launchPolicy,
		signal,
		onUpdate: (result) => {
			if (signal.aborted || !isCurrent()) return;
			emitUpdate(consultUpdate(result, setup.details));
		},
	});
	trackWork(child);
	const result = await child;
	if (!isCurrent()) throw abortError("Subagent consultation owner was replaced");
	if (result.aborted && !result.processStarted) {
		throw abortError(result.errorMessage || "Subagent consultation was aborted before launch");
	}
	if (result.launchFailed) {
		throw new Error(
			boundedPrivateText(
				result.errorMessage || result.stderr.trim() || "Subagent consultation failed to launch",
				2 * 1024,
			),
		);
	}
	const error = isResultError(result);
	const output = error
		? formatConsultFailure(result)
		: getResultFinalOutput(result) || "(no output)";
	const bounded = boundText(output);
	const details: ConsultDetails = {
		...setup.details,
		child: projectChildResult(result),
		...(error ? { isError: true } : {}),
		...(bounded.truncated ? { truncated: true } : {}),
	};
	return {
		content: [{ type: "text", text: bounded.text }],
		details,
		usage: usageFromResult(result),
	};
}

async function resolveConsultSetup(
	operation: ReturnType<typeof validateConsultParams>,
	agent: AgentConfig,
	settings: SubagentSettings | undefined,
	target: ResolvedSubagentTarget,
	options: RegisterSubagentConsultOptions,
) {
	const requestedResourcePolicy = settings?.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY;
	const resourcePolicy = target.trust.projectTrusted ? requestedResourcePolicy : "none";
	const effectiveTools = resolveConsultTools(agent.tools);
	const projectTrusted = target.trust.projectTrusted;
	const thinkingLevel = resolveSubagentThinkingLevel([agent], agent.name, operation.thinkingLevel);
	const timeoutMs = operation.timeoutMs ?? agent.timeoutMs ?? resolveDefaultSubagentTimeoutMs();
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SUBAGENT_TIMEOUT_MS) {
		throw new Error(
			`Subagent consultation timeout must be between 1 and ${MAX_SUBAGENT_TIMEOUT_MS}ms`,
		);
	}
	const resolveResources =
		options.resolveResourceLaunchPolicy ?? resolveConsultResourceLaunchPolicy;
	const launchPolicy = await resolveResources(resourcePolicy, projectTrusted, target.cwd);
	launchPolicy.tools = effectiveTools;
	const childAgent: AgentConfig = {
		...agent,
		tools: effectiveTools,
		systemPrompt: [agent.systemPrompt, READ_ONLY_INSTRUCTION].filter(Boolean).join("\n\n"),
	};
	const effectiveResources = {
		policy: resourcePolicy,
		projectResources: projectTrusted && resourcePolicy !== "none",
		contextFiles: !launchPolicy.disableContextFiles,
		skills: !launchPolicy.disableSkills,
		promptTemplates: !launchPolicy.disablePromptTemplates,
	};
	const details: ConsultDetails = {
		agent: boundedPrivateText(agent.name, 256),
		agentSource: agent.source,
		agentScope: operation.agentScope,
		cwd: safeDisplayPath(target.cwd, target.workspace),
		model: agent.model ? boundedPrivateText(agent.model, 256) : undefined,
		thinkingLevel,
		timeoutMs,
		policy: {
			requestedTools:
				agent.tools === undefined
					? null
					: agent.tools.slice(0, 100).map((tool) => boundedPrivateText(tool, 256)),
			effectiveTools,
			cwdBoundary: target.boundary,
			targetTrust: {
				kind: target.trust.kind,
				projectTrusted,
				sourcePath: target.trust.sourcePath
					? safeDisplayPath(target.trust.sourcePath, target.workspace)
					: undefined,
				warning: target.trust.warning,
			},
			requestedResources: requestedResourcePolicy,
			effectiveResources,
			...(resourcePolicy !== requestedResourcePolicy
				? { resourceDowngradeReason: `Target trust is ${target.trust.kind}` }
				: {}),
			extensions: "disabled",
			sessionPersistence: "disabled",
			retainedAgent: false,
		},
	};
	return {
		agent: childAgent,
		cwd: target.cwd,
		resourcePolicy,
		effectiveTools,
		thinkingLevel,
		timeoutMs,
		launchPolicy,
		details,
	};
}

async function runConsultChild(
	request: ConsultChildRequest,
	options: RegisterSubagentConsultOptions,
): Promise<SingleResult> {
	return runSingleAgent(
		request.cwd,
		[request.agent],
		request.agent.name,
		request.task,
		request.cwd,
		undefined,
		request.signal,
		request.thinkingLevel,
		request.timeoutMs,
		(partial) => {
			const result = partial.details.results[0];
			if (result) request.onUpdate?.(result);
		},
		(results): SubagentDetails => ({
			mode: "single",
			agentScope: request.agentScope,
			projectAgentsDir: null,
			results,
		}),
		options.invocationOverride,
		request.launchPolicy,
	);
}

function consultStartingUpdate(details: ConsultDetails): AgentToolResult<ConsultDetails> {
	return {
		content: [{ type: "text", text: "Read-only subagent consultation starting." }],
		details: {
			...details,
			progress: {
				phase: "starting",
				recentActivity: [],
				recentActivityTotal: 0,
				usage: emptyProgressUsage(),
			},
		},
	};
}

function consultUpdate(
	result: SingleResult,
	details: ConsultDetails,
): AgentToolResult<ConsultDetails> {
	const output = boundText(getResultFinalOutput(result) || "(running...)");
	return {
		content: [{ type: "text", text: output.text }],
		details: {
			...details,
			child: projectChildResult(result),
			progress: projectConsultProgress(result),
		},
	};
}

const CONSULT_ACTIVITY_ARGUMENTS: Record<"read" | "grep" | "find" | "ls", readonly string[]> = {
	read: ["path", "file_path", "offset", "limit"],
	grep: ["pattern", "path", "glob", "limit"],
	find: ["pattern", "path", "limit"],
	ls: ["path", "limit"],
};

function projectConsultProgress(result: SingleResult): ConsultProgress {
	const recentActivity: ConsultProgressActivity[] = [];
	for (const item of result.recentActivity ?? []) {
		if (item.type === "text") {
			const text = boundedPrivateText(item.text, 1024).trim();
			if (text) recentActivity.push({ type: "text", text });
			continue;
		}
		if (!Object.hasOwn(CONSULT_ACTIVITY_ARGUMENTS, item.name)) continue;
		const name = item.name as keyof typeof CONSULT_ACTIVITY_ARGUMENTS;
		const args: Record<string, string | number | boolean> = {};
		for (const key of CONSULT_ACTIVITY_ARGUMENTS[name]) {
			const value = item.args[key];
			if (typeof value === "string") args[key] = safeTerminalLine(value, 512);
			else if (typeof value === "number" && Number.isFinite(value)) args[key] = value;
			else if (typeof value === "boolean") args[key] = value;
		}
		recentActivity.push({ type: "toolCall", name, args });
	}
	return {
		phase: "running",
		recentActivity,
		recentActivityTotal: Math.max(recentActivity.length, result.recentActivityTotal ?? 0),
		actualProvider: result.actualProvider
			? boundedPrivateText(result.actualProvider, 256)
			: undefined,
		actualModel: result.actualModel ? boundedPrivateText(result.actualModel, 256) : undefined,
		usage: {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
			cacheWrite: result.usage.cacheWrite,
			cost: result.usage.cost,
			contextTokens: result.usage.contextTokens,
			turns: result.usage.turns,
		},
	};
}

function emptyProgressUsage(): ConsultProgress["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function projectChildResult(result: SingleResult): Record<string, unknown> {
	return {
		exitCode: result.exitCode,
		stopReason:
			typeof result.stopReason === "string"
				? boundedPrivateText(result.stopReason, 256)
				: undefined,
		timedOut: result.timedOut,
		aborted: result.aborted,
		truncated: result.truncated,
		malformedEvents: result.malformedEvents,
		processStarted: result.processStarted,
		actualProvider: result.actualProvider
			? boundedPrivateText(result.actualProvider, 256)
			: undefined,
		actualModel: result.actualModel ? boundedPrivateText(result.actualModel, 256) : undefined,
		partialOutput: result.finalOutput
			? boundedPrivateText(result.finalOutput, 8 * 1024)
			: undefined,
		error: result.errorMessage ? boundedPrivateText(result.errorMessage, 2 * 1024) : undefined,
		usage: { ...result.usage },
	};
}

function formatConsultFailure(result: SingleResult): string {
	const rawError = result.errorMessage || result.stderr.trim();
	const error = rawError ? boundedPrivateText(rawError, DEFAULT_MAX_STDERR_BYTES) : "";
	const output = getResultFinalOutput(result);
	return error && output
		? `${error}\n\nPartial output:\n${output}`
		: error || output || "(no output)";
}

function usageFromResult(result: SingleResult): Usage {
	return {
		input: result.usage.input,
		output: result.usage.output,
		cacheRead: result.usage.cacheRead,
		cacheWrite: result.usage.cacheWrite,
		totalTokens:
			result.usage.totalTokens ??
			result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite,
		cost: {
			input: result.usage.costInput ?? 0,
			output: result.usage.costOutput ?? 0,
			cacheRead: result.usage.costCacheRead ?? 0,
			cacheWrite: result.usage.costCacheWrite ?? 0,
			total: result.usage.cost,
		},
	};
}

function assertCurrentRequest(signal: AbortSignal, isCurrent: () => boolean): void {
	if (signal.aborted || !isCurrent()) throw abortError("Subagent consultation owner was replaced");
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`subagent_consult requires ${name}`);
	}
	return value;
}

function optionalScope(value: unknown): AgentScope {
	if (value === undefined) return "user";
	if (value === "user" || value === "project" || value === "both") return value;
	throw new Error("subagent_consult agentScope must be user, project, or both");
}
