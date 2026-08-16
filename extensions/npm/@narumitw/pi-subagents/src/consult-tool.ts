import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentScope, ConsultResourcePolicy } from "./agents/types.js";
import { THINKING_LEVELS } from "./agents/types.js";
import { DEFAULT_MAX_CONTEXT_BYTES, MAX_SUBAGENT_TIMEOUT_MS } from "./limits.js";

const ConsultScopeSchema = StringEnum(["user", "project", "both"] as const, {
	default: "user",
	description: "Agent definition scope. Project scopes require a trusted project.",
});
const ConsultThinkingSchema = StringEnum(THINKING_LEVELS);

export const SubagentConsultParams = Type.Object(
	{
		agent: Type.String({ minLength: 1 }),
		task: Type.String({ minLength: 1, maxLength: DEFAULT_MAX_CONTEXT_BYTES }),
		agentScope: Type.Optional(ConsultScopeSchema),
		confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		timeoutMs: Type.Optional(
			Type.Number({
				minimum: 1,
				maximum: MAX_SUBAGENT_TIMEOUT_MS,
				description:
					"Work deadline selected for the consultation difficulty. On expiry, Pi aborts the work and makes one separately bounded summary attempt.",
			}),
		),
		thinkingLevel: Type.Optional(ConsultThinkingSchema),
	},
	{ additionalProperties: false },
);

export type SubagentConsultParams = Static<typeof SubagentConsultParams>;

export interface ConsultProgressActivity {
	type: "text" | "toolCall";
	text?: string;
	name?: "read" | "grep" | "find" | "ls";
	args?: Record<string, string | number | boolean>;
}

export interface ConsultProgress {
	phase: "starting" | "running";
	recentActivity: ConsultProgressActivity[];
	recentActivityTotal: number;
	actualProvider?: string;
	actualModel?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
}

export interface ConsultDetails {
	agent: string;
	agentSource: string;
	agentScope: AgentScope;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	timeoutMs: number;
	policy: {
		requestedTools: string[] | null;
		effectiveTools: string[];
		cwdBoundary: "current-workspace" | "external";
		targetTrust: {
			kind: string;
			projectTrusted: boolean;
			sourcePath?: string;
			warning?: string;
		};
		requestedResources: ConsultResourcePolicy;
		effectiveResources: {
			policy: ConsultResourcePolicy;
			projectResources: boolean;
			contextFiles: boolean;
			skills: boolean;
			promptTemplates: boolean;
		};
		resourceDowngradeReason?: string;
		extensions: "disabled";
		sessionPersistence: "disabled";
		retainedAgent: false;
	};
	child?: Record<string, unknown>;
	progress?: ConsultProgress;
	cancelled?: boolean;
	isError?: boolean;
	truncated?: boolean;
}
