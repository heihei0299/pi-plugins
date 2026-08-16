import { createHash } from "node:crypto";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getBuiltInAgent } from "./agents/built-ins.js";
import { discoverAgents } from "./agents/discovery.js";
import type { SubagentSettings } from "./agents/types.js";
import { parseAutomationRequest, type WorkflowPlan } from "./automation-contract.js";
import {
	AUTOMATION_PLANNER_MAX_TIMEOUT_MS,
	AUTOMATION_PLANNER_MAX_TOOL_CALLS,
	AUTOMATION_PLANNER_MAX_TURNS,
	AUTOMATION_PLANNER_TOOLS,
	buildAutomationPlannerPrompt,
	parseAutomationPlannerOutput,
	resolveAutomationPlannerPolicy,
} from "./automation-planner.js";
import type { AutomationDetails, SubagentAutomationParams } from "./automation-tool.js";
import {
	assertDelegationTargetAllowed,
	resolveSubagentTarget,
	targetPolicyAudit,
} from "./cwd-policy.js";
import { executeSubagent } from "./execution.js";
import {
	getResultFinalOutput,
	isResultError,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
} from "./runner.js";
import { boundedPrivateText } from "./safe-text.js";
import {
	DEFAULT_DELEGATION_CWD_POLICY,
	resolveBlockingMaxParallelTasks,
} from "./settings/inspection.js";
import {
	type CompiledWorkflowPlan,
	compileWorkflowPlan,
	type WorkflowPlanCompilerResult,
} from "./workflow-plan-compiler.js";
import { AutomationPlanPersistence, createWorkflowPlanRecord } from "./workflow-plan-patch.js";
import { createBlockingWorkLedger, resolveWorkflowTasks } from "./workflow-planning.js";

export { registerSubagentAutomation } from "./automation-registration.js";
export type { AutomationDetails } from "./automation-tool.js";
export { SubagentAutomationParams } from "./automation-tool.js";

export interface AutomationPlannerRequest {
	prompt: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	settings: SubagentSettings | undefined;
	timeoutMs: number;
	maxTurns: number;
	maxToolCalls: number;
}

export interface AutomationExecutionOptions {
	getSettings(): SubagentSettings | undefined;
	runPlanner?: (request: AutomationPlannerRequest) => Promise<string>;
	runWorkflow?: (
		params: Parameters<typeof executeSubagent>[1],
		signal: AbortSignal,
		ctx: ExtensionContext,
	) => ReturnType<typeof executeSubagent>;
	persistCompiled?: (compiled: CompiledWorkflowPlan, ctx: ExtensionContext) => Promise<void>;
}

