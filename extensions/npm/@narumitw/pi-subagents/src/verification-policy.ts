import type { DelegationContract } from "./delegation-contract.js";

export interface VerificationRiskInput {
	contract?: DelegationContract;
	integrationOwner: boolean;
	requiredCapabilities: string[];
}

export interface WorkflowVerificationTaskProjection {
	id: string;
	agent: string;
	dependsOn?: readonly string[];
	verifierFor?: string;
	resultFormat?: string;
}

export function requiresIndependentVerification(input: VerificationRiskInput): boolean {
	return (
		input.contract?.admission?.verificationRequired === true ||
		input.requiredCapabilities.some((capability) =>
			["security-review", "security-implementation", "security-baseline"].includes(capability),
		) ||
		(input.integrationOwner && input.contract?.sideEffectPolicy !== "read-only")
	);
}

export function validateWorkflowVerificationGraph(
	tasks: readonly WorkflowVerificationTaskProjection[],
	requiredTargetIds: ReadonlySet<string>,
): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const verifierByTarget = new Map<string, WorkflowVerificationTaskProjection[]>();
	for (const task of tasks) {
		if (!task.verifierFor) continue;
		const target = byId.get(task.verifierFor);
		if (!target) throw new Error(`Workflow verifier ${task.id} targets a missing task`);
		if (target.verifierFor) {
			throw new Error(`Workflow verifier ${task.id} cannot verify another verifier`);
		}
		if (target.resultFormat !== "structured-v2") {
			throw new Error(`Workflow verification target ${target.id} must request structured-v2`);
		}
		if (task.dependsOn?.length !== 1 || task.dependsOn[0] !== target.id) {
			throw new Error(`Workflow verifier ${task.id} must depend directly and only on ${target.id}`);
		}
		if (task.agent === target.agent) {
			throw new Error(`Workflow verifier ${task.id} must use a distinct agent`);
		}
		if (task.resultFormat !== "structured-v2") {
			throw new Error(`Workflow verifier ${task.id} must request structured-v2`);
		}
		const entries = verifierByTarget.get(target.id) ?? [];
		entries.push(task);
		verifierByTarget.set(target.id, entries);
	}
	for (const targetId of requiredTargetIds) {
		const verifiers = verifierByTarget.get(targetId) ?? [];
		if (verifiers.length !== 1) {
			throw new Error(`Workflow task ${targetId} requires exactly one independent verifier`);
		}
	}
	for (const [targetId, verifiers] of verifierByTarget) {
		if (verifiers.length !== 1) {
			throw new Error(`Workflow task ${targetId} must have exactly one verifier`);
		}
	}
}
