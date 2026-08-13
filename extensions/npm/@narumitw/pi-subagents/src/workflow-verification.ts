import { redactPrivateText } from "./context.js";
import { truncateUtf8 } from "./limits.js";
import type { StructuredSubagentResultV2 } from "./result-contract.js";
import { isWorkflowTreeIdentity, type WorkflowTreeIdentity } from "./workflow-tree-identity.js";

export const WORKFLOW_VERIFICATION_VERSION = "pi-subagents:workflow-verification:v1" as const;
export type WorkflowVerificationDecision = "accept" | "rework" | "reject";
const MAX_FIELD_BYTES = 2 * 1024;
const MAX_ITEMS = 32;
const MAX_EVIDENCE_BYTES = 6 * 1024;
const MAX_LIMITATION_BYTES = 4 * 1024;
const MAX_INSTRUCTION_LIST_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLAN_PATTERN = /^[a-f0-9]{64}$/u;

export interface WorkflowVerificationReceipt {
	version: typeof WORKFLOW_VERIFICATION_VERSION;
	decision: WorkflowVerificationDecision;
	targetTaskId: string;
	targetTaskGeneration: number;
	targetExecutionPlanId: string;
	verifierTaskId: string;
	verifierTaskGeneration: number;
	verifierExecutionPlanId: string;
	treeIdentity: WorkflowTreeIdentity;
	summary: string;
	evidence: string[];
	limitations: string[];
	createdAt: number;
	truncated: boolean;
}

export interface WorkflowVerificationContext {
	targetTaskId: string;
	targetTaskGeneration: number;
	targetExecutionPlanId: string;
	verifierTaskId: string;
	verifierTaskGeneration: number;
	verifierExecutionPlanId: string;
	treeIdentity: WorkflowTreeIdentity;
	createdAt?: number;
	sourceTruncated?: boolean;
}

export function createWorkflowVerificationReceipt(
	result: StructuredSubagentResultV2,
	context: WorkflowVerificationContext,
): WorkflowVerificationReceipt {
	validateContext(context);
	const decision = verdict(result);
	const boundedSummary = bound(result.summary);
	if (!boundedSummary.value) throw new Error("Workflow verification verdict requires a summary");
	const evidenceSource = [
		...result.claims.flatMap((claim) => claim.evidence),
		...result.verification.flatMap((item) => [item.summary, ...(item.evidence ?? [])]),
	];
	const evidence = boundList(evidenceSource, MAX_EVIDENCE_BYTES);
	const limitations = boundList(
		[...result.limitations, ...result.unresolvedDependencies],
		MAX_LIMITATION_BYTES,
	);
	if (decision === "rework" && limitations.values.length === 0) {
		throw new Error("Workflow verification rework requires a limitation or unresolved dependency");
	}
	if (decision === "reject" && evidence.values.length === 0) {
		throw new Error("Workflow verification reject requires evidence");
	}
	return {
		version: WORKFLOW_VERIFICATION_VERSION,
		decision,
		targetTaskId: context.targetTaskId,
		targetTaskGeneration: context.targetTaskGeneration,
		targetExecutionPlanId: context.targetExecutionPlanId,
		verifierTaskId: context.verifierTaskId,
		verifierTaskGeneration: context.verifierTaskGeneration,
		verifierExecutionPlanId: context.verifierExecutionPlanId,
		treeIdentity: structuredClone(context.treeIdentity),
		summary: boundedSummary.value,
		evidence: evidence.values,
		limitations: limitations.values,
		createdAt: context.createdAt ?? Date.now(),
		truncated:
			context.sourceTruncated === true ||
			boundedSummary.truncated ||
			evidence.truncated ||
			limitations.truncated,
	};
}

