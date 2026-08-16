import { type Static, Type } from "typebox";
import { AutomationRequestSchema } from "./automation-contract.js";
import type { SubagentDetails } from "./runner.js";
import type { CompiledWorkflowPlan } from "./workflow-plan-compiler.js";

export const SubagentAutomationParams = Type.Object(
	{ request: AutomationRequestSchema },
	{ additionalProperties: false },
);
export type SubagentAutomationParams = Static<typeof SubagentAutomationParams>;

export interface AutomationDetails {
	status:
		| "planning"
		| "planner-failed"
		| "parent-owned"
		| "needs-input"
		| "compiler-rejected"
		| "executed";
	requestVersion: string;
	planVersion?: string;
	planId?: string;
	workflowGeneration?: number;
	revision?: number;
	childCount: number;
	reasonCodes: string[];
	missingInputs?: string[];
	planner?: {
		agent: string;
		tools: string[];
		resources: "project-context" | "none";
		timeoutMs: number;
		maxTurns: number;
		maxToolCalls: number;
		failed?: boolean;
	};
	compiled?: CompiledWorkflowPlan;
	execution?: SubagentDetails;
	isError?: boolean;
}
