/**
 * Ledger transitions and restore validators stay together so every persisted acceptance invariant
 * is audited against the same atomic state machine rather than duplicated across modules.
 */
import {
	type ManagedIntegrationCandidate,
	type ManagedIntegrationExpectation,
	verifyManagedIntegration,
} from "./integration-controller.js";
import type { VerificationSubmission } from "./verification-harness.js";
import { isVerificationReceipt, type VerificationReceipt } from "./verification-receipt.js";
import {
	isWorkflowTreeIdentity,
	sameWorkflowTreeIdentity,
	type WorkflowTreeIdentity,
} from "./workflow-tree-identity.js";
import {
	isWorkflowVerificationReceipt,
	type WorkflowVerificationReceipt,
} from "./workflow-verification.js";

export const WORK_ITEM_LEDGER_VERSION = "pi-subagents:work-ledger:v3" as const;
const LEGACY_WORK_ITEM_LEDGER_VERSIONS = new Set([
	"pi-subagents:work-ledger:v1",
	"pi-subagents:work-ledger:v2",
]);
export const WORK_ITEM_ACCEPTANCE_VERSION = "pi-subagents:work-acceptance:v1" as const;
export type WorkItemAcceptanceState =
	| "not-required"
	| "pending"
	| "accepted"
	| "rework-requested"
	| "rejected";

export type WorkItemState =
	| "pending"
	| "ready"
	| "running"
	| "awaiting-verification"
	| "blocked"
	| "needs-input"
	| "completed"
	| "failed"
	| "interrupted"
	| "stale"
	| "invalidated";

export interface WorkArtifactReference {
	id: string;
	kind: string;
	version: string;
	digest?: string;
	producerTaskId?: string;
	generation?: number;
	verified?: boolean;
}

export interface WorkItemDefinition {
	id: string;
	objective: string;
	dependencies: string[];
	inputArtifacts?: string[];
	inputArtifactVersions?: Record<string, string>;
	requiredCapabilities?: string[];
	requiredTools?: string[];
	selectedAgentName?: string;
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
}

export interface WorkItemRecord {
	id: string;
	objective: string;
	dependencies: string[];
	dependents: string[];
	state: WorkItemState;
	generation: number;
	taskGeneration: number;
	assignedAgentId?: string;
	acceptedExecutionPlanId?: string;
	inputArtifacts: string[];
	inputArtifactVersions: Record<string, string>;
	requiredArtifactVersions: Record<string, string>;
	requiredCapabilities: string[];
	requiredTools: string[];
	selectedAgentName?: string;
	sideEffectPolicy: "read-only" | "idempotent" | "mutating";
	artifacts: WorkArtifactReference[];
	artifactHistory: WorkArtifactReference[];
	readPaths: string[];
	writePaths: string[];
	ownershipKeys: string[];
	acceptanceCriteria: string[];
	requiredEvidence: string[];
	integrationOwner: boolean;
	verifierFor?: string;
	dependencyPolicy: "completed" | "settled";
	acceptanceStateVersion: typeof WORK_ITEM_ACCEPTANCE_VERSION;
	acceptanceRequired: boolean;
	acceptanceState: WorkItemAcceptanceState;
	reworkCount: number;
	maxReworkCycles: 0 | 1;
	verificationAccepted: boolean;
	stagedTreeIdentity?: WorkflowTreeIdentity;
	verificationReceipt?: WorkflowVerificationReceipt;
	acceptanceReceipt?: VerificationReceipt;
	acceptanceReceiptHistory: VerificationReceipt[];
	submission?: VerificationSubmission;
	invalidationReasons: string[];
	outcomeReason?: string;
}

export interface WorkItemLedgerSnapshot {
	version: typeof WORK_ITEM_LEDGER_VERSION;
	workflowId: string;
	generation: number;
	items: WorkItemRecord[];
}

export interface CreateWorkItemLedgerInput {
	workflowId: string;
	items: WorkItemDefinition[];
}

export interface CompleteWorkItemInput {
	taskGeneration: number;
	executionPlanId?: string;
	artifacts?: Array<Omit<WorkArtifactReference, "producerTaskId" | "generation">>;
}

export interface StageWorkItemVerificationInput extends CompleteWorkItemInput {
	executionPlanId: string;
	treeIdentity: WorkflowTreeIdentity;
}

export interface StageVerifiedAcceptanceInput
	extends CompleteWorkItemInput,
		VerificationSubmission {
	executionPlanId: string;
}

export interface CompleteWorkItemVerificationInput {
	taskGeneration: number;
	executionPlanId: string;
	receipt: WorkflowVerificationReceipt;
}

export interface RecordVerificationDecisionInput {
	taskGeneration: number;
	executionPlanId: string;
	receipt: VerificationReceipt;
}

export interface VerifiedIntegrationInput {
	verifierId: string;
	verifierTaskGeneration: number;
	verifierExecutionPlanId: string;
	receipt: VerificationReceipt;
}

const MAX_ITEMS = 64;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_LIST_ITEMS = 50;

const TERMINAL_STATES = new Set<WorkItemState>([
	"completed",
	"failed",
	"interrupted",
	"stale",
	"invalidated",
]);

export class WorkItemLedger {
	private readonly items = new Map<string, WorkItemRecord>();
	private generation = 0;

	private constructor(readonly workflowId: string) {}