export function workflowVerificationInstruction(
	targetTaskId: string,
	treeIdentity: WorkflowTreeIdentity,
	requirements: {
		acceptanceCriteria?: readonly string[];
		requiredEvidence?: readonly string[];
	} = {},
): string {
	if (!ID_PATTERN.test(targetTaskId) || !isWorkflowTreeIdentity(treeIdentity)) {
		throw new Error("Workflow verification instruction received invalid executor metadata");
	}
	const acceptanceCriteria = boundList(
		requirements.acceptanceCriteria ?? [],
		MAX_INSTRUCTION_LIST_BYTES,
	).values;
	const requiredEvidence = boundList(
		requirements.requiredEvidence ?? [],
		MAX_INSTRUCTION_LIST_BYTES,
	).values;
	return [
		"You are the independent verifier for one staged workflow result.",
		`Target task: ${JSON.stringify(targetTaskId)}.`,
		`Acceptance criteria: ${JSON.stringify(acceptanceCriteria)}.`,
		`Required evidence: ${JSON.stringify(requiredEvidence)}.`,
		`Exact Git-visible tree identity: ${treeIdentity.version}:${treeIdentity.kind}:${treeIdentity.digest}.`,
		"Do not modify the repository; the executor will reject acceptance if the tree identity changes.",
		"Return the requested pi-subagents:result:v2 object with exactly one verdict encoding.",
		'Accept only with status "completed", reasonCode "verification-accepted", at least one passed verification item, no failed verification item, and no unresolved dependency.',
		'Request rework only with status "partial" or "needs-input", reasonCode "verification-rework", and a concrete limitation or unresolved dependency.',
		'Reject only with status "failed" or "abstained", reasonCode "verification-rejected", and concrete evidence.',
		"Agreement, confidence, and the implementation worker's own verification claims are not proof.",
	].join("\n");
}

export function isWorkflowVerificationReceipt(
	value: unknown,
): value is WorkflowVerificationReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Partial<WorkflowVerificationReceipt>;
	if (
		Object.keys(value as Record<string, unknown>).some(
			(key) =>
				![
					"version",
					"decision",
					"targetTaskId",
					"targetTaskGeneration",
					"targetExecutionPlanId",
					"verifierTaskId",
					"verifierTaskGeneration",
					"verifierExecutionPlanId",
					"treeIdentity",
					"summary",
					"evidence",
					"limitations",
					"createdAt",
					"truncated",
				].includes(key),
		)
	) {
		return false;
	}
	return (
		receipt.version === WORKFLOW_VERIFICATION_VERSION &&
		(receipt.decision !== "rework" ||
			(Array.isArray(receipt.limitations) && receipt.limitations.length > 0)) &&
		(receipt.decision !== "reject" ||
			(Array.isArray(receipt.evidence) && receipt.evidence.length > 0)) &&
		["accept", "rework", "reject"].includes(String(receipt.decision)) &&
		typeof receipt.targetTaskId === "string" &&
		ID_PATTERN.test(receipt.targetTaskId) &&
		Number.isSafeInteger(receipt.targetTaskGeneration) &&
		Number(receipt.targetTaskGeneration) >= 1 &&
		typeof receipt.targetExecutionPlanId === "string" &&
		PLAN_PATTERN.test(receipt.targetExecutionPlanId) &&
		typeof receipt.verifierTaskId === "string" &&
		ID_PATTERN.test(receipt.verifierTaskId) &&
		Number.isSafeInteger(receipt.verifierTaskGeneration) &&
		Number(receipt.verifierTaskGeneration) >= 1 &&
		typeof receipt.verifierExecutionPlanId === "string" &&
		PLAN_PATTERN.test(receipt.verifierExecutionPlanId) &&
		isWorkflowTreeIdentity(receipt.treeIdentity) &&
		typeof receipt.summary === "string" &&
		receipt.summary.length > 0 &&
		Buffer.byteLength(receipt.summary, "utf8") <= MAX_FIELD_BYTES &&
		validStrings(receipt.evidence, MAX_EVIDENCE_BYTES) &&
		validStrings(receipt.limitations, MAX_LIMITATION_BYTES) &&
		typeof receipt.createdAt === "number" &&
		Number.isFinite(receipt.createdAt) &&
		receipt.createdAt >= 0 &&
		typeof receipt.truncated === "boolean"
	);
}

