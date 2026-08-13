import {
	type DelegationAdmissionDecision,
	evaluateDelegationAdmission,
} from "./admission-policy.js";
import type { AgentConfig } from "./agents/types.js";
import type { AutomationRequest, WorkflowPlan, WorkflowPlanTask } from "./automation-contract.js";
import { MAX_AUTOMATION_ITEMS, workflowPlanIdentity } from "./automation-contract.js";
import { routeByCapability } from "./capability-router.js";
import type { TargetPolicyAudit } from "./cwd-policy.js";
import {
	acknowledgeExecutionPlan,
	createExecutionPlan,
	type ExecutionPlan,
	resolveContractTools,
} from "./execution-plan.js";
import type { SubagentParams } from "./params.js";
import { validateWorkflowVerificationGraph } from "./verification-policy.js";

export interface WorkflowPlanCompilerInput {
	request: AutomationRequest;
	proposal: WorkflowPlan;
	agents: readonly AgentConfig[];
	target: TargetPolicyAudit;
	depth: number;
}

interface NonLaunchResult {
	status: "parent-owned" | "needs-input" | "rejected";
	childCount: 0;
	reasonCodes: string[];
	admission?: DelegationAdmissionDecision;
	missingInputs?: string[];
}

export interface CompiledWorkflowPlan {
	status: "compiled";
	childCount: number;
	planId: string;
	workflowGeneration: number;
	revision: number;
	request: AutomationRequest;
	plan: WorkflowPlan;
	workflow: NonNullable<SubagentParams["workflow"]>;
	executionPlans: ExecutionPlan[];
	admission: DelegationAdmissionDecision;
	maxConcurrentMutating: number;
	aggregateBudget: {
		timeoutMs: number;
		maxTurns: number;
		maxToolCalls: number;
	};
}

export type WorkflowPlanCompilerResult = NonLaunchResult | CompiledWorkflowPlan;

