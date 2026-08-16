import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { THINKING_LEVELS } from "./agents/types.js";
import { DelegationContractSchema } from "./delegation-contract.js";
import { MAX_CONFIGURABLE_PARALLEL_TASKS, MAX_SUBAGENT_TIMEOUT_MS } from "./limits.js";
import { PANEL_PRESETS } from "./panel-planning.js";
import { SUBAGENT_RESULT_FORMATS } from "./result-contract.js";
import { MAX_SUBAGENT_TOOL_CALLS, MAX_SUBAGENT_TURNS } from "./turn-budget.js";
import { VerifiedExecutionContractSchema } from "./verified-execution-schema.js";

const TimeoutMs = Type.Number({
	description:
		"Work deadline in milliseconds selected for the task difficulty. On expiry, Pi aborts the work and makes one separately bounded summary attempt. Defaults to PI_SUBAGENT_TIMEOUT_MS or 600000.",
	minimum: 1,
	maximum: MAX_SUBAGENT_TIMEOUT_MS,
});

const TurnLimitFields = {
	idleTimeoutMs: Type.Optional(
		Type.Integer({
			description:
				"Maximum milliseconds without a completed assistant turn or tool result before Pi aborts work and preserves a checkpoint.",
			minimum: 1,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
		}),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			description: "Maximum assistant turns before unfinished work is stopped and checkpointed.",
			minimum: 1,
			maximum: MAX_SUBAGENT_TURNS,
		}),
	),
	maxToolCalls: Type.Optional(
		Type.Integer({
			description: "Maximum tool calls before additional tool work is stopped and checkpointed.",
			minimum: 1,
			maximum: MAX_SUBAGENT_TOOL_CALLS,
		}),
	),
};

const ThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
	description:
		"Pi thinking level for the subagent process: off, minimal, low, medium, high, xhigh, or max.",
});

const ResultFormatSchema = StringEnum(SUBAGENT_RESULT_FORMATS, {
	description:
		"Optional completion contract. Text preserves ordinary output; structured-v1 and structured-v2 request versioned JSON with bounded text fallback.",
});

const ContractFields = {
	contract: Type.Optional(DelegationContractSchema),
	resultFormat: Type.Optional(ResultFormatSchema),
	retryPolicy: Type.Optional(
		Type.Object(
			{
				maxAttempts: Type.Integer({ minimum: 1, maximum: 3 }),
				backoffMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
			},
			{ additionalProperties: false },
		),
	),
	hedgeAfterMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30_000 })),
};

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	...TurnLimitFields,
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	...ContractFields,
});

const WorkflowTaskItem = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 256 }),
	agent: Type.Optional(
		Type.String({ description: "Optional explicit agent; omit to route by capability manifest" }),
	),
	requiredCapabilities: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 50 }),
	),
	requiredTools: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 50 }),
	),
	requiredVerificationRole: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	preferredCostHint: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	preferredLatencyHint: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	task: Type.String({ description: "Task to delegate to the agent" }),
	dependsOn: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
	),
	inputArtifacts: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 50 }),
	),
	inputArtifactVersions: Type.Optional(
		Type.Record(
			Type.String({ minLength: 1, maxLength: 256 }),
			Type.String({ minLength: 1, maxLength: 256 }),
		),
	),
	readPaths: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 50 })),
	writePaths: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 50 })),
	ownershipKeys: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 50 })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 50 })),
	integrationOwner: Type.Optional(Type.Boolean()),
	verifierFor: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 256,
			description:
				"Target task ID for one distinct direct-dependent structured-v2 verifier. The executor gates target acceptance on a current exact-tree receipt.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	...TurnLimitFields,
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	...ContractFields,
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	timeoutMs: Type.Optional(TimeoutMs),
	...TurnLimitFields,
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	...ContractFields,
});

const AggregatorItem = Type.Object(
	{
		agent: Type.String({
			description: "Name of the fan-in agent to invoke after parallel tasks complete",
		}),
		task: Type.String({
			description: "Fan-in task. Use {previous} to include all parallel outputs.",
		}),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the aggregator process" }),
		),
		timeoutMs: Type.Optional(TimeoutMs),
		...TurnLimitFields,
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		...ContractFields,
	},
	{
		description:
			"Optional fan-in step for parallel mode. Omit this key entirely when no aggregation is needed; empty or whitespace-only agent/task values are treated as absent.",
	},
);

const PanelReviewerItem = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 256 }),
		agent: Type.String({ minLength: 1 }),
		focus: Type.Optional(Type.String({ maxLength: 8 * 1024 })),
		timeoutMs: Type.Optional(TimeoutMs),
		...TurnLimitFields,
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
	},
	{ additionalProperties: false },
);

const PanelSynthesizerItem = Type.Object(
	{
		agent: Type.String({ minLength: 1 }),
		timeoutMs: Type.Optional(TimeoutMs),
		...TurnLimitFields,
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
	},
	{ additionalProperties: false },
);

const PanelItem = Type.Object(
	{
		id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		preset: Type.Optional(StringEnum(PANEL_PRESETS, { default: "custom" })),
		task: Type.String({ minLength: 1, maxLength: 50 * 1024 }),
		context: Type.Optional(Type.String({ maxLength: 50 * 1024 })),
		reviewers: Type.Array(PanelReviewerItem, {
			minItems: 2,
			maxItems: MAX_CONFIGURABLE_PARALLEL_TASKS,
		}),
		synthesizer: PanelSynthesizerItem,
		minValidReviews: Type.Optional(Type.Integer({ minimum: 2 })),
	},
	{
		additionalProperties: false,
		description:
			"One bounded independent review round followed by one evidence-preserving synthesis when enough valid reviews remain.",
	},
);

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Per-invocation custom agent scope. Default: "user". Use "project" for project-local agents or "both" for user and project agents; this is a tool argument, not a pi-subagents.json setting.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode)" }),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
			maxItems: MAX_CONFIGURABLE_PARALLEL_TASKS,
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" }),
	),
	aggregator: Type.Optional(AggregatorItem),
	panel: Type.Optional(PanelItem),
	workflow: Type.Optional(
		Type.Object(
			{
				id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
				verifiedExecution: Type.Optional(VerifiedExecutionContractSchema),
				honorAdmission: Type.Optional(
					Type.Boolean({
						description:
							"Opt in to declining workflow tasks whose explicit audit metadata recommends parent-owned work or abstention.",
					}),
				),
				tasks: Type.Array(WorkflowTaskItem, {
					minItems: 1,
					maxItems: MAX_CONFIGURABLE_PARALLEL_TASKS,
				}),
			},
			{ additionalProperties: false },
		),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process (single mode)" }),
	),
	timeoutMs: Type.Optional(TimeoutMs),
	totalTimeoutMs: Type.Optional(
		Type.Number({
			description:
				"Overall blocking-workflow deadline in milliseconds, including queued work, workflow tasks, panel phases, chain steps, and fan-in.",
			minimum: 1,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
		}),
	),
	...TurnLimitFields,
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	...ContractFields,
});

export type SubagentParams = Static<typeof SubagentParams>;

export function hasUsableAggregator(
	aggregator: unknown,
): aggregator is { agent: string; task: string } {
	if (!aggregator || typeof aggregator !== "object") return false;
	const candidate = aggregator as { agent?: unknown; task?: unknown };
	return (
		typeof candidate.agent === "string" &&
		candidate.agent.trim().length > 0 &&
		typeof candidate.task === "string" &&
		candidate.task.trim().length > 0
	);
}