export async function executeAutomationRequest(
	toolCallId: string,
	params: SubagentAutomationParams,
	signal: AbortSignal,
	onUpdate: AgentToolUpdateCallback<AutomationDetails> | undefined,
	ctx: ExtensionContext,
	options: AutomationExecutionOptions,
	isCurrent: () => boolean = () => true,
): Promise<AgentToolResult<AutomationDetails> & { isError?: boolean }> {
	validateAutomationToolParams(params);
	const request = parseAutomationRequest(params.request);
	assertCurrent(signal, isCurrent);
	const settings = options.getSettings();
	const plannerBudget = reservePlannerBudget(request.aggregateBudget);
	const plannerDetails: NonNullable<AutomationDetails["planner"]> = {
		agent: "planner",
		tools: [...AUTOMATION_PLANNER_TOOLS],
		resources: ctx.isProjectTrusted() ? "project-context" : "none",
		...plannerBudget,
	};
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	if (depth > 0) {
		return {
			content: [
				{
					type: "text",
					text: "Automation compiler rejected workflow recursion before planning or execution.",
				},
			],
			details: {
				status: "compiler-rejected",
				requestVersion: request.version,
				childCount: 0,
				reasonCodes: ["workflow-recursion-disabled"],
				planner: plannerDetails,
				isError: true,
			},
			isError: true,
		};
	}
	const executionRequest = reserveExecutionBudget(
		request,
		plannerBudget,
		resolveBlockingMaxParallelTasks(settings),
	);
	if (!executionRequest) {
		return nonLaunchResult(
			"compiler-rejected",
			request.version,
			["execution-budget-exhausted"],
			plannerDetails,
			new Error("Aggregate budget cannot fund both planning and execution"),
		);
	}
	onUpdate?.({
		content: [{ type: "text", text: "Planning a bounded autonomous workflow." }],
		details: {
			status: "planning",
			requestVersion: request.version,
			childCount: 0,
			reasonCodes: [],
			planner: plannerDetails,
		},
	});
	let proposal: WorkflowPlan;
	try {
		const prompt = buildAutomationPlannerPrompt(request);
		const runPlanner = options.runPlanner ?? runDefaultPlanner;
		const output = await runPlanner({
			prompt,
			ctx,
			signal,
			settings,
			...plannerBudget,
		});
		assertCurrent(signal, isCurrent);
		proposal = parseAutomationPlannerOutput(output);
	} catch (error) {
		if (signal.aborted || !isCurrent()) throw abortError("Automation planning was cancelled");
		return nonLaunchResult(
			"planner-failed",
			request.version,
			["planner-failed"],
			plannerDetails,
			error,
		);
	}
	const target = resolveSubagentTarget({
		workspace: ctx.cwd,
		requestedCwd: ctx.cwd,
		currentProjectTrusted: ctx.isProjectTrusted(),
	});
	try {
		assertDelegationTargetAllowed(
			target,
			settings?.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
		);
	} catch (error) {
		return nonLaunchResult(
			"compiler-rejected",
			request.version,
			["target-policy-rejected"],
			plannerDetails,
			error,
		);
	}
	const agents = discoverAgents(ctx.cwd, "user", settings).agents;
	const compiled = compileWorkflowPlan({
		request: executionRequest,
		proposal,
		agents,
		target: targetPolicyAudit(target),
		depth,
	});
	assertCurrent(signal, isCurrent);
	if (compiled.status !== "compiled") {
		return compilerNonLaunch(request.version, proposal.version, compiled, plannerDetails);
	}
	try {
		if (options.persistCompiled) await options.persistCompiled(compiled, ctx);
		else await persistCompiledWorkflow(compiled, ctx, settings);
		assertCurrent(signal, isCurrent);
	} catch (error) {
		return nonLaunchResult(
			"compiler-rejected",
			request.version,
			["plan-persistence-failed"],
			plannerDetails,
			error,
		);
	}
	const workflowParams = {
		workflow: compiled.workflow,
		agentScope: "user" as const,
		totalTimeoutMs: executionRequest.aggregateBudget.timeoutMs,
	};
	const execute =
		options.runWorkflow ??
		((workflow, workflowSignal, workflowContext) =>
			executeSubagent(toolCallId, workflow, workflowSignal, undefined, workflowContext, settings));
	const result = await execute(workflowParams, signal, ctx);
	assertCurrent(signal, isCurrent);
	const details: AutomationDetails = {
		status: "executed",
		requestVersion: request.version,
		planVersion: proposal.version,
		planId: compiled.planId,
		workflowGeneration: compiled.workflowGeneration,
		revision: compiled.revision,
		childCount: compiled.childCount,
		reasonCodes: [],
		planner: plannerDetails,
		compiled,
		execution: result.details,
		...(result.isError ? { isError: true } : {}),
	};
	return {
		content: result.content,
		details,
		...(result.usage ? { usage: result.usage } : {}),
		...(result.isError ? { isError: true } : {}),
	};
}

async function runDefaultPlanner(request: AutomationPlannerRequest): Promise<string> {
	const planner = getBuiltInAgent("planner");
	if (!planner) throw new Error("The built-in automation planner is unavailable");
	const policy = await resolveAutomationPlannerPolicy(
		request.ctx.isProjectTrusted(),
		request.ctx.cwd,
	);
	if (request.signal.aborted) throw abortError("Automation planner was cancelled before launch");
	const child = {
		...planner,
		tools: [...AUTOMATION_PLANNER_TOOLS],
		systemPrompt: [
			planner.systemPrompt,
			"This planning turn is read-only and cannot execute delegated work or create descendants.",
			"Return one exact versioned JSON workflow proposal without Markdown fences.",
		].join("\n\n"),
	};
	const result = await runSingleAgent(
		request.ctx.cwd,
		[child],
		child.name,
		request.prompt,
		request.ctx.cwd,
		undefined,
		request.signal,
		child.thinkingLevel,
		request.timeoutMs,
		undefined,
		(results): SubagentDetails => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results,
		}),
		undefined,
		{
			...policy.launchPolicy,
			tools: [...AUTOMATION_PLANNER_TOOLS],
			turnLimits: {
				maxTurns: request.maxTurns,
				maxToolCalls: request.maxToolCalls,
			},
		},
	);
	if (isResultError(result)) throw plannerFailure(result);
	return getResultFinalOutput(result);
}

async function persistCompiledWorkflow(
	compiled: CompiledWorkflowPlan,
	ctx: ExtensionContext,
	settings: SubagentSettings | undefined,
): Promise<void> {
	const agents = discoverAgents(ctx.cwd, "user", settings).agents;
	const resolved = resolveWorkflowTasks({ workflow: compiled.workflow }, agents);
	const ledger = createBlockingWorkLedger({ workflow: compiled.workflow }, resolved, undefined);
	if (!ledger) throw new Error("Compiled automation workflow did not create a WorkItem ledger");
	const owner =
		ctx.sessionManager.getSessionId?.() ??
		ctx.sessionManager.getSessionFile?.() ??
		`ephemeral:${ctx.cwd}`;
	const stable = createHash("sha256").update(`session:${owner}`).digest("hex").slice(0, 24);
	const filePath = path.join(getAgentDir(), "pi-subagents-workflows", `automation-${stable}.json`);
	await new AutomationPlanPersistence(filePath).save({
		record: createWorkflowPlanRecord(compiled),
		ledger: ledger.snapshot(),
	});
}