export function compileWorkflowPlan(input: WorkflowPlanCompilerInput): WorkflowPlanCompilerResult {
	if (input.depth > 0) return rejected("workflow-recursion-disabled");
	if (!input.target.trust.projectTrusted) return rejected("target-not-trusted");
	if (input.request.constraints.workspaceMode !== "shared") {
		return rejected("workspace-mode-unsupported");
	}
	if (input.proposal.missingInputs.length > 0) {
		return {
			status: "needs-input",
			childCount: 0,
			reasonCodes: ["planner-reported-missing-inputs"],
			missingInputs: [...input.proposal.missingInputs],
		};
	}
	if (
		input.proposal.tasks.length > input.request.aggregateBudget.maxTasks ||
		input.proposal.tasks.length > 8
	) {
		return rejected("task-budget-exceeded");
	}
	const budget = aggregateBudget(input.proposal.tasks);
	const budgetAllowsChildren = withinBudget(budget, input.request);
	const authorityError = validateAuthority(input.proposal.tasks, input.request);
	if (authorityError) return rejected(authorityError);
	const primaryTasks = input.proposal.tasks.filter((task) => !task.verifierFor);
	const roots = primaryTasks.filter((task) =>
		task.dependsOn.every(
			(dependency) => !primaryTasks.some((candidate) => candidate.id === dependency),
		),
	);
	const mutatingTasks = primaryTasks.filter((task) => task.sideEffectPolicy === "mutating");
	const verificationRequired =
		input.request.constraints.requireVerification || mutatingTasks.length > 0;
	const eligibleAgents = filterAllowedAgents(input.agents, input.request);
	const verificationAvailable = verificationRequired
		? eligibleAgents.some(
				(agent) =>
					agent.capabilityManifest?.verificationRoles.includes("independent-review") &&
					agent.capabilityManifest.resultFormats.includes("structured-v2"),
			)
		: true;
	const admission = evaluateDelegationAdmission({
		contextPressure: input.request.constraints.contextPressure,
		independentWorkItems: Math.max(1, roots.length),
		coupling: roots.length >= 2 ? "sparse" : "dense",
		verificationRequired,
		verificationAvailable,
		capabilitiesSupported: proposalCapabilitiesSupported(
			input.proposal.tasks,
			eligibleAgents,
			input.request,
		),
		budgetAllowsChildren,
		generationCurrent: true,
		requirementsComplete:
			input.request.acceptanceCriteria.length > 0 && input.proposal.missingInputs.length === 0,
	});
	if (admission.recommendation === "parent-owned-direct") {
		return {
			status: "parent-owned",
			childCount: 0,
			reasonCodes: [...admission.reasonCodes],
			admission,
		};
	}
	if (admission.recommendation === "abstain-insufficient-evidence") {
		return {
			status: "rejected",
			childCount: 0,
			reasonCodes: [...admission.reasonCodes],
			admission,
		};
	}
	const integrationError = validateIntegrationPath(primaryTasks, mutatingTasks);
	if (integrationError) return rejected(integrationError, admission);
	const maxConcurrentMutating = calculateMaxConcurrentMutating(primaryTasks);
	if (
		maxConcurrentMutating > 2 ||
		maxConcurrentMutating > input.request.constraints.maxMutatingWidth
	) {
		return rejected("mutating-width-exceeded", admission);
	}

	let normalizedTasks = input.proposal.tasks.map((task) => structuredClone(task));
	if (mutatingTasks.length === 1 && !mutatingTasks[0]?.integrationOwner) {
		normalizedTasks = normalizedTasks.map((task) =>
			task.id === mutatingTasks[0]?.id ? { ...task, integrationOwner: true } : task,
		);
	}
	if (
		verificationRequired &&
		normalizedTasks.filter((task) => !task.verifierFor).length === 1 &&
		!normalizedTasks.some((task) => task.integrationOwner)
	) {
		normalizedTasks = normalizedTasks.map((task) =>
			task.verifierFor ? task : { ...task, integrationOwner: true },
		);
	}
	if (verificationRequired) {
		const target = verificationTarget(normalizedTasks);
		if (!target) return rejected("integration-owner-required", admission);
		const existing = normalizedTasks.filter((task) => task.verifierFor === target.id);
		if (existing.length > 1) return rejected("multiple-verifiers", admission);
		if (existing.length === 0) {
			const synthesized = synthesizeVerifier(target, input.request, normalizedTasks);
			if (!synthesized) return rejected("verification-budget-insufficient", admission);
			normalizedTasks.push(synthesized);
		}
	}
	const requirementsApplied = applyRequestRequirements(normalizedTasks, input.request);
	if (!requirementsApplied) {
		return rejected("request-requirements-exceed-task-limit", admission);
	}
	normalizedTasks = requirementsApplied;
	if (normalizedTasks.length > input.request.aggregateBudget.maxTasks) {
		return rejected("task-budget-exceeded-after-verification", admission);
	}
	const normalizedAuthorityError = validateAuthority(normalizedTasks, input.request);
	if (normalizedAuthorityError) return rejected(normalizedAuthorityError, admission);
	const normalizedPlan: WorkflowPlan = { ...input.proposal, tasks: normalizedTasks };
	const finalBudget = aggregateBudget(normalizedTasks);
	if (!withinBudget(finalBudget, input.request)) {
		return rejected("aggregate-budget-exceeded", admission);
	}

	let compiled: ReturnType<typeof compileTasks>;
	try {
		validateVerifierTasks(normalizedTasks);
		compiled = compileTasks(normalizedTasks, input.request, eligibleAgents, input.target);
		const requiredTarget = verificationRequired ? verificationTarget(normalizedTasks) : undefined;
		validateWorkflowVerificationGraph(
			compiled.workflowTasks.map((task) => ({
				id: task.id,
				agent: task.agent as string,
				dependsOn: task.dependsOn,
				verifierFor: task.verifierFor,
				resultFormat: task.resultFormat,
			})),
			new Set(requiredTarget ? [requiredTarget.id] : []),
		);
	} catch (error) {
		return rejected(reasonFromError(error), admission);
	}
	const planId = workflowPlanIdentity(normalizedPlan, 0, 0);
	return {
		status: "compiled",
		childCount: compiled.workflowTasks.length,
		planId,
		workflowGeneration: 0,
		revision: 0,
		request: structuredClone(input.request),
		plan: normalizedPlan,
		workflow: {
			id: `auto-${planId.slice(0, 24)}`,
			honorAdmission: false,
			tasks: compiled.workflowTasks,
		},
		executionPlans: compiled.executionPlans,
		admission,
		maxConcurrentMutating,
		aggregateBudget: finalBudget,
	};
}

