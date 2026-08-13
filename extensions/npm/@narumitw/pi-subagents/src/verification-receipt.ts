import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { redactPrivateText } from "./context.js";
import { truncateUtf8 } from "./limits.js";
import {
	WORKFLOW_TREE_IDENTITY_VERSION,
	type WorkflowTreeIdentity,
} from "./workflow-tree-identity.js";

export const VERIFICATION_RECEIPT_VERSION = "pi-subagents:verification-receipt:v1" as const;
export type VerificationReceiptDecision = "accept" | "rework" | "reject";

const MAX_FIELD_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024;
const MAX_RECEIPT_BYTES = 12 * 1024;
const MAX_LIST_ITEMS = 64;
const MAX_RECORD_ITEMS = 64;
const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
const SHA_PATTERN = "^[a-f0-9]{64}$";
const REPOSITORY_GENERATION_PATTERN = "^[a-f0-9]{40,64}$";

const BoundedId = Type.String({ pattern: ID_PATTERN, maxLength: 256 });
const Sha256 = Type.String({ pattern: SHA_PATTERN, maxLength: 64 });
const BoundedText = Type.String({ minLength: 1, maxLength: MAX_FIELD_BYTES });
const TreeIdentitySchema = Type.Object(
	{
		version: Type.Literal(WORKFLOW_TREE_IDENTITY_VERSION),
		kind: Type.Union([Type.Literal("git-commit"), Type.Literal("git-dirty")]),
		digest: Sha256,
	},
	{ additionalProperties: false },
);
const StringRecordSchema = Type.Record(
	Type.String({ minLength: 1, maxLength: 4096 }),
	Type.String({ minLength: 1, maxLength: MAX_FIELD_BYTES }),
	{ maxProperties: MAX_RECORD_ITEMS },
);

export const VerificationCheckReceiptSchema = Type.Object(
	{
		id: BoundedId,
		command: Type.String({ minLength: 1, maxLength: 256 }),
		args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
		exitCode: Type.Integer({ minimum: -1, maximum: 255 }),
		stdout: Type.String({ maxLength: MAX_OUTPUT_BYTES }),
		stderr: Type.String({ maxLength: MAX_OUTPUT_BYTES }),
		durationMs: Type.Integer({ minimum: 0 }),
		truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const VerificationReceiptSchema = Type.Object(
	{
		version: Type.Literal(VERIFICATION_RECEIPT_VERSION),
		decision: Type.Union([Type.Literal("accept"), Type.Literal("rework"), Type.Literal("reject")]),
		targetTaskId: BoundedId,
		targetTaskGeneration: Type.Integer({ minimum: 1 }),
		targetExecutionPlanId: Sha256,
		verifierTaskId: BoundedId,
		verifierTaskGeneration: Type.Integer({ minimum: 1 }),
		verifierExecutionPlanId: Sha256,
		verifierAgent: BoundedId,
		beforeTreeIdentity: TreeIdentitySchema,
		afterTreeIdentity: TreeIdentitySchema,
		baseRepositoryGeneration: Type.String({
			pattern: REPOSITORY_GENERATION_PATTERN,
			maxLength: 64,
		}),
		patchDigest: Sha256,
		changedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
			maxItems: MAX_LIST_ITEMS,
		}),
		allowedScopes: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
			minItems: 1,
			maxItems: MAX_LIST_ITEMS,
		}),
		dependencyVersions: StringRecordSchema,
		readSetVersions: StringRecordSchema,
		acceptanceCriteria: Type.Array(BoundedText, { maxItems: MAX_LIST_ITEMS }),
		requiredEvidenceIds: Type.Array(BoundedId, { maxItems: MAX_LIST_ITEMS }),
		evidence: StringRecordSchema,
		checks: Type.Array(VerificationCheckReceiptSchema, { maxItems: 32 }),
		summary: BoundedText,
		findings: Type.Array(BoundedText, { maxItems: MAX_LIST_ITEMS }),
		createdAt: Type.Number({ minimum: 0 }),
		sourceTruncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export type VerificationCheckReceipt = Static<typeof VerificationCheckReceiptSchema>;
