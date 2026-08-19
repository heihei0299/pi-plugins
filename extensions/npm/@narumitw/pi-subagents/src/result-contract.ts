import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";

export const SUBAGENT_RESULT_FORMATS = ["text", "structured-v1", "structured-v2"] as const;
export type SubagentResultFormat = (typeof SUBAGENT_RESULT_FORMATS)[number];

export interface StructuredSubagentResult {
	version: "pi-subagents:result:v1";
	summary: string;
	evidence: string[];
	changes: string[];
	verification: string[];
	risks: string[];
}

export const SUBAGENT_OUTCOME_STATUSES = [
	"completed",
	"partial",
	"blocked",
	"needs-input",
	"abstained",
	"failed",
	"interrupted",
	"stale",
	"contract-invalid",
] as const;
export type SubagentOutcomeStatus = (typeof SUBAGENT_OUTCOME_STATUSES)[number];

export const SUBAGENT_CLAIM_CLASSIFICATIONS = ["observed", "inferred", "unverified"] as const;
export type SubagentClaimClassification = (typeof SUBAGENT_CLAIM_CLASSIFICATIONS)[number];

export interface EvidenceBackedClaim {
	claim: string;
	classification: SubagentClaimClassification;
	evidence: string[];
}

export interface SubagentArtifactReference {
	id: string;
	kind: string;
	version?: string;
	location?: string;
	digest?: string;
}

export interface SubagentChangeReference {
	path: string;
	summary: string;
}

export interface SubagentVerificationReference {
	status: "passed" | "failed" | "not-run";
	summary: string;
	command?: string;
	evidence?: string[];
}

export interface SubagentResultProvenance {
	taskId?: string;
	taskGeneration?: number;
	executionPlanId?: string;
	cancellationLineage?: string[];
	inputArtifacts?: string[];
	repositoryGeneration?: string;
}

export interface StructuredSubagentResultV2 {
	version: "pi-subagents:result:v2";
	status: SubagentOutcomeStatus;
	reasonCode?: string;
	summary: string;
	claims: EvidenceBackedClaim[];
	artifacts: SubagentArtifactReference[];
	changes: SubagentChangeReference[];
	verification: SubagentVerificationReference[];
	limitations: string[];
	unresolvedDependencies: string[];
	provenance?: SubagentResultProvenance;
}

export type AnyStructuredSubagentResult = StructuredSubagentResult | StructuredSubagentResultV2;

export interface ResultContractRuntimeMetadata {
	truncated?: boolean;
	usage?: {
		input: number;
		output: number;
		cost: number;
		turns: number;
	};
}

export interface ResultContractEnvelope<T extends AnyStructuredSubagentResult> {
	result: T;
	truncated?: boolean;
	usage?: ResultContractRuntimeMetadata["usage"];
}

const MAX_FIELD_BYTES = 8 * 1024;
const MAX_ITEMS = 50;
const MAX_REASON_CODE_BYTES = 256;
const MAX_ARTIFACT_IDENTIFIER_BYTES = 256;

export function structuredResultInstruction(format: SubagentResultFormat | undefined): string {
	if (format === "structured-v1") {
		return [
			"Return the final answer as one JSON object and no surrounding prose.",
			'Use exactly version "pi-subagents:result:v1" and fields summary, evidence, changes, verification, and risks.',
			"summary must be a string and the other fields must be arrays of strings.",
		].join(" ");
	}
	if (format === "structured-v2") {
		const minimumResult = JSON.stringify({
			version: "pi-subagents:result:v2",
			status: "completed",
			summary: "Concise outcome",
			claims: [],
			artifacts: [],
			changes: [],
			verification: [],
			limitations: [],
			unresolvedDependencies: [],
		});
		return [
			"Return the final answer as one JSON object and no surrounding prose.",
			"Minimum valid result:",
			minimumResult,
			"Keep every top-level field shown, including empty arrays.",
			`status must be one of ${SUBAGENT_OUTCOME_STATUSES.join(", ")}.`,
			'Claim item shape: {"claim":"Observed fact","classification":"observed","evidence":["path:line"]}.',
			'Artifact item shape: {"id":"artifact-id","kind":"file","version":"optional","location":"optional","digest":"optional"}.',
			'Change item shape: {"path":"path/to/file","summary":"What changed"}.',
			'Verification item shape: {"status":"passed","summary":"What was checked","command":"optional","evidence":["optional"]}.',
			"Claim classification must be observed, inferred, or unverified; verification status must be passed, failed, or not-run.",
			"Use optional reasonCode for non-completed outcomes and optional provenance for taskId, inputArtifacts, and repositoryGeneration; executor-owned generation and plan identity are stamped after parsing.",
		].join("\n");
	}
	return "";
}