function compileTasks(
	tasks: readonly WorkflowPlanTask[],
	request: AutomationRequest,
	agents: readonly AgentConfig[],
	target: TargetPolicyAudit,
): {
	workflowTasks: NonNullable<SubagentParams["workflow"]>["tasks"];
	executionPlans: ExecutionPlan[];
} {
	const selected = new Map<string, AgentConfig>();
	const routingOrder = [...tasks].sort(
		(left, right) => Number(Boolean(left.verifierFor)) - Number(Boolean(right.verifierFor)),
	);
	for (const task of routingOrder) {
		const verifierTarget = task.verifierFor;
		const candidates = verifierTarget
			? agents.filter((agent) => agent.name !== selected.get(verifierTarget)?.name)
			: agents;
		const route = routeByCapability(candidates, {
			requiredCapabilities: task.requiredCapabilities,
			requiredTools: task.requiredTools,
			requiredVerificationRole: task.verifierFor
				? (task.requiredVerificationRole ?? "independent-review")
				: task.requiredVerificationRole,
			requiredSideEffectClass: task.sideEffectPolicy === "read-only" ? "read-only" : undefined,
			preferredCostHint: task.preferredCostHint,
			preferredLatencyHint: task.preferredLatencyHint,
		});
		selected.set(task.id, route.agent);
	}
	const workflowTasks: NonNullable<SubagentParams["workflow"]>["tasks"] = [];
	const executionPlans: ExecutionPlan[] = [];
	for (const task of tasks) {
		const agent = selected.get(task.id);
		if (!agent) throw new Error(`No capable agent for ${task.id}`);
		if (task.verifierFor && selected.get(task.verifierFor)?.name === agent.name) {
			throw new Error(`Verification agent for ${task.id} is not distinct`);
		}
		const dependencies = task.dependsOn.map((taskId) => ({ taskId }));
		const contract = {
			version: "pi-subagents:delegation:v2" as const,
			level: "full" as const,
			taskId: task.id,
			objective: task.objective,
			nonGoals: [...request.nonGoals],
			dependencies,
			requiredInputs: [...task.inputArtifacts],
			requestedAuthority: {
				capabilities: [...task.requiredCapabilities],
				tools: [...task.requiredTools],
				network: "unspecified" as const,
				secrets: "unspecified" as const,
			},
			acceptanceCriteria: [...task.acceptanceCriteria],
			requiredEvidence: [...task.requiredEvidence],
			budget: { ...task.budget },
			admission: {
				contextPressure: request.constraints.contextPressure,
				independentWorkItems: Math.min(
					2,
					Math.max(1, tasks.filter((item) => !item.verifierFor).length),
				),
				coupling: tasks.some((item) => item.dependsOn.length > 0)
					? ("dense" as const)
					: ("sparse" as const),
				verificationRequired: task.integrationOwner && task.sideEffectPolicy === "mutating",
				verificationAvailable: tasks.some((item) => item.verifierFor === task.id),
				budgetAllowsChildren: true,
				requirementsComplete: true,
			},
			sideEffectPolicy: task.sideEffectPolicy,
			enforcement: "enforce" as const,
		};
		const effectiveTools = resolveContractTools(agent.tools, contract);
		const resultFormat = "structured-v2" as const;
		const executionPlan = createExecutionPlan({
			contract,
			agent,
			effectiveTools,
			target,
			workspaceMode: request.constraints.workspaceMode,
			transport: "subprocess",
			resultFormat,
			model: agent.model,
			thinkingLevel: agent.thinkingLevel,
			timeoutMs: task.budget.timeoutMs,
			taskGeneration: 1,
		});
		const acknowledgement = acknowledgeExecutionPlan(executionPlan);
		if (acknowledgement.status !== "accepted") {
			throw new Error(`Execution plan rejected: ${acknowledgement.reasonCodes.join(",")}`);
		}
		executionPlans.push(executionPlan);
		workflowTasks.push({
			id: task.id,
			agent: agent.name,
			requiredCapabilities: [...task.requiredCapabilities],
			requiredTools: [...task.requiredTools],
			...(task.requiredVerificationRole
				? { requiredVerificationRole: task.requiredVerificationRole }
				: task.verifierFor
					? { requiredVerificationRole: "independent-review" }
					: {}),
			task: taskPrompt(task),
			dependsOn: [...task.dependsOn],
			inputArtifacts: [...task.inputArtifacts],
			inputArtifactVersions: Object.fromEntries(
				task.inputArtifacts.flatMap((artifactId) => {
					const artifact = tasks
						.flatMap((candidate) => candidate.producesArtifacts)
						.find((candidate) => candidate.id === artifactId);
					return artifact ? [[artifact.id, artifact.version]] : [];
				}),
			),
			readPaths: [...task.readPaths],
			writePaths: [...task.writePaths],
			ownershipKeys: [...task.ownershipKeys],
			acceptanceCriteria: [...task.acceptanceCriteria],
			integrationOwner: task.integrationOwner,
			...(task.verifierFor ? { verifierFor: task.verifierFor } : {}),
			timeoutMs: task.budget.timeoutMs,
			maxTurns: task.budget.maxTurns,
			maxToolCalls: task.budget.maxToolCalls,
			contract,
			resultFormat,
		});
	}
	return { workflowTasks, executionPlans };
}