function validateAutomationToolParams(value: unknown): asserts value is SubagentAutomationParams {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("subagent_auto parameters must be an object");
	}
	const keys = Object.keys(value as Record<string, unknown>);
	if (keys.length !== 1 || keys[0] !== "request") {
		throw new Error("subagent_auto accepts exactly one request field");
	}
}

function compilerNonLaunch(
	requestVersion: string,
	planVersion: string,
	compiled: Exclude<WorkflowPlanCompilerResult, CompiledWorkflowPlan>,
	planner: NonNullable<AutomationDetails["planner"]>,
): AgentToolResult<AutomationDetails> & { isError?: boolean } {
	const status =
		compiled.status === "parent-owned"
			? "parent-owned"
			: compiled.status === "needs-input"
				? "needs-input"
				: "compiler-rejected";
	const isError = status === "compiler-rejected";
	return {
		content: [
			{
				type: "text",
				text:
					status === "parent-owned"
						? "Automation decision: keep this objective parent-owned; no execution workers were launched."
						: status === "needs-input"
							? `Automation needs input: ${(compiled.missingInputs ?? []).join(", ")}`
							: `Automation compiler rejected the proposal: ${compiled.reasonCodes.join(", ")}`,
			},
		],
		details: {
			status,
			requestVersion,
			planVersion,
			childCount: 0,
			reasonCodes: [...compiled.reasonCodes],
			...(compiled.missingInputs ? { missingInputs: [...compiled.missingInputs] } : {}),
			planner,
			...(isError ? { isError: true } : {}),
		},
		...(isError ? { isError: true } : {}),
	};
}

function nonLaunchResult(
	status: "planner-failed" | "compiler-rejected",
	requestVersion: string,
	reasonCodes: string[],
	planner: NonNullable<AutomationDetails["planner"]>,
	error: unknown,
): AgentToolResult<AutomationDetails> & { isError: true } {
	const message = boundedPrivateText(
		error instanceof Error ? error.message : String(error),
		2 * 1024,
	);
	return {
		content: [{ type: "text", text: `Automation ${status}: ${message}` }],
		details: {
			status,
			requestVersion,
			childCount: 0,
			reasonCodes,
			planner: { ...planner, ...(status === "planner-failed" ? { failed: true } : {}) },
			isError: true,
		},
		isError: true,
	};
}

function reservePlannerBudget(budget: {
	timeoutMs: number;
	maxTurns: number;
	maxToolCalls: number;
}) {
	return {
		timeoutMs: Math.max(
			1,
			Math.min(AUTOMATION_PLANNER_MAX_TIMEOUT_MS, Math.floor(budget.timeoutMs / 4)),
		),
		maxTurns: Math.max(1, Math.min(AUTOMATION_PLANNER_MAX_TURNS, Math.floor(budget.maxTurns / 4))),
		maxToolCalls: Math.max(
			1,
			Math.min(AUTOMATION_PLANNER_MAX_TOOL_CALLS, Math.floor(budget.maxToolCalls / 4)),
		),
	};
}

function reserveExecutionBudget(
	request: ReturnType<typeof parseAutomationRequest>,
	planner: ReturnType<typeof reservePlannerBudget>,
	maxWorkflowTasks: number,
): ReturnType<typeof parseAutomationRequest> | undefined {
	const remaining = {
		timeoutMs: request.aggregateBudget.timeoutMs - planner.timeoutMs,
		maxTurns: request.aggregateBudget.maxTurns - planner.maxTurns,
		maxToolCalls: request.aggregateBudget.maxToolCalls - planner.maxToolCalls,
	};
	if (remaining.timeoutMs < 1 || remaining.maxTurns < 1 || remaining.maxToolCalls < 1) {
		return undefined;
	}
	return {
		...request,
		aggregateBudget: {
			...request.aggregateBudget,
			...remaining,
			maxTasks: Math.min(request.aggregateBudget.maxTasks, maxWorkflowTasks),
		},
	};
}

function plannerFailure(result: SingleResult): Error {
	return new Error(
		boundedPrivateText(
			result.errorMessage || result.stderr.trim() || "Automation planner failed",
			2 * 1024,
		),
	);
}

function assertCurrent(signal: AbortSignal, isCurrent: () => boolean): void {
	if (signal.aborted || !isCurrent()) throw abortError("Autonomous workflow owner was replaced");
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}
