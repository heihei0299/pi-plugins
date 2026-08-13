import type { AgentConfig } from "./agents/types.js";
import { routeByCapability } from "./capability-router.js";
import { normalizeDelegationContract } from "./delegation-contract.js";
import type { SubagentParams } from "./params.js";
import { type WorkItemDefinition, WorkItemLedger } from "./work-item-ledger.js";

export type WorkflowTask = NonNullable<SubagentParams["workflow"]>["tasks"][number];
export type ResolvedWorkflowTask = WorkflowTask & { agent: string };
type Aggregator = NonNullable<SubagentParams["aggregator"]>;

type WorkRequest = {
	contract?: unknown;
	inputArtifacts?: string[];
	inputArtifactVersions?: Record<string, string>;
	requiredCapabilities?: string[];
	requiredTools?: string[];
	agent?: string;
	sideEffectPolicy?: "read-only" | "idempotent" | "mutating";
	readPaths?: string[];
	writePaths?: string[];
	ownershipKeys?: string[];
	acceptanceCriteria?: string[];
	requiredEvidence?: string[];
	integrationOwner?: boolean;
	verifierFor?: string;
	dependencyPolicy?: "completed" | "settled";
	acceptanceRequired?: boolean;
	maxReworkCycles?: 0 | 1;
};

export function resolveWorkflowTasks(
	params: SubagentParams,
	agents: readonly AgentConfig[],
): ResolvedWorkflowTask[] {
	return (params.workflow?.tasks ?? []).map((task) => {
		const contract = normalizeDelegationContract(task.contract);
		const route = routeByCapability(agents, {
			agent: task.agent,
			requiredCapabilities: [
				...(task.requiredCapabilities ?? []),
				...(contract?.requestedAuthority?.capabilities ?? []),
			],
			requiredTools: [
				...(task.requiredTools ?? []),
				...(contract?.requestedAuthority?.tools ?? []),
			],
			requiredVerificationRole: task.requiredVerificationRole,
			requiredSideEffectClass: contract?.sideEffectPolicy === "read-only" ? "read-only" : undefined,
			preferredCostHint: task.preferredCostHint,
			preferredLatencyHint: task.preferredLatencyHint,
		});
		return { ...task, agent: route.agent.name };
	});
}

export function createBlockingWorkLedger(
	params: SubagentParams,
	resolvedWorkflowTasks: ResolvedWorkflowTask[],
	aggregator: Aggregator | undefined,
	verifiedTarget?: { id: string; maxReworkCycles: 0 | 1 },
): WorkItemLedger | undefined {
	if (params.agent && params.task) {
		return WorkItemLedger.create({
			workflowId: "blocking-single",
			items: [definition("task-1", params.task, [], params)],
		});
	}
	if (params.chain?.length) {
		return WorkItemLedger.create({
			workflowId: "blocking-chain",
			items: params.chain.map((step, index) =>
				definition(`step-${index + 1}`, step.task, index === 0 ? [] : [`step-${index}`], step),
			),
		});
	}
	if (params.tasks?.length) {
		const items = params.tasks.map((task, index) =>
			definition(`task-${index + 1}`, task.task, [], task),
		);
		if (aggregator) {
			items.push(
				definition(
					"aggregator",
					aggregator.task,
					params.tasks.map((_task, index) => `task-${index + 1}`),
					{ ...aggregator, dependencyPolicy: "settled" },
				),
			);
		}
		return WorkItemLedger.create({ workflowId: "blocking-parallel", items });
	}
	if (params.workflow && resolvedWorkflowTasks.length > 0) {
		const hasExplicitIntegrationOwner = resolvedWorkflowTasks.some(
			(task) => task.integrationOwner === true,
		);
		let defaultIntegrationOwnerIndex = -1;
		if (!hasExplicitIntegrationOwner) {
			for (let index = resolvedWorkflowTasks.length - 1; index >= 0; index--) {
				if (resolvedWorkflowTasks[index]?.verifierFor === undefined) {
					defaultIntegrationOwnerIndex = index;
					break;
				}
			}
		}
		if (!hasExplicitIntegrationOwner && defaultIntegrationOwnerIndex < 0) {
			throw new Error("Workflow has no non-verifier integration owner candidate");
		}
		return WorkItemLedger.create({
			workflowId: params.workflow.id ?? "blocking-workflow",
			items: resolvedWorkflowTasks.map((task, index) =>
				definition(task.id, task.task, task.dependsOn ?? [], {
					...task,
					integrationOwner:
						task.integrationOwner ??
						(!hasExplicitIntegrationOwner && index === defaultIntegrationOwnerIndex),
					...(verifiedTarget?.id === task.id
						? { acceptanceRequired: true, maxReworkCycles: verifiedTarget.maxReworkCycles }
						: {}),
				}),
			),
		});
	}
	return undefined;
}

function definition(
	id: string,
	task: string,
	dependencies: string[],
	request: WorkRequest,
): WorkItemDefinition {
	const contract = normalizeDelegationContract(request.contract);
	return {
		id,
		objective: contract?.objective ?? task,
		dependencies,
		inputArtifacts: [
			...(request.inputArtifacts ?? contract?.requiredInputs ?? []),
			...(contract?.dependencies
				.filter((dependency) => dependency.artifactId)
				.map((dependency) => dependency.artifactId as string) ?? []),
		],
		inputArtifactVersions: {
			...Object.fromEntries(
				(contract?.dependencies ?? [])
					.filter((dependency) => dependency.artifactId && dependency.version)
					.map((dependency) => [dependency.artifactId as string, dependency.version as string]),
			),
			...(request.inputArtifactVersions ?? {}),
		},
		requiredCapabilities: [
			...(request.requiredCapabilities ?? []),
			...(contract?.requestedAuthority?.capabilities ?? []),
		],
		requiredTools: [
			...(request.requiredTools ?? []),
			...(contract?.requestedAuthority?.tools ?? []),
		],
		selectedAgentName: request.agent,
		sideEffectPolicy: contract?.sideEffectPolicy ?? request.sideEffectPolicy ?? "mutating",
		readPaths: request.readPaths ?? contract?.requestedAuthority?.readPaths ?? [],
		writePaths: request.writePaths ?? contract?.requestedAuthority?.writePaths ?? [],
		ownershipKeys: request.ownershipKeys ?? [],
		acceptanceCriteria: request.acceptanceCriteria ?? contract?.acceptanceCriteria ?? [],
		requiredEvidence: request.requiredEvidence ?? contract?.requiredEvidence ?? [],
		integrationOwner: request.integrationOwner,
		verifierFor: request.verifierFor,
		dependencyPolicy: request.dependencyPolicy,
		acceptanceRequired: request.acceptanceRequired,
		maxReworkCycles: request.maxReworkCycles,
	};
}