function applyRequestRequirements(
	tasks: readonly WorkflowPlanTask[],
	request: AutomationRequest,
): WorkflowPlanTask[] | undefined {
	const dependencyIds = new Set(tasks.flatMap((task) => task.dependsOn));
	const result: WorkflowPlanTask[] = [];
	for (const task of tasks) {
		const authoritative =
			task.integrationOwner || Boolean(task.verifierFor) || !dependencyIds.has(task.id);
		if (!authoritative) {
			result.push(task);
			continue;
		}
		const acceptanceCriteria = unique([...task.acceptanceCriteria, ...request.acceptanceCriteria]);
		const requiredEvidence = unique([...task.requiredEvidence, ...request.requiredEvidence]);
		if (
			acceptanceCriteria.length > MAX_AUTOMATION_ITEMS ||
			requiredEvidence.length > MAX_AUTOMATION_ITEMS
		) {
			return undefined;
		}
		result.push({ ...task, acceptanceCriteria, requiredEvidence });
	}
	return result;
}

function validateVerifierTasks(tasks: readonly WorkflowPlanTask[]): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	for (const task of tasks) {
		if (!task.verifierFor) continue;
		const target = byId.get(task.verifierFor);
		if (!target || target.verifierFor) {
			throw new Error(`Workflow verifier ${task.id} has an invalid verification target`);
		}
		if (
			task.sideEffectPolicy !== "read-only" ||
			task.writePaths.length > 0 ||
			task.dependsOn.length !== 1 ||
			task.dependsOn[0] !== target.id
		) {
			throw new Error(`Workflow verifier ${task.id} must be one direct read-only verifier`);
		}
	}
}

