import { normalizeDelegationContract } from "./delegation-contract.js";
import {
	type VerificationCheckRequest,
	validateVerificationChecks,
} from "./verification-harness.js";
import type { VerifiedExecutionContract } from "./verified-execution-schema.js";
import type { ResolvedWorkflowTask } from "./workflow-planning.js";

export type { VerifiedExecutionContract } from "./verified-execution-schema.js";
export { VerifiedExecutionContractSchema } from "./verified-execution-schema.js";

export interface PreparedVerifiedWorkflow {
	tasks: ResolvedWorkflowTask[];
	targetTaskId: string;
	verifierTaskId: string;
	maxReworkCycles: 0 | 1;
	checks: VerificationCheckRequest[];
}

export function prepareVerifiedWorkflow(
	inputTasks: readonly ResolvedWorkflowTask[],
	contract: VerifiedExecutionContract,
): PreparedVerifiedWorkflow {
	const tasks = inputTasks.map((task) => structuredClone(task));
	const primary = tasks.filter((task) => !task.verifierFor);
	const mutating = primary.filter((task) => sideEffectPolicy(task) === "mutating");
	if (mutating.length < 1) {
		throw new Error("Verified execution requires at least one mutating workflow task");
	}
	if (mutating.length > 2) {
		throw new Error("Verified execution permits at most two mutating workflow tasks");
	}
	const explicitOwners = primary.filter((task) => task.integrationOwner === true);
	if (explicitOwners.length > 1)
		throw new Error("Verified execution requires one integration owner");
	const target = explicitOwners[0] ?? mutating.at(-1);
	if (!target || sideEffectPolicy(target) === "read-only") {
		throw new Error("Verified execution requires a mutating integration owner");
	}
	if (
		mutating.some((task) => task.id !== target.id && !dependsTransitively(target, task.id, primary))
	) {
		throw new Error(
			"Verified execution integration owner must depend on every other mutating task",
		);
	}
	target.integrationOwner = true;
	target.resultFormat = "structured-v2";
	if ((target.writePaths?.length ?? 0) === 0) {
		throw new Error("Verified execution integration owner requires an explicit write scope");
	}
	const verifiers = tasks.filter((task) => task.verifierFor === target.id);
	if (verifiers.length > 1) {
		throw new Error(`Verified execution target ${target.id} has multiple verifiers`);
	}
	let verifier = verifiers[0];
	if (!verifier) {
		verifier = synthesizeVerifier(tasks, target, contract.verifierAgent);
		tasks.push(verifier);
	} else {
		validateExplicitVerifier(verifier, target, contract.verifierAgent);
		verifier = enforceVerifierAuthority(verifier, target);
		const index = tasks.findIndex((task) => task.id === verifier?.id);
		tasks[index] = verifier;
	}
	if (verifier.agent === target.agent) {
		throw new Error("Verified execution requires a distinct verifier agent");
	}
	if (tasks.length > 64) throw new Error("Verified execution exceeded the workflow task limit");
	validateVerificationChecks(contract.checks ?? []);
	return {
		tasks,
		targetTaskId: target.id,
		verifierTaskId: verifier.id,
		maxReworkCycles: contract.maxReworkCycles === 0 ? 0 : 1,
		checks: (contract.checks ?? []).map((check) => ({
			id: check.id,
			command: check.command,
			...(check.args ? { args: [...check.args] } : {}),
			...(check.cwd ? { cwd: check.cwd } : {}),
			...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}),
		})),
	};
}

function synthesizeVerifier(
	tasks: readonly ResolvedWorkflowTask[],
	target: ResolvedWorkflowTask,
	agent: string,
): ResolvedWorkflowTask {
	if (agent === target.agent)
		throw new Error("Verified execution requires a distinct verifier agent");
	let id = `verify-${target.id}`;
	for (let suffix = 2; tasks.some((task) => task.id === id); suffix++) {
		id = `verify-${target.id}-${suffix}`;
	}
	return enforceVerifierAuthority(
		{
			id,
			agent,
			task: `Independently verify ${target.id} against its original objective, acceptance criteria, required evidence, deterministic check receipts, and exact submitted state.`,
			dependsOn: [target.id],
			verifierFor: target.id,
			resultFormat: "structured-v2",
		},
		target,
	);
}

function validateExplicitVerifier(
	verifier: ResolvedWorkflowTask,
	target: ResolvedWorkflowTask,
	configuredAgent: string,
): void {
	if (verifier.agent !== configuredAgent) {
		throw new Error("Verified execution verifier does not match verifierAgent");
	}
	if (verifier.agent === target.agent) {
		throw new Error("Verified execution requires a distinct verifier agent");
	}
	if (verifier.dependsOn?.length !== 1 || verifier.dependsOn[0] !== target.id) {
		throw new Error("Verified execution verifier must depend directly and only on its target");
	}
	if (verifier.resultFormat !== "structured-v2") {
		throw new Error("Verified execution verifier requires structured-v2");
	}
	const delegation = normalizeDelegationContract(verifier.contract);
	if (delegation?.sideEffectPolicy !== "read-only") {
		throw new Error("Verified execution rejects mutable verifier authority");
	}
	const requestedTools = delegation.requestedAuthority?.tools ?? [];
	if (requestedTools.some((tool) => !["read", "grep", "find", "ls"].includes(tool))) {
		throw new Error("Verified execution rejects verifier shell or custom tool authority");
	}
}

function enforceVerifierAuthority(
	verifier: ResolvedWorkflowTask,
	target: ResolvedWorkflowTask,
): ResolvedWorkflowTask {
	return {
		...verifier,
		cwd: target.cwd,
		dependsOn: [target.id],
		verifierFor: target.id,
		integrationOwner: false,
		resultFormat: "structured-v2",
		requiredTools: ["read"],
		writePaths: [],
		readPaths: unique([...(target.readPaths ?? []), ...(target.writePaths ?? [])]),
		contract: {
			version: "pi-subagents:delegation:v2",
			level: "full",
			taskId: verifier.id,
			objective: verifier.task,
			dependencies: [{ taskId: target.id }],
			requiredInputs: [],
			requestedAuthority: {
				tools: ["read"],
			},
			acceptanceCriteria: [...(target.acceptanceCriteria ?? [])],
			requiredEvidence: normalizeDelegationContract(target.contract)?.requiredEvidence ?? [],
			sideEffectPolicy: "read-only",
			enforcement: "enforce",
		},
	};
}

function sideEffectPolicy(task: ResolvedWorkflowTask): "read-only" | "idempotent" | "mutating" {
	return normalizeDelegationContract(task.contract)?.sideEffectPolicy ?? "mutating";
}

function dependsTransitively(
	task: ResolvedWorkflowTask,
	targetId: string,
	tasks: readonly ResolvedWorkflowTask[],
	seen = new Set<string>(),
): boolean {
	if (seen.has(task.id)) return false;
	seen.add(task.id);
	const dependencies = task.dependsOn ?? [];
	if (dependencies.includes(targetId)) return true;
	return dependencies.some((id) => {
		const dependency = tasks.find((candidate) => candidate.id === id);
		return dependency ? dependsTransitively(dependency, targetId, tasks, seen) : false;
	});
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
