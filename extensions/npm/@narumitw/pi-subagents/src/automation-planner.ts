import type { AutomationRequest, WorkflowPlan } from "./automation-contract.js";
import { parseWorkflowPlan, WORKFLOW_PLAN_VERSION } from "./automation-contract.js";
import { resolveConsultResourceLaunchPolicy } from "./consult-resources.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import type { ChildLaunchPolicy } from "./runner.js";

export const AUTOMATION_PLANNER_TOOLS = ["read", "grep", "find", "ls"] as const;
export const AUTOMATION_PLANNER_MAX_TIMEOUT_MS = 60_000;
export const AUTOMATION_PLANNER_MAX_TURNS = 8;
export const AUTOMATION_PLANNER_MAX_TOOL_CALLS = 16;

export interface AutomationPlannerPolicy {
	tools: string[];
	resources: "project-context" | "none";
	launchPolicy: ChildLaunchPolicy;
}

export function buildAutomationPlannerPrompt(request: AutomationRequest): string {
	const prompt = [
		"Compile the following explicit automation request into the smallest justified workflow proposal.",
		`Return only JSON for ${WORKFLOW_PLAN_VERSION}; do not wrap it in Markdown or add prose.`,
		"Do not provide hidden reasoning, chain-of-thought, or internal deliberation.",
		"Use summary and risks only for concise, user-visible conclusions.",
		"The executor, not this planning turn, owns identities, generations, agent selection, trust, tools, authority, workspace policy, and enforcement.",
		"Your proposal cannot grant authority, tools, trust, network, secrets, descendants, or budget beyond the request.",
		"Propose at most the request maxTasks and never propose workflow grandchildren.",
		"Each task must include id, objective, dependsOn, inputArtifacts, producesArtifacts, sideEffectPolicy, readPaths, writePaths, ownershipKeys, requiredCapabilities, requiredTools, acceptanceCriteria, requiredEvidence, integrationOwner, and budget.",
		"Use requiredVerificationRole and verifierFor only for a distinct direct verifier.",
		"Declare dependencies with dependsOn, declare artifact id, kind, and version, and connect every consumed artifact through a direct dependency.",
		"Use one authoritative integrationOwner for multi-task mutating work.",
		"If required information is absent, list it in missingInputs instead of inventing it.",
		"Request:",
		JSON.stringify(request),
		"Expected top-level fields: version, requestVersion, summary, missingInputs, risks, tasks.",
	].join("\n");
	const bounded = truncateUtf8(prompt, DEFAULT_MAX_CONTEXT_BYTES);
	if (bounded.truncated)
		throw new Error("Automation planner prompt exceeds the bounded context limit");
	return bounded.text;
}

export async function resolveAutomationPlannerPolicy(
	projectTrusted: boolean,
	cwd: string,
	resolver: typeof resolveConsultResourceLaunchPolicy = resolveConsultResourceLaunchPolicy,
): Promise<AutomationPlannerPolicy> {
	const resources = projectTrusted ? "project-context" : "none";
	const launchPolicy = await resolver(resources, projectTrusted, cwd);
	return {
		tools: [...AUTOMATION_PLANNER_TOOLS],
		resources,
		launchPolicy: {
			...launchPolicy,
			tools: [...AUTOMATION_PLANNER_TOOLS],
			disableExtensions: true,
		},
	};
}

export function parseAutomationPlannerOutput(output: string): WorkflowPlan {
	if (typeof output !== "string" || !output.trim()) {
		throw new Error("Automation planner returned no workflow plan");
	}
	return parseWorkflowPlan(output.trim());
}