function validateAuthority(
	tasks: readonly WorkflowPlanTask[],
	request: AutomationRequest,
): string | undefined {
	const ceiling = request.authorityCeiling;
	const sideEffectRank = { "read-only": 0, idempotent: 1, mutating: 2 } as const;
	for (const task of tasks) {
		if (
			task.sideEffectPolicy === "read-only" &&
			task.requiredTools.some((tool) => ["bash", "edit", "write"].includes(tool))
		) {
			return "read-only-tool-authority-conflict";
		}
		if (sideEffectRank[task.sideEffectPolicy] > sideEffectRank[ceiling.sideEffectPolicy]) {
			return "side-effect-authority-exceeded";
		}
		if (task.requiredCapabilities.some((item) => !ceiling.capabilities.includes(item))) {
			return "capability-authority-exceeded";
		}
		if (task.requiredTools.some((item) => !ceiling.tools.includes(item))) {
			return "tool-authority-exceeded";
		}
		if (task.readPaths.some((item) => !withinAnyScope(item, ceiling.readPaths))) {
			return "read-scope-exceeded";
		}
		if (task.writePaths.some((item) => !withinAnyScope(item, ceiling.writePaths))) {
			return "write-scope-exceeded";
		}
	}
	return undefined;
}

function validateIntegrationPath(
	primaryTasks: readonly WorkflowPlanTask[],
	mutatingTasks: readonly WorkflowPlanTask[],
): string | undefined {
	if (mutatingTasks.length <= 1) return undefined;
	const owners = primaryTasks.filter((task) => task.integrationOwner);
	if (owners.length !== 1) return "integration-owner-required";
	const owner = owners[0];
	const byId = new Map(primaryTasks.map((task) => [task.id, task]));
	const dependsOn = (task: WorkflowPlanTask, target: string, seen = new Set<string>()): boolean => {
		if (seen.has(task.id)) return false;
		seen.add(task.id);
		return task.dependsOn.some(
			(dependency) =>
				dependency === target ||
				(Boolean(byId.get(dependency)) &&
					dependsOn(byId.get(dependency) as WorkflowPlanTask, target, seen)),
		);
	};
	if (mutatingTasks.some((task) => task.id !== owner.id && !dependsOn(owner, task.id))) {
		return "integration-path-incomplete";
	}
	return undefined;
}

function synthesizeVerifier(
	target: WorkflowPlanTask,
	request: AutomationRequest,
	tasks: readonly WorkflowPlanTask[],
): WorkflowPlanTask | undefined {
	if (
		!request.authorityCeiling.capabilities.includes("code-review") ||
		!request.authorityCeiling.tools.includes("read")
	) {
		return undefined;
	}
	const current = aggregateBudget(tasks);
	const remaining = {
		timeoutMs: request.aggregateBudget.timeoutMs - current.timeoutMs,
		maxTurns: request.aggregateBudget.maxTurns - current.maxTurns,
		maxToolCalls: request.aggregateBudget.maxToolCalls - current.maxToolCalls,
	};
	if (remaining.timeoutMs < 1 || remaining.maxTurns < 1 || remaining.maxToolCalls < 1)
		return undefined;
	let id = `verify-${target.id}`;
	for (let suffix = 2; tasks.some((task) => task.id === id); suffix++)
		id = `verify-${target.id}-${suffix}`;
	return {
		id,
		objective: `Independently verify ${target.id} against its acceptance criteria and required evidence`,
		dependsOn: [target.id],
		inputArtifacts: [],
		producesArtifacts: [],
		sideEffectPolicy: "read-only",
		readPaths: [...target.readPaths, ...target.writePaths].filter(
			(value, index, values) => values.indexOf(value) === index,
		),
		writePaths: [],
		ownershipKeys: [],
		requiredCapabilities: ["code-review"],
		requiredTools: ["read"],
		requiredVerificationRole: "independent-review",
		acceptanceCriteria: [...target.acceptanceCriteria],
		requiredEvidence: [...target.requiredEvidence],
		integrationOwner: false,
		verifierFor: target.id,
		budget: {
			timeoutMs: Math.min(60_000, remaining.timeoutMs),
			maxTurns: Math.min(8, remaining.maxTurns),
			maxToolCalls: Math.min(16, remaining.maxToolCalls),
		},
	};
}