	static create(input: CreateWorkItemLedgerInput): WorkItemLedger {
		validateIdentifier(input.workflowId, "workflowId");
		if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) {
			throw new Error(`WorkItem workflow must contain 1-${MAX_ITEMS} items`);
		}
		const ledger = new WorkItemLedger(input.workflowId);
		for (const definition of input.items) ledger.addDefinition(definition);
		ledger.linkAndValidate();
		ledger.refreshReadyState();
		return ledger;
	}

	get(id: string): WorkItemRecord | undefined {
		const item = this.items.get(id);
		return item ? structuredClone(item) : undefined;
	}

	readyItems(): WorkItemRecord[] {
		this.refreshReadyState();
		return [...this.items.values()]
			.filter((item) => item.state === "ready")
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((item) => structuredClone(item));
	}

	start(id: string, agentId: string): WorkItemRecord {
		const item = this.require(id);
		if (item.state !== "ready") {
			throw new Error(`WorkItem ${id} cannot start while ${item.state}`);
		}
		validateIdentifier(agentId, "agentId");
		item.state = "running";
		item.assignedAgentId = agentId;
		item.generation = ++this.generation;
		return structuredClone(item);
	}

	complete(id: string, input: CompleteWorkItemInput): WorkItemRecord {
		const item = this.require(id);
		this.assertMutable(item);
		if (item.acceptanceRequired) {
			throw new Error(`WorkItem ${id} requires executor-owned acceptance staging`);
		}
		if (item.state !== "running") {
			throw new Error(`WorkItem ${id} cannot complete while ${item.state}`);
		}
		if (input.taskGeneration !== item.taskGeneration) {
			throw new Error(`WorkItem ${id} rejected a stale task generation`);
		}
		item.acceptedExecutionPlanId = input.executionPlanId?.slice(0, 256);
		item.artifactHistory.push(...item.artifacts.map((artifact) => structuredClone(artifact)));
		item.artifacts = normalizeArtifacts(input.artifacts ?? [], id, this.generation + 1);
		item.verificationAccepted = false;
		item.stagedTreeIdentity = undefined;
		item.verificationReceipt = undefined;
		item.acceptanceState = "not-required";
		item.state = "completed";
		item.generation = ++this.generation;
		this.refreshReadyState();
		return structuredClone(item);
	}

	stageForVerifiedAcceptance(id: string, input: StageVerifiedAcceptanceInput): WorkItemRecord {
		const item = this.require(id);
		this.assertMutable(item);
		if (!item.acceptanceRequired || !item.integrationOwner) {
			throw new Error(`WorkItem ${id} is not a verified integration target`);
		}
		if (item.state !== "running") {
			throw new Error(`WorkItem ${id} cannot stage acceptance while ${item.state}`);
		}
		if (input.taskGeneration !== item.taskGeneration) {
			throw new Error(`WorkItem ${id} rejected a stale task generation`);
		}
		validatePlanId(input.executionPlanId, "staged execution plan");
		validateSubmission(input);
		item.acceptedExecutionPlanId = input.executionPlanId;
		item.artifactHistory.push(...item.artifacts.map((artifact) => structuredClone(artifact)));
		item.artifacts = normalizeArtifacts(input.artifacts ?? [], id, this.generation + 1);
		item.verificationAccepted = false;
		item.acceptanceState = "pending";
		item.stagedTreeIdentity = structuredClone(input.treeIdentity);
		item.submission = {
			treeIdentity: structuredClone(input.treeIdentity),
			baseRepositoryGeneration: input.baseRepositoryGeneration,
			patchDigest: input.patchDigest,
			changedPaths: [...input.changedPaths],
			fileVersions: { ...input.fileVersions },
		};
		item.acceptanceReceipt = undefined;
		item.state = "completed";
		item.generation = ++this.generation;
		this.refreshReadyState();
		return structuredClone(item);
	}

	stageForVerification(id: string, input: StageWorkItemVerificationInput): WorkItemRecord {
		const item = this.require(id);
		this.assertMutable(item);
		if (item.state !== "running") {
			throw new Error(`WorkItem ${id} cannot stage verification while ${item.state}`);
		}
		if (input.taskGeneration !== item.taskGeneration) {
			throw new Error(`WorkItem ${id} rejected a stale task generation`);
		}
		validatePlanId(input.executionPlanId, "staged execution plan");
		if (!isWorkflowTreeIdentity(input.treeIdentity)) {
			throw new Error(`WorkItem ${id} received an invalid staged tree identity`);
		}
		item.acceptedExecutionPlanId = input.executionPlanId;
		item.artifactHistory.push(...item.artifacts.map((artifact) => structuredClone(artifact)));
		item.artifacts = normalizeArtifacts(input.artifacts ?? [], id, this.generation + 1);
		item.verificationAccepted = false;
		item.stagedTreeIdentity = structuredClone(input.treeIdentity);
		item.verificationReceipt = undefined;
		item.state = "awaiting-verification";
		item.generation = ++this.generation;
		this.refreshReadyState();
		return structuredClone(item);
	}

	completeVerification(
		verifierId: string,
		input: CompleteWorkItemVerificationInput,
	): { target: WorkItemRecord; verifier: WorkItemRecord } {
		const verifier = this.require(verifierId);
		this.assertMutable(verifier);
		if (verifier.state !== "running" || !verifier.verifierFor) {
			throw new Error(`WorkItem ${verifierId} is not a running verifier`);
		}
		if (input.taskGeneration !== verifier.taskGeneration) {
			throw new Error(`WorkItem ${verifierId} rejected a stale verifier generation`);
		}
		validatePlanId(input.executionPlanId, "verifier execution plan");
		if (!isWorkflowVerificationReceipt(input.receipt)) {
			throw new Error(`WorkItem ${verifierId} received an invalid verification receipt`);
		}
		const target = this.require(verifier.verifierFor);
		if (target.state !== "awaiting-verification") {
			throw new Error(`WorkItem ${target.id} is not awaiting verification`);
		}
		assertReceiptMatches(target, verifier, input.executionPlanId, input.receipt);
		verifier.acceptedExecutionPlanId = input.executionPlanId;
		verifier.verificationReceipt = undefined;
		verifier.verificationAccepted = false;
		verifier.state = "completed";
		verifier.generation = ++this.generation;
		target.verificationReceipt = structuredClone(input.receipt);
		target.verificationAccepted = input.receipt.decision === "accept";
		target.outcomeReason =
			input.receipt.decision === "accept"
				? undefined
				: input.receipt.decision === "rework"
					? "verification-rework"
					: "verification-rejected";
		if (input.receipt.decision === "accept") {
			target.artifacts = target.artifacts.map((artifact) => ({ ...artifact, verified: true }));
			target.state = "completed";
		} else {
			target.state = input.receipt.decision === "rework" ? "blocked" : "failed";
			this.invalidateDependents(target.id, verifier.id, target.outcomeReason);
		}
		target.generation = ++this.generation;
		this.refreshReadyState();
		return { target: structuredClone(target), verifier: structuredClone(verifier) };
	}

	recordVerificationDecision(
		verifierId: string,
		input: RecordVerificationDecisionInput,
	): { target: WorkItemRecord; verifier: WorkItemRecord } {
		const verifier = this.require(verifierId);
		if (verifier.state !== "running" || !verifier.verifierFor) {
			throw new Error(`WorkItem ${verifierId} is not a running verifier`);
		}
		if (input.taskGeneration !== verifier.taskGeneration) {
			throw new Error(`WorkItem ${verifierId} rejected a stale verifier generation`);
		}
		validatePlanId(input.executionPlanId, "verifier execution plan");
		if (!isVerificationReceipt(input.receipt) || input.receipt.decision === "accept") {
			throw new Error(`WorkItem ${verifierId} received an invalid non-acceptance receipt`);
		}
		const target = this.require(verifier.verifierFor);
		assertVerifiedReceiptMatches(target, verifier, input.executionPlanId, input.receipt);
		verifier.acceptedExecutionPlanId = input.executionPlanId;
		verifier.state = "completed";
		verifier.generation = ++this.generation;
		target.acceptanceReceipt = structuredClone(input.receipt);
		target.acceptanceReceiptHistory.push(structuredClone(input.receipt));
		target.verificationAccepted = false;
		if (input.receipt.decision === "rework" && target.reworkCount < target.maxReworkCycles) {
			target.reworkCount++;
			target.acceptanceState = "rework-requested";
			target.state = "blocked";
			target.outcomeReason = "verification-rework";
		} else {
			target.acceptanceState = "rejected";
			target.state = "failed";
			target.outcomeReason =
				input.receipt.decision === "rework"
					? "verification-rework-exhausted"
					: "verification-rejected";
		}
		target.generation = ++this.generation;
		this.invalidateDependents(target.id, verifier.id, target.outcomeReason);
		this.refreshReadyState();
		return { target: structuredClone(target), verifier: structuredClone(verifier) };
	}

	beginVerificationRework(id: string): WorkItemRecord {
		const target = this.require(id);
		if (target.acceptanceState !== "rework-requested" || target.state !== "blocked") {
			throw new Error(`WorkItem ${id} has no accepted rework request`);
		}
		const verifier = [...this.items.values()].find((item) => item.verifierFor === id);
		if (verifier?.state !== "completed") {
			throw new Error(`WorkItem ${id} has no completed verifier for rework`);
		}
		target.artifactHistory.push(...target.artifacts.map((artifact) => structuredClone(artifact)));
		target.artifacts = [];
		target.state = "pending";
		target.acceptanceState = "pending";
		target.taskGeneration++;
		target.assignedAgentId = undefined;
		target.acceptedExecutionPlanId = undefined;
		target.stagedTreeIdentity = undefined;
		target.submission = undefined;
		target.verificationAccepted = false;
		target.outcomeReason = undefined;
		target.generation = ++this.generation;
		verifier.state = "pending";
		verifier.taskGeneration++;
		verifier.assignedAgentId = undefined;
		verifier.acceptedExecutionPlanId = undefined;
		verifier.outcomeReason = undefined;
		verifier.generation = ++this.generation;
		this.resetReworkDependents(target.id, verifier.id);
		this.refreshReadyState();
		return structuredClone(target);
	}

	failVerification(verifierId: string, reason: string): WorkItemRecord[] {
		const verifier = this.require(verifierId);
		if (!verifier.verifierFor) throw new Error(`WorkItem ${verifierId} is not a verifier`);
		const target = this.require(verifier.verifierFor);
		const boundedReason = bounded(reason, MAX_TEXT_LENGTH);
		if (!boundedReason) throw new Error("Verification failure requires a reason");
		if (!TERMINAL_STATES.has(verifier.state)) {
			verifier.state = "failed";
			verifier.outcomeReason = boundedReason;
			verifier.generation = ++this.generation;
		}
		if (
			target.state === "awaiting-verification" ||
			(target.state === "completed" && target.acceptanceState === "pending")
		) {
			target.state = "failed";
			if (target.acceptanceRequired) target.acceptanceState = "rejected";
			target.verificationAccepted = false;
			target.outcomeReason = boundedReason;
			target.generation = ++this.generation;
		}
		const invalidated = this.invalidateDependents(target.id, verifier.id, boundedReason);
		return [structuredClone(target), structuredClone(verifier), ...invalidated];
	}

	settle(
		id: string,
		state: "blocked" | "needs-input" | "failed" | "interrupted",
		reason?: string,
	): WorkItemRecord {
		const item = this.require(id);
		this.assertMutable(item);
		if (
			item.state !== "running" &&
			item.state !== "awaiting-verification" &&
			!(item.state === "completed" && item.acceptanceState === "pending") &&
			item.state !== "ready" &&
			item.state !== "pending"
		) {
			throw new Error(`WorkItem ${id} cannot settle while ${item.state}`);
		}
		item.state = state;
		if (item.acceptanceRequired) item.acceptanceState = "rejected";
		item.outcomeReason = reason ? bounded(reason, MAX_TEXT_LENGTH) : undefined;
		item.generation = ++this.generation;
		this.refreshReadyState();
		return structuredClone(item);
	}

	acceptIntegration(
		id: string,
		expected: ManagedIntegrationExpectation,
		candidate: ManagedIntegrationCandidate,
		verified?: VerifiedIntegrationInput,
	): WorkItemRecord {
		const item = this.require(id);
		if (!item.integrationOwner) {
			throw new Error(`WorkItem ${id} is not the integration owner`);
		}
		if (expected.taskId !== id || expected.taskGeneration !== item.taskGeneration) {
			throw new Error(`WorkItem ${id} integration expectation has a stale generation`);
		}
		if (!verified) {
			if (item.state !== "running" || item.acceptanceRequired) {
				throw new Error(`WorkItem ${id} cannot integrate while ${item.state}`);
			}
			verifyManagedIntegration(expected, candidate);
			item.verificationAccepted = true;
			item.generation = ++this.generation;
			return structuredClone(item);
		}
		if (item.state !== "completed" || item.acceptanceState !== "pending") {
			throw new Error(`WorkItem ${id} is not pending verified acceptance`);
		}
		const verifier = this.require(verified.verifierId);
		if (
			verifier.state !== "running" ||
			verifier.verifierFor !== id ||
			verified.verifierTaskGeneration !== verifier.taskGeneration
		) {
			throw new Error(`WorkItem ${verified.verifierId} is not the current verifier`);
		}
		if (!isVerificationReceipt(verified.receipt) || verified.receipt.decision !== "accept") {
			throw new Error("Managed integration requires an accepting verification receipt");
		}
		assertVerifiedReceiptMatches(
			item,
			verifier,
			verified.verifierExecutionPlanId,
			verified.receipt,
		);
		verifyManagedIntegration(expected, candidate);
		item.verificationAccepted = true;
		item.acceptanceState = "accepted";
		item.acceptanceReceipt = structuredClone(verified.receipt);
		item.acceptanceReceiptHistory.push(structuredClone(verified.receipt));
		item.artifacts = item.artifacts.map((artifact) => ({ ...artifact, verified: true }));
		item.outcomeReason = undefined;
		item.generation = ++this.generation;
		verifier.acceptedExecutionPlanId = verified.verifierExecutionPlanId;
		verifier.state = "completed";
		verifier.generation = ++this.generation;
		this.refreshReadyState();
		return structuredClone(item);
	}

	rerun(id: string): WorkItemRecord {
		const item = this.require(id);
		if (item.acceptanceState === "accepted") {
			throw new Error(`WorkItem ${id} has terminal accepted evidence`);
		}
		if (
			!["blocked", "needs-input", "failed", "interrupted", "stale", "invalidated"].includes(
				item.state,
			)
		) {
			throw new Error(`WorkItem ${id} cannot rerun while ${item.state}`);
		}
		item.state = "pending";
		item.taskGeneration++;
		item.assignedAgentId = undefined;
		item.acceptedExecutionPlanId = undefined;
		item.outcomeReason = undefined;
		item.verificationAccepted = false;
		item.acceptanceState = item.acceptanceRequired ? "pending" : "not-required";
		item.stagedTreeIdentity = undefined;
		item.submission = undefined;
		item.verificationReceipt = undefined;
		item.acceptanceReceipt = undefined;
		item.generation = ++this.generation;
		this.refreshReadyState();
		return structuredClone(item);
	}

	invalidate(id: string, reason: string): WorkItemRecord[] {
		const root = this.require(id);
		const normalizedReason = bounded(reason, MAX_TEXT_LENGTH);
		if (!normalizedReason) throw new Error("WorkItem invalidation requires a reason");
		const ordered: WorkItemRecord[] = [];
		const queue = [root.id];
		const seen = new Set<string>();
		while (queue.length > 0) {
			const currentId = queue.shift();
			if (!currentId || seen.has(currentId)) continue;
			seen.add(currentId);
			const item = this.require(currentId);
			if (item.acceptanceState === "accepted") {
				throw new Error(`WorkItem ${item.id} has terminal accepted evidence`);
			}
			ordered.push(item);
			queue.push(...item.dependents);
		}
		return ordered.map((item) => {
			item.state = item.id === root.id ? "stale" : "invalidated";
			if (item.acceptanceRequired) item.acceptanceState = "rejected";
			item.taskGeneration++;
			item.invalidationReasons.push(`${root.id}:${normalizedReason}`);
			item.generation = ++this.generation;
			return structuredClone(item);
		});
	}

	snapshot(): WorkItemLedgerSnapshot {
		return {
			version: WORK_ITEM_LEDGER_VERSION,
			workflowId: this.workflowId,
			generation: this.generation,
			items: [...this.items.values()]
				.sort((left, right) => left.id.localeCompare(right.id))
				.map((item) => structuredClone(item)),
		};
	}

	static restore(snapshot: WorkItemLedgerSnapshot): WorkItemLedger {
		const storedVersion = (snapshot as { version?: unknown } | undefined)?.version;
		if (
			!snapshot ||
			(storedVersion !== WORK_ITEM_LEDGER_VERSION &&
				!LEGACY_WORK_ITEM_LEDGER_VERSIONS.has(String(storedVersion))) ||
			!Number.isSafeInteger(snapshot.generation) ||
			snapshot.generation < 0
		) {
			throw new Error("Unsupported or malformed WorkItem ledger snapshot");
		}
		const isLegacySnapshot = storedVersion !== WORK_ITEM_LEDGER_VERSION;
		const isV1Snapshot = storedVersion === "pi-subagents:work-ledger:v1";
		if (
			!Array.isArray(snapshot.items) ||
			snapshot.items.length < 1 ||
			snapshot.items.length > MAX_ITEMS
		) {
			throw new Error("Malformed WorkItem ledger items");
		}
		const storedItems = snapshot.items.map((item) =>
			isLegacySnapshot ? normalizeLegacyAcceptance(item, isV1Snapshot) : item,
		);
		for (const item of storedItems) validateStoredRecord(item, snapshot.generation);
		const ledger = WorkItemLedger.create({
			workflowId: snapshot.workflowId,
			items: storedItems.map((item) => ({
				id: item.id,
				objective: item.objective,
				dependencies: item.dependencies,
				inputArtifacts: item.inputArtifacts,
				inputArtifactVersions: item.requiredArtifactVersions,
				requiredCapabilities: item.requiredCapabilities,
				requiredTools: item.requiredTools,
				selectedAgentName: item.selectedAgentName,
				sideEffectPolicy: item.sideEffectPolicy,
				readPaths: item.readPaths,
				writePaths: item.writePaths,
				ownershipKeys: item.ownershipKeys,
				acceptanceCriteria: item.acceptanceCriteria,
				requiredEvidence: item.requiredEvidence,
				integrationOwner: item.integrationOwner,
				verifierFor: item.verifierFor,
				dependencyPolicy: item.dependencyPolicy,
				acceptanceRequired: item.acceptanceRequired,
				maxReworkCycles: item.maxReworkCycles,
			})),
		});
		ledger.generation = snapshot.generation;
		for (const stored of storedItems) {
			const item = ledger.require(stored.id);
			const interruptedAcceptance =
				stored.acceptanceRequired &&
				stored.state === "completed" &&
				stored.acceptanceState === "pending";
			item.state =
				stored.state === "running" ||
				stored.state === "awaiting-verification" ||
				interruptedAcceptance
					? "interrupted"
					: stored.state;
			item.generation = stored.generation;
			item.taskGeneration = stored.taskGeneration ?? 1;
			item.assignedAgentId = stored.assignedAgentId;
			item.acceptedExecutionPlanId = stored.acceptedExecutionPlanId;
			item.inputArtifactVersions = { ...stored.inputArtifactVersions };
			item.artifacts = normalizeStoredArtifacts(
				stored.artifacts,
				stored.id,
				stored.generation,
				!isV1Snapshot,
			);
			item.artifactHistory = normalizeStoredArtifacts(
				stored.artifactHistory ?? [],
				stored.id,
				stored.generation,
				!isV1Snapshot,
			);
			item.acceptanceStateVersion = WORK_ITEM_ACCEPTANCE_VERSION;
			item.acceptanceRequired = stored.acceptanceRequired;
			item.acceptanceState = interruptedAcceptance ? "rejected" : stored.acceptanceState;
			item.reworkCount = stored.reworkCount;
			item.maxReworkCycles = stored.maxReworkCycles;
			item.verificationAccepted = isV1Snapshot ? false : stored.verificationAccepted;
			item.stagedTreeIdentity = stored.stagedTreeIdentity
				? structuredClone(stored.stagedTreeIdentity)
				: undefined;
			item.verificationReceipt =
				!isV1Snapshot && stored.verificationReceipt
					? structuredClone(stored.verificationReceipt)
					: undefined;
			item.acceptanceReceipt = stored.acceptanceReceipt
				? structuredClone(stored.acceptanceReceipt)
				: undefined;
			item.acceptanceReceiptHistory = stored.acceptanceReceiptHistory.map((receipt) =>
				structuredClone(receipt),
			);
			item.submission = stored.submission ? structuredClone(stored.submission) : undefined;
			item.invalidationReasons = [...stored.invalidationReasons];
			item.outcomeReason = interruptedAcceptance
				? "verification-interrupted"
				: stored.outcomeReason;
		}
		ledger.validateRestoredVerificationLinks();
		return ledger;
	}

	private validateRestoredVerificationLinks(): void {
		for (const target of this.items.values()) {
			const receipt = target.verificationReceipt;
			if (receipt) {
				const verifier = this.items.get(receipt.verifierTaskId);
				if (
					!verifier ||
					verifier.verifierFor !== target.id ||
					verifier.state !== "completed" ||
					verifier.taskGeneration !== receipt.verifierTaskGeneration ||
					verifier.acceptedExecutionPlanId !== receipt.verifierExecutionPlanId
				) {
					throw new Error(`Malformed stored WorkItem verification link for ${target.id}`);
				}
			}
			const acceptanceReceipt = target.acceptanceReceipt;
			if (!acceptanceReceipt || target.acceptanceState === "pending") continue;
			const verifier = this.items.get(acceptanceReceipt.verifierTaskId);
			if (
				!verifier ||
				verifier.verifierFor !== target.id ||
				verifier.state !== "completed" ||
				verifier.taskGeneration !== acceptanceReceipt.verifierTaskGeneration ||
				verifier.acceptedExecutionPlanId !== acceptanceReceipt.verifierExecutionPlanId ||
				acceptanceReceipt.targetTaskId !== target.id ||
				acceptanceReceipt.targetTaskGeneration !== target.taskGeneration ||
				acceptanceReceipt.targetExecutionPlanId !== target.acceptedExecutionPlanId
			) {
				throw new Error(`Malformed stored WorkItem acceptance link for ${target.id}`);
			}
		}
	}

	private addDefinition(definition: WorkItemDefinition): void {
		validateIdentifier(definition.id, "WorkItem id");
		if (this.items.has(definition.id)) throw new Error(`Duplicate WorkItem id ${definition.id}`);
		const objective = bounded(definition.objective, MAX_TEXT_LENGTH);
		if (!objective) throw new Error(`WorkItem ${definition.id} requires an objective`);
		this.items.set(definition.id, {
			id: definition.id,
			objective,
			dependencies: uniqueBounded(definition.dependencies, "dependency"),
			dependents: [],
			state: "pending",
			generation: 0,
			taskGeneration: 1,
			acceptedExecutionPlanId: undefined,
			inputArtifacts: uniqueBounded(definition.inputArtifacts ?? [], "input artifact"),
			inputArtifactVersions: {},
			requiredArtifactVersions: normalizeVersionMap(definition.inputArtifactVersions),
			requiredCapabilities: uniqueBounded(
				definition.requiredCapabilities ?? [],
				"required capability",
			),
			requiredTools: uniqueBounded(definition.requiredTools ?? [], "required tool"),
			selectedAgentName: definition.selectedAgentName,
			sideEffectPolicy: definition.sideEffectPolicy ?? "mutating",
			artifacts: [],
			artifactHistory: [],
			readPaths: uniqueBounded(definition.readPaths ?? [], "read path"),
			writePaths: uniqueBounded(definition.writePaths ?? [], "write path"),
			ownershipKeys: uniqueBounded(definition.ownershipKeys ?? [], "ownership key"),
			acceptanceCriteria: uniqueBounded(
				definition.acceptanceCriteria ?? [],
				"acceptance criterion",
			),
			requiredEvidence: uniqueBounded(definition.requiredEvidence ?? [], "required evidence"),
			integrationOwner: definition.integrationOwner === true,
			verifierFor: definition.verifierFor,
			dependencyPolicy: definition.dependencyPolicy ?? "completed",
			acceptanceStateVersion: WORK_ITEM_ACCEPTANCE_VERSION,
			acceptanceRequired: definition.acceptanceRequired === true,
			acceptanceState: definition.acceptanceRequired === true ? "pending" : "not-required",
			reworkCount: 0,
			maxReworkCycles: definition.maxReworkCycles === 0 ? 0 : 1,
			verificationAccepted: false,
			stagedTreeIdentity: undefined,
			verificationReceipt: undefined,
			acceptanceReceipt: undefined,
			acceptanceReceiptHistory: [],
			submission: undefined,
			invalidationReasons: [],
			outcomeReason: undefined,
		});
	}

	private linkAndValidate(): void {
		const integrationOwners = [...this.items.values()].filter((item) => item.integrationOwner);
		if (integrationOwners.length > 1)
			throw new Error("Workflow can have only one integration owner");
		for (const item of this.items.values()) {
			if (item.acceptanceRequired && !item.integrationOwner) {
				throw new Error(`WorkItem ${item.id} requires acceptance but is not integration owner`);
			}
			for (const dependency of item.dependencies) {
				if (dependency === item.id) throw new Error(`WorkItem ${item.id} has a self cycle`);
				const parent = this.items.get(dependency);
				if (!parent) throw new Error(`WorkItem ${item.id} has missing dependency ${dependency}`);
				parent.dependents.push(item.id);
			}
			if (item.verifierFor && !this.items.has(item.verifierFor)) {
				throw new Error(`WorkItem ${item.id} verifies missing WorkItem ${item.verifierFor}`);
			}
			if (item.verifierFor && !item.dependencies.includes(item.verifierFor)) {
				throw new Error(
					`WorkItem ${item.id} must depend on the WorkItem it verifies (${item.verifierFor})`,
				);
			}
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string) => {
			if (visiting.has(id)) throw new Error(`WorkItem dependency cycle includes ${id}`);
			if (visited.has(id)) return;
			visiting.add(id);
			for (const dependency of this.require(id).dependencies) visit(dependency);
			visiting.delete(id);
			visited.add(id);
		};
		for (const id of this.items.keys()) visit(id);
	}

	private refreshReadyState(): void {
		for (const item of this.items.values()) {
			if (item.state !== "pending") continue;
			const dependencies = item.dependencies.map((id) => this.require(id));
			const acceptedDependency = (dependency: WorkItemRecord) =>
				dependency.state === "completed" &&
				(!dependency.acceptanceRequired || dependency.acceptanceState === "accepted");
			const dependenciesReady = item.verifierFor
				? dependencies.every((dependency) =>
						dependency.id === item.verifierFor
							? dependency.acceptanceRequired
								? dependency.state === "completed" && dependency.acceptanceState === "pending"
								: dependency.state === "awaiting-verification"
							: acceptedDependency(dependency),
					)
				: item.dependencyPolicy === "settled"
					? dependencies.every(
							(dependency) =>
								(!dependency.acceptanceRequired || dependency.acceptanceState === "accepted") &&
								!["pending", "ready", "running", "awaiting-verification"].includes(
									dependency.state,
								),
						)
					: dependencies.every(acceptedDependency);
			if (!dependenciesReady) continue;
			const available = new Map<string, WorkArtifactReference>();
			for (const dependency of dependencies) {
				for (const artifact of dependency.artifacts) available.set(artifact.id, artifact);
			}
			if (!item.inputArtifacts.every((artifact) => available.has(artifact))) continue;
			if (
				!Object.entries(item.requiredArtifactVersions).every(
					([id, version]) => available.get(id)?.version === version,
				)
			) {
				continue;
			}
			item.inputArtifactVersions = Object.fromEntries(
				item.inputArtifacts.map((id) => [id, available.get(id)?.version ?? "unknown"]),
			);
			item.state = "ready";
			item.generation = this.generation;
		}
	}

	private resetReworkDependents(targetId: string, excludedId: string): void {
		const target = this.require(targetId);
		const reworkReason = `${targetId}:verification-rework`;
		const queue = target.dependents.filter((id) => id !== excludedId);
		const seen = new Set<string>();
		while (queue.length > 0) {
			const currentId = queue.shift();
			if (!currentId || seen.has(currentId)) continue;
			seen.add(currentId);
			const current = this.require(currentId);
			queue.push(...current.dependents.filter((id) => id !== excludedId));
			if (current.state !== "invalidated" || current.invalidationReasons.at(-1) !== reworkReason) {
				continue;
			}
			current.artifactHistory.push(
				...current.artifacts.map((artifact) => structuredClone(artifact)),
			);
			current.artifacts = [];
			current.inputArtifactVersions = {};
			current.state = "pending";
			current.assignedAgentId = undefined;
			current.acceptedExecutionPlanId = undefined;
			current.outcomeReason = undefined;
			current.verificationAccepted = false;
			current.acceptanceState = current.acceptanceRequired ? "pending" : "not-required";
			current.stagedTreeIdentity = undefined;
			current.submission = undefined;
			current.verificationReceipt = undefined;
			current.acceptanceReceipt = undefined;
			current.generation = ++this.generation;
		}
	}

	private invalidateDependents(
		targetId: string,
		excludedId: string,
		reason: string | undefined,
	): WorkItemRecord[] {
		const target = this.require(targetId);
		const normalizedReason = bounded(reason ?? "verification-not-accepted", MAX_TEXT_LENGTH);
		const queue = target.dependents.filter((id) => id !== excludedId);
		const seen = new Set<string>();
		const affected: WorkItemRecord[] = [];
		while (queue.length > 0) {
			const currentId = queue.shift();
			if (!currentId || seen.has(currentId)) continue;
			seen.add(currentId);
			const current = this.require(currentId);
			current.state = "invalidated";
			current.taskGeneration++;
			current.invalidationReasons.push(`${targetId}:${normalizedReason}`);
			current.generation = ++this.generation;
			affected.push(structuredClone(current));
			queue.push(...current.dependents.filter((id) => id !== excludedId));
		}
		return affected;
	}

	private require(id: string): WorkItemRecord {
		const item = this.items.get(id);
		if (!item) throw new Error(`Unknown WorkItem ${id}`);
		return item;
	}

	private assertMutable(item: WorkItemRecord): void {
		if (
			TERMINAL_STATES.has(item.state) &&
			!(item.state === "completed" && item.acceptanceState === "pending")
		) {
			throw new Error(`WorkItem ${item.id} is terminal (${item.state})`);
		}
	}
}