export type VerificationReceipt = Static<typeof VerificationReceiptSchema>;
export type CreateVerificationReceiptInput = Omit<VerificationReceipt, "version">;

export function createVerificationReceipt(
	input: CreateVerificationReceiptInput,
): VerificationReceipt {
	const receipt: VerificationReceipt = {
		version: VERIFICATION_RECEIPT_VERSION,
		decision: input.decision,
		targetTaskId: input.targetTaskId,
		targetTaskGeneration: input.targetTaskGeneration,
		targetExecutionPlanId: input.targetExecutionPlanId,
		verifierTaskId: input.verifierTaskId,
		verifierTaskGeneration: input.verifierTaskGeneration,
		verifierExecutionPlanId: input.verifierExecutionPlanId,
		verifierAgent: input.verifierAgent,
		beforeTreeIdentity: structuredClone(input.beforeTreeIdentity),
		afterTreeIdentity: structuredClone(input.afterTreeIdentity),
		baseRepositoryGeneration: input.baseRepositoryGeneration,
		patchDigest: input.patchDigest,
		changedPaths: boundList(input.changedPaths, MAX_FIELD_BYTES),
		allowedScopes: boundList(input.allowedScopes, MAX_FIELD_BYTES),
		dependencyVersions: boundRecord(input.dependencyVersions),
		readSetVersions: boundRecord(input.readSetVersions),
		acceptanceCriteria: boundList(input.acceptanceCriteria, MAX_FIELD_BYTES),
		requiredEvidenceIds: boundList(input.requiredEvidenceIds, 256),
		evidence: boundRecord(input.evidence),
		checks: input.checks.slice(0, 32).map(boundCheck),
		summary: boundRequired(input.summary, MAX_FIELD_BYTES, "summary"),
		findings: boundList(input.findings, MAX_FIELD_BYTES),
		createdAt: input.createdAt,
		sourceTruncated:
			input.sourceTruncated ||
			input.checks.length > 32 ||
			input.checks.some(
				(check) =>
					check.truncated ||
					check.args.length > 64 ||
					check.args.some((value) => Buffer.byteLength(value, "utf8") > 4096) ||
					Buffer.byteLength(check.stdout, "utf8") > MAX_OUTPUT_BYTES ||
					Buffer.byteLength(check.stderr, "utf8") > MAX_OUTPUT_BYTES,
			) ||
			input.requiredEvidenceIds.some((value) => Buffer.byteLength(value, "utf8") > 256) ||
			[
				input.changedPaths,
				input.allowedScopes,
				input.acceptanceCriteria,
				input.requiredEvidenceIds,
				input.findings,
			].some(
				(values) =>
					values.length > MAX_LIST_ITEMS ||
					values.some((value) => Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES),
			) ||
			[input.dependencyVersions, input.readSetVersions, input.evidence].some(
				(value) =>
					Object.keys(value).length > MAX_RECORD_ITEMS ||
					Object.entries(value).some(
						([key, item]) =>
							Buffer.byteLength(key, "utf8") > 4096 ||
							Buffer.byteLength(item, "utf8") > MAX_FIELD_BYTES,
					),
			),
	};
	assertReceiptSemantics(receipt);
	if (!Check(VerificationReceiptSchema, receipt)) {
		throw new Error("Verification receipt contains invalid executor metadata");
	}
	if (Buffer.byteLength(JSON.stringify(receipt), "utf8") > MAX_RECEIPT_BYTES) {
		throw new Error("Verification receipt exceeded its total size limit");
	}
	return receipt;
}

export function isVerificationReceipt(value: unknown): value is VerificationReceipt {
	if (
		!Check(VerificationReceiptSchema, value) ||
		Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RECEIPT_BYTES
	) {
		return false;
	}
	try {
		assertReceiptSemantics(value as VerificationReceipt);
		return true;
	} catch {
		return false;
	}
}