function verificationTarget(tasks: readonly WorkflowPlanTask[]): WorkflowPlanTask | undefined {
	const primary = tasks.filter((task) => !task.verifierFor);
	return (
		primary.find((task) => task.integrationOwner) ??
		(primary.filter((task) => task.sideEffectPolicy === "mutating").length === 1
			? primary.find((task) => task.sideEffectPolicy === "mutating")
			: undefined)
	);
}

function proposalCapabilitiesSupported(
	tasks: readonly WorkflowPlanTask[],
	agents: readonly AgentConfig[],
	request: AutomationRequest,
): boolean {
	if (validateAuthority(tasks, request)) return false;
	return tasks.every((task) => {
		try {
			routeByCapability(agents, {
				requiredCapabilities: task.requiredCapabilities,
				requiredTools: task.requiredTools,
				requiredVerificationRole: task.requiredVerificationRole,
				requiredSideEffectClass: task.sideEffectPolicy === "read-only" ? "read-only" : undefined,
			});
			return true;
		} catch {
			return false;
		}
	});
}

function filterAllowedAgents(
	agents: readonly AgentConfig[],
	request: AutomationRequest,
): AgentConfig[] {
	const allowed = request.constraints.allowedAgents;
	return allowed ? agents.filter((agent) => allowed.includes(agent.name)) : [...agents];
}

function aggregateBudget(tasks: readonly WorkflowPlanTask[]) {
	return tasks.reduce(
		(total, task) => ({
			timeoutMs: total.timeoutMs + task.budget.timeoutMs,
			maxTurns: total.maxTurns + task.budget.maxTurns,
			maxToolCalls: total.maxToolCalls + task.budget.maxToolCalls,
		}),
		{ timeoutMs: 0, maxTurns: 0, maxToolCalls: 0 },
	);
}

function withinBudget(
	budget: ReturnType<typeof aggregateBudget>,
	request: AutomationRequest,
): boolean {
	return (
		budget.timeoutMs <= request.aggregateBudget.timeoutMs &&
		budget.maxTurns <= request.aggregateBudget.maxTurns &&
		budget.maxToolCalls <= request.aggregateBudget.maxToolCalls
	);
}

function calculateMaxConcurrentMutating(tasks: readonly WorkflowPlanTask[]): number {
	const levels = new Map<string, number>();
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const level = (task: WorkflowPlanTask): number => {
		const cached = levels.get(task.id);
		if (cached !== undefined) return cached;
		const value = task.dependsOn.length
			? 1 + Math.max(...task.dependsOn.map((id) => level(byId.get(id) as WorkflowPlanTask)))
			: 0;
		levels.set(task.id, value);
		return value;
	};
	const counts = new Map<number, number>();
	for (const task of tasks) {
		if (task.sideEffectPolicy !== "mutating") continue;
		const taskLevel = level(task);
		counts.set(taskLevel, (counts.get(taskLevel) ?? 0) + 1);
	}
	return Math.max(0, ...counts.values());
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function withinAnyScope(candidate: string, scopes: readonly string[]): boolean {
	return scopes.some(
		(scope) =>
			scope === "." || candidate === scope || candidate.startsWith(`${scope.replace(/\/$/u, "")}/`),
	);
}

function taskPrompt(task: WorkflowPlanTask): string {
	return [
		task.objective,
		`Acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}.`,
		`Required evidence: ${JSON.stringify(task.requiredEvidence)}.`,
		"Stay within the executor-declared authority and report missing inputs instead of guessing.",
	].join("\n");
}

function rejected(reasonCode: string, admission?: DelegationAdmissionDecision): NonLaunchResult {
	return {
		status: "rejected",
		childCount: 0,
		reasonCodes: [reasonCode],
		...(admission ? { admission } : {}),
	};
}

function reasonFromError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/verification/i.test(message)) return "verification-agent-unavailable";
	if (/capab|tool/i.test(message)) return "capability-unsupported";
	if (/execution plan/i.test(message)) return "execution-plan-rejected";
	return "workflow-compilation-failed";
}