function assertReceiptMatches(
	target: WorkItemRecord,
	verifier: WorkItemRecord,
	verifierExecutionPlanId: string,
	receipt: WorkflowVerificationReceipt,
): void {
	if (
		receipt.targetTaskId !== target.id ||
		receipt.targetTaskGeneration !== target.taskGeneration ||
		receipt.targetExecutionPlanId !== target.acceptedExecutionPlanId ||
		receipt.verifierTaskId !== verifier.id ||
		receipt.verifierTaskGeneration !== verifier.taskGeneration ||
		receipt.verifierExecutionPlanId !== verifierExecutionPlanId ||
		!target.stagedTreeIdentity ||
		!sameWorkflowTreeIdentity(receipt.treeIdentity, target.stagedTreeIdentity)
	) {
		throw new Error("WorkItem verification receipt has stale or mismatched executor identity");
	}
}

function assertVerifiedReceiptMatches(
	target: WorkItemRecord,
	verifier: WorkItemRecord,
	verifierExecutionPlanId: string,
	receipt: VerificationReceipt,
): void {
	if (
		!target.acceptanceRequired ||
		target.acceptanceState !== "pending" ||
		target.state !== "completed" ||
		!target.submission ||
		receipt.targetTaskId !== target.id ||
		receipt.targetTaskGeneration !== target.taskGeneration ||
		receipt.targetExecutionPlanId !== target.acceptedExecutionPlanId ||
		receipt.verifierTaskId !== verifier.id ||
		receipt.verifierTaskGeneration !== verifier.taskGeneration ||
		receipt.verifierExecutionPlanId !== verifierExecutionPlanId ||
		receipt.verifierAgent !== verifier.assignedAgentId?.replace(/^agent:/u, "") ||
		!sameWorkflowTreeIdentity(receipt.beforeTreeIdentity, target.submission.treeIdentity) ||
		!sameWorkflowTreeIdentity(receipt.afterTreeIdentity, target.submission.treeIdentity) ||
		receipt.baseRepositoryGeneration !== target.submission.baseRepositoryGeneration ||
		receipt.patchDigest !== target.submission.patchDigest ||
		JSON.stringify(receipt.changedPaths) !== JSON.stringify(target.submission.changedPaths) ||
		JSON.stringify(receipt.allowedScopes) !== JSON.stringify(target.writePaths) ||
		JSON.stringify(receipt.dependencyVersions) !== JSON.stringify(target.inputArtifactVersions) ||
		JSON.stringify(receipt.readSetVersions) !== JSON.stringify(target.submission.fileVersions) ||
		JSON.stringify(receipt.acceptanceCriteria) !== JSON.stringify(target.acceptanceCriteria) ||
		JSON.stringify(receipt.requiredEvidenceIds) !== JSON.stringify(target.requiredEvidence)
	) {
		throw new Error("WorkItem verification receipt has stale or mismatched managed identity");
	}
}

