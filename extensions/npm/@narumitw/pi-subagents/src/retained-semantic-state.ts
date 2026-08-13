import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, SubagentThinkingLevel, SubagentTransportKind } from "./agents/types.js";
import type { TargetPolicyAudit } from "./cwd-policy.js";
import type { DelegationContract } from "./delegation-contract.js";
import {
	acknowledgeExecutionPlan,
	createExecutionPlan,
	type ExecutionPlan,
	resolveContractTools,
} from "./execution-plan.js";
import type { SubagentResultFormat } from "./result-contract.js";
import {
	captureRepositoryGeneration,
	captureSemanticResourceGeneration,
	captureSemanticSnapshot,
	type SemanticSnapshot,
} from "./semantic-snapshot.js";

export interface RetainedSemanticStateInput {
	agent: AgentConfig;
	contract?: DelegationContract;
	target: TargetPolicyAudit;
	cwd: string;
	workspaceMode: "shared" | "worktree";
	transport: SubagentTransportKind;
	resultFormat: SubagentResultFormat;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	taskGeneration?: number;
	cancellationLineage?: string[];
}

export interface RetainedSemanticState {
	executionPlan: ExecutionPlan;
	semanticSnapshot: SemanticSnapshot;
}

export async function buildRetainedSemanticState(
	input: RetainedSemanticStateInput,
): Promise<RetainedSemanticState> {
	const executionPlan = createExecutionPlan({
		contract: input.contract,
		agent: input.agent,
		effectiveTools: resolveContractTools(input.agent.tools, input.contract),
		target: input.target,
		workspaceMode: input.workspaceMode,
		transport: input.transport,
		resultFormat: input.resultFormat,
		model: input.agent.model,
		thinkingLevel: input.thinkingLevel ?? input.agent.thinkingLevel,
		timeoutMs: input.timeoutMs ?? input.agent.timeoutMs,
		taskGeneration: input.taskGeneration,
		cancellationLineage: input.cancellationLineage,
	});
	const acknowledgement = acknowledgeExecutionPlan(executionPlan);
	if (acknowledgement.status === "rejected") {
		throw new Error(`Execution plan rejected: ${JSON.stringify(acknowledgement)}`);
	}
	const agentDir = getAgentDir();
	const [repository, resourceGeneration] = await Promise.all([
		captureRepositoryGeneration(input.cwd),
		captureSemanticResourceGeneration([
			path.join(agentDir, "skills"),
			path.join(agentDir, "prompts"),
			path.join(agentDir, "SYSTEM.md"),
			path.join(agentDir, "APPEND_SYSTEM.md"),
			path.join(input.cwd, ".pi", "skills"),
			path.join(input.cwd, ".pi", "prompts"),
			path.join(input.cwd, "AGENTS.md"),
			path.join(input.cwd, "CLAUDE.md"),
			path.join(input.cwd, "SYSTEM.md"),
			path.join(input.cwd, "APPEND_SYSTEM.md"),
		]),
	]);
	return {
		executionPlan,
		semanticSnapshot: captureSemanticSnapshot({
			agentName: input.agent.name,
			agentManifest: {
				manifest: input.agent.capabilityManifest,
				delegationContract: input.contract,
				resourceGeneration,
			},
			rolePrompt: input.agent.systemPrompt,
			tools: executionPlan.effectiveTools,
			model: executionPlan.model,
			thinkingLevel: executionPlan.thinkingLevel,
			transport: input.transport,
			trust: {
				kind: input.target.trust.kind,
				projectTrusted: input.target.trust.projectTrusted,
			},
			repository,
			artifacts: {},
			workflowGeneration: 0,
			schedulerPolicy: "retained-fifo-v1",
		}),
	};
}