export function appendResultInstruction(
	prompt: string,
	format: SubagentResultFormat | undefined,
	maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): string {
	const instruction = structuredResultInstruction(format);
	if (!instruction) return prompt;
	const suffix = `\n\nResult contract:\n${instruction}`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const boundedPrompt = truncateUtf8(prompt, Math.max(0, maxBytes - suffixBytes)).text;
	return `${boundedPrompt}${suffix}`;
}

export function parseStructuredSubagentResult(text: string): StructuredSubagentResult | undefined {
	const value = parseJsonObject(text);
	if (
		value?.version !== "pi-subagents:result:v1" ||
		!hasOnlyKeys(value, ["version", "summary", "evidence", "changes", "verification", "risks"]) ||
		typeof value.summary !== "string"
	) {
		return undefined;
	}
	const evidence = stringArray(value.evidence);
	const changes = stringArray(value.changes);
	const verification = stringArray(value.verification);
	const risks = stringArray(value.risks);
	if (!evidence || !changes || !verification || !risks) return undefined;
	return {
		version: "pi-subagents:result:v1",
		summary: bounded(value.summary),
		evidence,
		changes,
		verification,
		risks,
	};
}

export function parseStructuredSubagentResultV2(
	text: string,
): StructuredSubagentResultV2 | undefined {
	const value = parseJsonObject(text);
	if (
		value?.version !== "pi-subagents:result:v2" ||
		!hasOnlyKeys(value, [
			"version",
			"status",
			"reasonCode",
			"summary",
			"claims",
			"artifacts",
			"changes",
			"verification",
			"limitations",
			"unresolvedDependencies",
			"provenance",
		]) ||
		typeof value.status !== "string" ||
		!SUBAGENT_OUTCOME_STATUSES.includes(value.status as SubagentOutcomeStatus) ||
		typeof value.summary !== "string"
	) {
		return undefined;
	}
	const claims = objectArray(value.claims, parseClaim);
	const artifacts = objectArray(value.artifacts, parseArtifact);
	const changes = objectArray(value.changes, parseChange);
	const verification = objectArray(value.verification, parseVerification);
	const limitations = stringArray(value.limitations);
	const unresolvedDependencies = stringArray(value.unresolvedDependencies);
	if (
		!claims ||
		!artifacts ||
		new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length ||
		!changes ||
		!verification ||
		!limitations ||
		!unresolvedDependencies
	) {
		return undefined;
	}
	const reasonCode = optionalBoundedString(value.reasonCode, MAX_REASON_CODE_BYTES);
	if (reasonCode === false) return undefined;
	const provenance = parseProvenance(value.provenance);
	if (provenance === false) return undefined;
	return {
		version: "pi-subagents:result:v2",
		status: value.status as SubagentOutcomeStatus,
		...(reasonCode === undefined ? {} : { reasonCode }),
		summary: bounded(value.summary),
		claims,
		artifacts,
		changes,
		verification,
		limitations,
		unresolvedDependencies,
		...(provenance === undefined ? {} : { provenance }),
	};
}

export function parseAnyStructuredSubagentResult(
	text: string,
	format: SubagentResultFormat | undefined,
): AnyStructuredSubagentResult | undefined {
	if (format === "structured-v2") return parseStructuredSubagentResultV2(text);
	if (format === "structured-v1") return parseStructuredSubagentResult(text);
	return undefined;
}

export function resultContractEnvelope<T extends AnyStructuredSubagentResult>(
	result: T,
	metadata: ResultContractRuntimeMetadata = {},
): ResultContractEnvelope<T> {
	return {
		result,
		...(metadata.truncated === undefined ? {} : { truncated: metadata.truncated }),
		...(metadata.usage === undefined ? {} : { usage: { ...metadata.usage } }),
	};
}

function parseClaim(value: Record<string, unknown>): EvidenceBackedClaim | undefined {
	if (
		typeof value.claim !== "string" ||
		typeof value.classification !== "string" ||
		!SUBAGENT_CLAIM_CLASSIFICATIONS.includes(value.classification as SubagentClaimClassification)
	) {
		return undefined;
	}
	const evidence = stringArray(value.evidence);
	if (!evidence) return undefined;
	return {
		claim: bounded(value.claim),
		classification: value.classification as SubagentClaimClassification,
		evidence,
	};
}