function assertReceiptSemantics(receipt: VerificationReceipt): void {
	if (
		receipt.beforeTreeIdentity.kind !== receipt.afterTreeIdentity.kind ||
		receipt.beforeTreeIdentity.digest !== receipt.afterTreeIdentity.digest
	) {
		throw new Error("Verification receipt rejected submitted-state drift");
	}
	const missingEvidence = receipt.requiredEvidenceIds.filter((id) => !receipt.evidence[id]);
	if (receipt.decision === "accept" && missingEvidence.length > 0) {
		throw new Error(
			`Verification receipt is missing required evidence: ${missingEvidence.join(", ")}`,
		);
	}
	if (receipt.decision === "accept" && receipt.checks.some((check) => check.status !== "passed")) {
		throw new Error("Verification receipt cannot accept a failed check");
	}
	if (receipt.decision === "rework" && receipt.findings.length === 0) {
		throw new Error("Verification receipt rework requires a concrete finding");
	}
	if (receipt.decision === "reject" && receipt.findings.length === 0) {
		throw new Error("Verification receipt reject requires a concrete finding");
	}
	for (const values of [
		receipt.changedPaths,
		receipt.allowedScopes,
		receipt.acceptanceCriteria,
		receipt.requiredEvidenceIds,
		receipt.findings,
	]) {
		if (new Set(values).size !== values.length) {
			throw new Error("Verification receipt contains duplicate bounded values");
		}
	}
	if (new Set(receipt.checks.map((check) => check.id)).size !== receipt.checks.length) {
		throw new Error("Verification receipt contains duplicate check ids");
	}
}

function boundCheck(check: VerificationCheckReceipt): VerificationCheckReceipt {
	const stdout = boundOptional(check.stdout, MAX_OUTPUT_BYTES);
	const stderr = boundOptional(check.stderr, MAX_OUTPUT_BYTES);
	return {
		id: boundRequired(check.id, 256, "check id"),
		command: boundRequired(check.command, 256, "check command"),
		args: check.args.slice(0, 64).map((value) => boundOptional(value, 4096).value),
		cwd: boundRequired(check.cwd, 4096, "check cwd"),
		status: check.status,
		exitCode: check.exitCode,
		stdout: stdout.value,
		stderr: stderr.value,
		durationMs: Math.max(0, Math.floor(check.durationMs)),
		truncated: check.truncated || stdout.truncated || stderr.truncated || check.args.length > 64,
	};
}

function boundList(values: readonly string[], maxItemBytes: number): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values.slice(0, MAX_LIST_ITEMS)) {
		const bounded = boundOptional(value, maxItemBytes).value;
		if (!bounded || seen.has(bounded)) continue;
		seen.add(bounded);
		result.push(bounded);
	}
	return result;
}

function boundRecord(value: Record<string, string>): Record<string, string> {
	const entries = Object.entries(value).slice(0, MAX_RECORD_ITEMS);
	return Object.fromEntries(
		entries.map(([key, item]) => [
			boundRequired(key, 4096, "record key"),
			boundRequired(item, MAX_FIELD_BYTES, "record value"),
		]),
	);
}

function boundRequired(value: string, maxBytes: number, label: string): string {
	const bounded = boundOptional(value, maxBytes).value;
	if (!bounded) throw new Error(`Verification receipt requires ${label}`);
	return bounded;
}

function boundOptional(value: string, maxBytes: number): { value: string; truncated: boolean } {
	const redacted = redactPrivateText(value).trim();
	const bounded = truncateUtf8(redacted, maxBytes);
	return { value: bounded.text, truncated: bounded.truncated };
}

export function sameReceiptTree(left: WorkflowTreeIdentity, right: WorkflowTreeIdentity): boolean {
	return left.kind === right.kind && left.digest === right.digest;
}
