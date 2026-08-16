import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const INSPECT_ACTIONS = [
	"list_agents",
	"get_agent",
	"list_runs",
	"get_run",
	"list_workflows",
	"get_workflow",
	"list_models",
	"preview_context",
	"status",
	"diagnose",
] as const;

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	default: "user",
	description: "Agent definition scope. Project scopes require a trusted project.",
});
const LimitSchema = Type.Number({ minimum: 1, maximum: 100, multipleOf: 1 });
const ContextModeSchema = Type.Union([
	StringEnum(["none", "all", "summary"] as const),
	Type.Number({ minimum: 1, multipleOf: 1 }),
]);

export const SubagentInspectParams = Type.Object(
	{
		action: StringEnum(INSPECT_ACTIONS),
		agent: Type.Optional(Type.String({ minLength: 1 })),
		agentId: Type.Optional(Type.String({ minLength: 1 })),
		workflowId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		agentScope: Type.Optional(AgentScopeSchema),
		limit: Type.Optional(LimitSchema),
		includeClosed: Type.Optional(Type.Boolean({ default: false })),
		context: Type.Optional(ContextModeSchema),
		contextEntryIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);

export type SubagentInspectParams = Static<typeof SubagentInspectParams>;
export { INSPECT_ACTIONS };