function parseArtifact(value: Record<string, unknown>): SubagentArtifactReference | undefined {
	if (typeof value.id !== "string" || typeof value.kind !== "string") return undefined;
	const id = truncateUtf8(redactPrivateText(value.id), MAX_ARTIFACT_IDENTIFIER_BYTES).text.trim();
	const kind = truncateUtf8(
		redactPrivateText(value.kind),
		MAX_ARTIFACT_IDENTIFIER_BYTES,
	).text.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) || !kind) return undefined;
	const version = optionalTrimmedBoundedString(value.version, MAX_ARTIFACT_IDENTIFIER_BYTES);
	const location = optionalTrimmedBoundedString(value.location);
	const digest = optionalTrimmedBoundedString(value.digest);
	if (version === false || location === false || digest === false) return undefined;
	return {
		id,
		kind,
		...(version === undefined ? {} : { version }),
		...(location === undefined ? {} : { location }),
		...(digest === undefined ? {} : { digest }),
	};
}

function parseChange(value: Record<string, unknown>): SubagentChangeReference | undefined {
	if (typeof value.path !== "string" || typeof value.summary !== "string") return undefined;
	return { path: bounded(value.path), summary: bounded(value.summary) };
}

function parseVerification(
	value: Record<string, unknown>,
): SubagentVerificationReference | undefined {
	if (
		typeof value.status !== "string" ||
		!(["passed", "failed", "not-run"] as const).includes(
			value.status as SubagentVerificationReference["status"],
		) ||
		typeof value.summary !== "string"
	) {
		return undefined;
	}
	const command = optionalBoundedString(value.command);
	const evidence = value.evidence === undefined ? undefined : stringArray(value.evidence);
	if (command === false || (evidence === undefined && value.evidence !== undefined))
		return undefined;
	return {
		status: value.status as SubagentVerificationReference["status"],
		summary: bounded(value.summary),
		...(command === undefined ? {} : { command }),
		...(evidence === undefined ? {} : { evidence }),
	};
}

function parseProvenance(value: unknown): SubagentResultProvenance | undefined | false {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return false;
	const taskId = optionalBoundedString(value.taskId);
	const repositoryGeneration = optionalBoundedString(value.repositoryGeneration);
	const taskGeneration =
		value.taskGeneration === undefined
			? undefined
			: Number.isSafeInteger(value.taskGeneration) && Number(value.taskGeneration) >= 0
				? Number(value.taskGeneration)
				: false;
	const executionPlanId = optionalBoundedString(value.executionPlanId);
	const cancellationLineage =
		value.cancellationLineage === undefined ? undefined : stringArray(value.cancellationLineage);
	const inputArtifacts =
		value.inputArtifacts === undefined ? undefined : stringArray(value.inputArtifacts);
	if (
		taskId === false ||
		repositoryGeneration === false ||
		taskGeneration === false ||
		executionPlanId === false ||
		(cancellationLineage === undefined && value.cancellationLineage !== undefined) ||
		(inputArtifacts === undefined && value.inputArtifacts !== undefined)
	) {
		return false;
	}
	return {
		...(taskId === undefined ? {} : { taskId }),
		...(taskGeneration === undefined ? {} : { taskGeneration }),
		...(executionPlanId === undefined ? {} : { executionPlanId }),
		...(cancellationLineage === undefined ? {} : { cancellationLineage }),
		...(inputArtifacts === undefined ? {} : { inputArtifacts }),
		...(repositoryGeneration === undefined ? {} : { repositoryGeneration }),
	};
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_OUTPUT_BYTES) return undefined;
	const source = unwrapJsonFence(text).trim();
	if (!source.startsWith("{") || !source.endsWith("}")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return undefined;
	}
	return isPlainObject(parsed) ? parsed : undefined;
}

function objectArray<T>(
	value: unknown,
	parse: (entry: Record<string, unknown>) => T | undefined,
): T[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	const result: T[] = [];
	for (const item of value) {
		if (!isPlainObject(item)) return undefined;
		const parsed = parse(item);
		if (!parsed) return undefined;
		result.push(parsed);
	}
	return result;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	if (!value.every((item) => typeof item === "string")) return undefined;
	return value.map((item) => bounded(item));
}

function optionalTrimmedBoundedString(
	value: unknown,
	maxBytes = MAX_FIELD_BYTES,
): string | undefined | false {
	const boundedValue = optionalBoundedString(value, maxBytes);
	if (boundedValue === undefined || boundedValue === false) return boundedValue;
	const trimmed = boundedValue.trim();
	return trimmed || false;
}

function optionalBoundedString(
	value: unknown,
	maxBytes = MAX_FIELD_BYTES,
): string | undefined | false {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return false;
	return truncateUtf8(redactPrivateText(value), maxBytes).text;
}

function bounded(value: string): string {
	return truncateUtf8(redactPrivateText(value), MAX_FIELD_BYTES).text;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapJsonFence(value: string): string {
	const trimmed = value.trim();
	const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
	return match?.[1] ?? trimmed;
}