function verdict(result: StructuredSubagentResultV2): WorkflowVerificationDecision {
	if (result.version !== "pi-subagents:result:v2") {
		throw new Error("Workflow verification requires structured-v2");
	}
	if (result.reasonCode === "verification-accepted" && result.status === "completed") {
		if (result.verification.some((item) => item.status === "failed")) {
			throw new Error("Workflow verification accept cannot contain failed evidence");
		}
		if (!result.verification.some((item) => item.status === "passed")) {
			throw new Error("Workflow verification accept requires passed evidence");
		}
		if (result.unresolvedDependencies.length > 0) {
			throw new Error("Workflow verification accept cannot contain unresolved dependencies");
		}
		return "accept";
	}
	if (
		result.reasonCode === "verification-rework" &&
		(result.status === "partial" || result.status === "needs-input")
	) {
		return "rework";
	}
	if (
		result.reasonCode === "verification-rejected" &&
		(result.status === "failed" || result.status === "abstained")
	) {
		return "reject";
	}
	throw new Error("Workflow verification result does not contain a valid verdict");
}

function validateContext(context: WorkflowVerificationContext): void {
	for (const [label, value] of [
		["target task", context.targetTaskId],
		["verifier task", context.verifierTaskId],
	] as const) {
		if (!ID_PATTERN.test(value))
			throw new Error(`Workflow verification has an invalid ${label} id`);
	}
	for (const [label, value] of [
		["target", context.targetTaskGeneration],
		["verifier", context.verifierTaskGeneration],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`Workflow verification has an invalid ${label} task generation`);
		}
	}
	for (const value of [context.targetExecutionPlanId, context.verifierExecutionPlanId]) {
		if (!PLAN_PATTERN.test(value)) {
			throw new Error("Workflow verification has an invalid execution plan identity");
		}
	}
	if (!isWorkflowTreeIdentity(context.treeIdentity)) {
		throw new Error("Workflow verification has an invalid tree identity");
	}
	if (context.sourceTruncated !== undefined && typeof context.sourceTruncated !== "boolean") {
		throw new Error("Workflow verification has an invalid truncation state");
	}
	if (
		context.createdAt !== undefined &&
		(!Number.isFinite(context.createdAt) || context.createdAt < 0)
	) {
		throw new Error("Workflow verification has an invalid creation time");
	}
}

function bound(value: string): { value: string; truncated: boolean } {
	const redacted = redactPrivateText(value).trim();
	const truncated = truncateUtf8(redacted, MAX_FIELD_BYTES);
	return { value: truncated.text, truncated: truncated.truncated };
}

function boundList(
	values: readonly string[],
	maxTotalBytes: number,
): { values: string[]; truncated: boolean } {
	let truncated = values.length > MAX_ITEMS;
	let remaining = maxTotalBytes;
	const result: string[] = [];
	const seen = new Set<string>();
	for (const raw of values.slice(0, MAX_ITEMS)) {
		if (remaining < 1) {
			truncated = true;
			break;
		}
		const redacted = redactPrivateText(raw).trim();
		const item = truncateUtf8(redacted, Math.min(MAX_FIELD_BYTES, remaining));
		truncated ||= item.truncated;
		if (!item.text || seen.has(item.text)) continue;
		seen.add(item.text);
		result.push(item.text);
		remaining -= Buffer.byteLength(item.text, "utf8");
	}
	return { values: result, truncated };
}

function validStrings(value: unknown, maxTotalBytes: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_ITEMS &&
		value.reduce(
			(total, item) =>
				total + (typeof item === "string" ? Buffer.byteLength(item, "utf8") : maxTotalBytes + 1),
			0,
		) <= maxTotalBytes &&
		value.every(
			(item) =>
				typeof item === "string" &&
				item.length > 0 &&
				Buffer.byteLength(item, "utf8") <= MAX_FIELD_BYTES,
		)
	);
}