function validatePlanId(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid ${label}`);
}

function validateSubmission(value: VerificationSubmission): void {
	if (
		!isWorkflowTreeIdentity(value.treeIdentity) ||
		!/^[a-f0-9]{40,64}$/u.test(value.baseRepositoryGeneration) ||
		!/^[a-f0-9]{64}$/u.test(value.patchDigest) ||
		!Array.isArray(value.changedPaths) ||
		value.changedPaths.length > MAX_LIST_ITEMS ||
		value.changedPaths.some(
			(item) =>
				typeof item !== "string" ||
				!item ||
				item.length > 4096 ||
				item.startsWith("/") ||
				item.startsWith("\\") ||
				item.split(/[\\/]/u).includes(".."),
		) ||
		new Set(value.changedPaths).size !== value.changedPaths.length ||
		value.changedPaths.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0) >
			8 * 1024 ||
		JSON.stringify([...value.changedPaths].sort((left, right) => left.localeCompare(right))) !==
			JSON.stringify(value.changedPaths) ||
		!value.fileVersions ||
		typeof value.fileVersions !== "object" ||
		Array.isArray(value.fileVersions) ||
		Object.entries(value.fileVersions).length > MAX_LIST_ITEMS ||
		JSON.stringify(
			Object.keys(value.fileVersions).sort((left, right) => left.localeCompare(right)),
		) !== JSON.stringify(value.changedPaths) ||
		Object.entries(value.fileVersions).some(
			([key, digest]) =>
				!key ||
				key.length > 4096 ||
				typeof digest !== "string" ||
				(digest !== "deleted" && !/^[a-f0-9]{64}$/u.test(digest)),
		)
	) {
		throw new Error("WorkItem received malformed verification submission metadata");
	}
}

function validSubmission(value: VerificationSubmission): boolean {
	try {
		validateSubmission(value);
		return true;
	} catch {
		return false;
	}
}

function normalizeLegacyAcceptance(item: WorkItemRecord, isV1: boolean): WorkItemRecord {
	return {
		...structuredClone(item),
		requiredEvidence: [],
		acceptanceStateVersion: WORK_ITEM_ACCEPTANCE_VERSION,
		acceptanceRequired: false,
		acceptanceState: "not-required",
		reworkCount: 0,
		maxReworkCycles: 1,
		verificationAccepted: isV1 ? false : item.verificationAccepted,
		acceptanceReceipt: undefined,
		acceptanceReceiptHistory: [],
		submission: undefined,
	};
}

function validateStoredRecord(item: WorkItemRecord, ledgerGeneration: number): void {
	const states: WorkItemState[] = [
		"pending",
		"ready",
		"running",
		"awaiting-verification",
		"blocked",
		"needs-input",
		"completed",
		"failed",
		"interrupted",
		"stale",
		"invalidated",
	];
	if (
		!item ||
		typeof item !== "object" ||
		typeof item.objective !== "string" ||
		item.objective.length === 0 ||
		item.objective.length > MAX_TEXT_LENGTH ||
		item.objective.trim() !== item.objective ||
		!states.includes(item.state) ||
		!Number.isSafeInteger(item.generation) ||
		item.generation < 0 ||
		item.generation > ledgerGeneration ||
		!Number.isSafeInteger(item.taskGeneration) ||
		item.taskGeneration < 1 ||
		!Array.isArray(item.artifacts) ||
		!validStoredArtifacts(item.artifacts, item.id, item.generation) ||
		(item.artifactHistory !== undefined && !Array.isArray(item.artifactHistory)) ||
		(item.artifactHistory !== undefined &&
			!validStoredArtifacts(item.artifactHistory, item.id, item.generation)) ||
		!item.inputArtifactVersions ||
		typeof item.inputArtifactVersions !== "object" ||
		Array.isArray(item.inputArtifactVersions) ||
		(item.assignedAgentId !== undefined && !isValidIdentifier(item.assignedAgentId)) ||
		(item.selectedAgentName !== undefined &&
			(typeof item.selectedAgentName !== "string" ||
				item.selectedAgentName.length === 0 ||
				item.selectedAgentName.length > MAX_IDENTIFIER_LENGTH ||
				item.selectedAgentName.trim() !== item.selectedAgentName)) ||
		item.acceptanceStateVersion !== WORK_ITEM_ACCEPTANCE_VERSION ||
		typeof item.acceptanceRequired !== "boolean" ||
		!["not-required", "pending", "accepted", "rework-requested", "rejected"].includes(
			item.acceptanceState,
		) ||
		!Number.isSafeInteger(item.reworkCount) ||
		item.reworkCount < 0 ||
		item.reworkCount > 1 ||
		(item.maxReworkCycles !== 0 && item.maxReworkCycles !== 1) ||
		(item.acceptanceRequired && !item.integrationOwner) ||
		(!item.acceptanceRequired && item.acceptanceState !== "not-required") ||
		typeof item.integrationOwner !== "boolean" ||
		!(["completed", "settled"] as const).includes(item.dependencyPolicy) ||
		!(["read-only", "idempotent", "mutating"] as const).includes(item.sideEffectPolicy) ||
		(item.verifierFor !== undefined && !isValidIdentifier(item.verifierFor)) ||
		![
			item.dependencies,
			item.dependents,
			item.inputArtifacts,
			item.requiredCapabilities,
			item.requiredTools,
			item.readPaths,
			item.writePaths,
			item.ownershipKeys,
			item.acceptanceCriteria,
			item.requiredEvidence,
		].every(
			(values) =>
				Array.isArray(values) &&
				values.every(
					(value) =>
						typeof value === "string" &&
						value.length > 0 &&
						value.length <= MAX_TEXT_LENGTH &&
						value.trim() === value,
				),
		) ||
		!item.requiredArtifactVersions ||
		typeof item.requiredArtifactVersions !== "object" ||
		Array.isArray(item.requiredArtifactVersions) ||
		!Object.entries(item.requiredArtifactVersions).every(
			([id, version]) =>
				isValidIdentifier(id) &&
				typeof version === "string" &&
				version.length > 0 &&
				version.length <= MAX_IDENTIFIER_LENGTH &&
				version.trim() === version,
		) ||
		(item.acceptedExecutionPlanId !== undefined &&
			(typeof item.acceptedExecutionPlanId !== "string" ||
				!/^[a-f0-9]{64}$/u.test(item.acceptedExecutionPlanId))) ||
		!Object.entries(item.inputArtifactVersions).every(
			([id, value]) =>
				isValidIdentifier(id) &&
				typeof value === "string" &&
				value.length > 0 &&
				value.length <= MAX_IDENTIFIER_LENGTH &&
				value.trim() === value,
		) ||
		!Array.isArray(item.invalidationReasons) ||
		!item.invalidationReasons.every(
			(reason) =>
				typeof reason === "string" &&
				reason.length > 0 &&
				reason.length <= MAX_TEXT_LENGTH &&
				reason.trim() === reason,
		) ||
		(item.outcomeReason !== undefined &&
			(typeof item.outcomeReason !== "string" ||
				item.outcomeReason.length > MAX_TEXT_LENGTH ||
				item.outcomeReason.trim() !== item.outcomeReason)) ||
		typeof item.verificationAccepted !== "boolean" ||
		(item.stagedTreeIdentity !== undefined && !isWorkflowTreeIdentity(item.stagedTreeIdentity)) ||
		(item.verificationReceipt !== undefined &&
			(!isWorkflowVerificationReceipt(item.verificationReceipt) ||
				!storedVerificationMatchesItem(item, item.verificationReceipt))) ||
		(item.acceptanceReceipt !== undefined &&
			(!isVerificationReceipt(item.acceptanceReceipt) ||
				(item.acceptanceState !== "pending" &&
					!storedAcceptanceMatchesItem(item, item.acceptanceReceipt)))) ||
		!Array.isArray(item.acceptanceReceiptHistory) ||
		item.acceptanceReceiptHistory.length > 2 ||
		!item.acceptanceReceiptHistory.every(isVerificationReceipt) ||
		(item.acceptanceReceipt !== undefined &&
			JSON.stringify(item.acceptanceReceiptHistory.at(-1)) !==
				JSON.stringify(item.acceptanceReceipt)) ||
		item.reworkCount !==
			Math.min(
				item.maxReworkCycles,
				item.acceptanceReceiptHistory.filter((receipt) => receipt.decision === "rework").length,
			) ||
		(item.submission !== undefined && !validSubmission(item.submission)) ||
		(item.acceptanceRequired &&
			item.state === "completed" &&
			item.acceptanceState === "pending" &&
			(!item.submission || !item.acceptedExecutionPlanId)) ||
		(item.acceptanceState === "accepted" &&
			(item.acceptanceReceipt?.decision !== "accept" || !item.verificationAccepted)) ||
		(item.acceptanceState === "rejected" &&
			(!["failed", "interrupted", "stale", "invalidated", "blocked", "needs-input"].includes(
				item.state,
			) ||
				(item.acceptanceReceipt !== undefined &&
					item.acceptanceReceipt.decision !== "reject" &&
					item.acceptanceReceipt.decision !== "rework"))) ||
		(item.acceptanceState === "rework-requested" &&
			(item.state !== "blocked" || item.acceptanceReceipt?.decision !== "rework")) ||
		(item.state === "awaiting-verification" &&
			(!item.stagedTreeIdentity || !item.acceptedExecutionPlanId)) ||
		(item.stagedTreeIdentity !== undefined &&
			item.state === "completed" &&
			!item.acceptanceRequired &&
			item.verificationReceipt === undefined)
	) {
		throw new Error(`Malformed stored WorkItem ${String(item?.id ?? "unknown")}`);
	}
}

function storedAcceptanceMatchesItem(item: WorkItemRecord, receipt: VerificationReceipt): boolean {
	return (
		item.acceptanceRequired &&
		item.submission !== undefined &&
		receipt.targetTaskId === item.id &&
		receipt.targetTaskGeneration === item.taskGeneration &&
		receipt.targetExecutionPlanId === item.acceptedExecutionPlanId &&
		sameWorkflowTreeIdentity(receipt.beforeTreeIdentity, item.submission.treeIdentity) &&
		sameWorkflowTreeIdentity(receipt.afterTreeIdentity, item.submission.treeIdentity) &&
		receipt.baseRepositoryGeneration === item.submission.baseRepositoryGeneration &&
		receipt.patchDigest === item.submission.patchDigest &&
		JSON.stringify(receipt.changedPaths) === JSON.stringify(item.submission.changedPaths) &&
		JSON.stringify(receipt.allowedScopes) === JSON.stringify(item.writePaths) &&
		JSON.stringify(receipt.dependencyVersions) === JSON.stringify(item.inputArtifactVersions) &&
		JSON.stringify(receipt.readSetVersions) === JSON.stringify(item.submission.fileVersions) &&
		JSON.stringify(receipt.acceptanceCriteria) === JSON.stringify(item.acceptanceCriteria) &&
		JSON.stringify(receipt.requiredEvidenceIds) === JSON.stringify(item.requiredEvidence)
	);
}

function storedVerificationMatchesItem(
	item: WorkItemRecord,
	receipt: WorkflowVerificationReceipt,
): boolean {
	return (
		!item.verifierFor &&
		receipt.targetTaskId === item.id &&
		receipt.targetTaskGeneration === item.taskGeneration &&
		receipt.targetExecutionPlanId === item.acceptedExecutionPlanId &&
		item.stagedTreeIdentity !== undefined &&
		sameWorkflowTreeIdentity(receipt.treeIdentity, item.stagedTreeIdentity) &&
		item.verificationAccepted === (receipt.decision === "accept") &&
		(receipt.decision === "accept"
			? item.state === "completed"
			: receipt.decision === "rework"
				? item.state === "blocked"
				: item.state === "failed")
	);
}

function validStoredArtifacts(
	values: WorkArtifactReference[],
	producerTaskId: string,
	itemGeneration: number,
): boolean {
	const seen = new Set<string>();
	return values.every(
		(artifact) =>
			artifact !== null &&
			typeof artifact === "object" &&
			Object.keys(artifact).every((key) =>
				["id", "kind", "version", "digest", "producerTaskId", "generation", "verified"].includes(
					key,
				),
			) &&
			isValidIdentifier(artifact.id) &&
			claimUnique(artifact.id, seen) &&
			typeof artifact.kind === "string" &&
			artifact.kind.length > 0 &&
			artifact.kind.length <= MAX_IDENTIFIER_LENGTH &&
			artifact.kind.trim() === artifact.kind &&
			typeof artifact.version === "string" &&
			artifact.version.length > 0 &&
			artifact.version.length <= MAX_IDENTIFIER_LENGTH &&
			artifact.version.trim() === artifact.version &&
			(artifact.digest === undefined ||
				(typeof artifact.digest === "string" &&
					artifact.digest.length > 0 &&
					artifact.digest.length <= MAX_TEXT_LENGTH &&
					artifact.digest.trim() === artifact.digest)) &&
			artifact.producerTaskId === producerTaskId &&
			Number.isSafeInteger(artifact.generation) &&
			Number(artifact.generation) >= 0 &&
			Number(artifact.generation) <= itemGeneration &&
			typeof artifact.verified === "boolean",
	);
}

function claimUnique(value: string, seen: Set<string>): boolean {
	if (seen.has(value)) return false;
	seen.add(value);
	return true;
}

function normalizeStoredArtifacts(
	values: WorkArtifactReference[],
	defaultProducerTaskId: string,
	defaultGeneration: number,
	preserveVerification: boolean,
): WorkArtifactReference[] {
	if (!validStoredArtifacts(values, defaultProducerTaskId, defaultGeneration)) {
		throw new Error(`Malformed stored artifacts for WorkItem ${defaultProducerTaskId}`);
	}
	return values.map((value) => ({
		...structuredClone(value),
		verified: preserveVerification && value.verified,
	}));
}

function normalizeArtifacts(
	values: Array<Omit<WorkArtifactReference, "producerTaskId" | "generation">>,
	producerTaskId: string,
	generation: number,
): WorkArtifactReference[] {
	if (values.length > MAX_LIST_ITEMS) throw new Error("Too many WorkItem artifacts");
	const seen = new Set<string>();
	return values.map((value) => {
		validateIdentifier(value.id, "artifact id");
		if (seen.has(value.id)) throw new Error(`Duplicate artifact id ${value.id}`);
		seen.add(value.id);
		const kind = bounded(value.kind, MAX_IDENTIFIER_LENGTH);
		const version = bounded(value.version, MAX_IDENTIFIER_LENGTH);
		if (!kind || !version) throw new Error(`Artifact ${value.id} requires kind and version`);
		return {
			id: value.id,
			kind,
			version,
			...(value.digest ? { digest: bounded(value.digest, MAX_TEXT_LENGTH) } : {}),
			producerTaskId,
			generation,
			verified: false,
		};
	});
}

function normalizeVersionMap(value: Record<string, string> | undefined): Record<string, string> {
	if (value === undefined) return {};
	const entries = Object.entries(value);
	if (entries.length > MAX_LIST_ITEMS) throw new Error("Too many artifact version requirements");
	return Object.fromEntries(
		entries.map(([id, version]) => {
			validateIdentifier(id, "artifact version id");
			const normalized = bounded(version, MAX_IDENTIFIER_LENGTH);
			if (!normalized) throw new Error(`Artifact ${id} requires a version`);
			return [id, normalized];
		}),
	);
}

function uniqueBounded(values: readonly string[], label: string): string[] {
	if (!Array.isArray(values) || values.length > MAX_LIST_ITEMS) {
		throw new Error(`Too many WorkItem ${label} values`);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") throw new Error(`Invalid WorkItem ${label}`);
		const normalized = bounded(value, MAX_TEXT_LENGTH);
		if (!normalized) throw new Error(`Empty WorkItem ${label}`);
		if (!seen.has(normalized)) result.push(normalized);
		seen.add(normalized);
	}
	return result;
}

function isValidIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= MAX_IDENTIFIER_LENGTH &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
	);
}

function validateIdentifier(value: string, label: string): void {
	if (!isValidIdentifier(value)) {
		throw new Error(`Invalid ${label}`);
	}
}

function bounded(value: string, maxLength: number): string {
	return value.trim().slice(0, maxLength);
}
