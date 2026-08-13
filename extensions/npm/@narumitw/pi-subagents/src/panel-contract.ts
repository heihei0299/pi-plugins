import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_OUTPUT_BYTES, truncateUtf8 } from "./limits.js";

export const PANEL_REVIEW_VERSION = "pi-subagents:panel-review:v1" as const;
export const PANEL_SYNTHESIS_VERSION = "pi-subagents:panel-synthesis:v1" as const;
export const PANEL_DISPOSITIONS = ["pass", "fail", "partial"] as const;
export const PANEL_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export type PanelDisposition = (typeof PANEL_DISPOSITIONS)[number];
export type PanelSeverity = (typeof PANEL_SEVERITIES)[number];

export interface PanelFinding {
	id: string;
	severity: PanelSeverity;
	title: string;
	claim: string;
	evidence: string[];
	verification?: string[];
}

export interface PanelReviewProvenance {
	reviewerId: string;
	agent?: string;
	model?: string;
	taskGeneration: number;
}

export interface PanelReview {
	version: typeof PANEL_REVIEW_VERSION;
	reviewerId: string;
	disposition: PanelDisposition;
	blocking: boolean;
	findings: PanelFinding[];
	missingChecks: string[];
	limitations: string[];
	provenance?: PanelReviewProvenance;
}

export interface PanelDisagreement {
	summary: string;
	reviewerIds: string[];
}

export interface PanelObjectionResolution {
	reviewerId: string;
	findingId: string;
	resolution: "resolved" | "unresolved";
	evidence: string[];
}

export interface PanelSynthesis {
	version: typeof PANEL_SYNTHESIS_VERSION;
	disposition: PanelDisposition;
	summary: string;
	validReviewerIds: string[];
	failedReviewerIds: string[];
	agreements: string[];
	disagreements: PanelDisagreement[];
	objections: PanelObjectionResolution[];
	limitations: string[];
}

const MAX_TEXT_BYTES = 8 * 1024;
const MAX_ID_BYTES = 256;
const MAX_ITEMS = 50;

export function panelReviewInstruction(reviewerId: string): string {
	return [
		"Return one JSON object and no surrounding prose.",
		`Use exactly version "${PANEL_REVIEW_VERSION}" and reviewerId "${boundedId(reviewerId)}".`,
		"Required fields are disposition, blocking, findings, missingChecks, and limitations.",
		`disposition must be one of ${PANEL_DISPOSITIONS.join(", ")}; blocking must be a JSON boolean.`,
		`Each finding must contain a unique id, severity (${PANEL_SEVERITIES.join(", ")}), title, claim, evidence as an array of strings, and optional verification as an array of strings.`,
		`Use this exact shape: {"version":"${PANEL_REVIEW_VERSION}","reviewerId":"${boundedId(reviewerId)}","disposition":"pass","blocking":false,"findings":[{"id":"F1","severity":"info","title":"title","claim":"claim","evidence":["source or check"],"verification":[]}],"missingChecks":[],"limitations":[]}.`,
		"Set blocking only for an objection that prevents a correctness, safety, security, or explicit-requirement pass.",
		"Do not infer consensus or include other reviewers' identities or outputs.",
	].join(" ");
}

export function panelSynthesisInstruction(
	reviewerIds: readonly string[],
	failedReviewerIds: readonly string[],
): string {
	return [
		"Return one JSON object and no surrounding prose.",
		`Use exactly version "${PANEL_SYNTHESIS_VERSION}".`,
		`validReviewerIds must contain exactly: ${reviewerIds.join(", ") || "none"}.`,
		`failedReviewerIds must contain exactly: ${failedReviewerIds.join(", ") || "none"}.`,
		"Required fields are disposition, summary, validReviewerIds, failedReviewerIds, agreements, disagreements, objections, and limitations.",
		`Use this exact shape: {"version":"${PANEL_SYNTHESIS_VERSION}","disposition":"pass","summary":"summary","validReviewerIds":${JSON.stringify(reviewerIds)},"failedReviewerIds":${JSON.stringify(failedReviewerIds)},"agreements":[],"disagreements":[],"objections":[],"limitations":[]}.`,
		"Preserve every blocking objection by reviewerId and findingId.",
		"A resolved objection requires concrete evidence; votes, reviewer count, and model confidence are not verification.",
	].join(" ");
}

export function parsePanelReview(
	text: string,
	expectedReviewerId: string,
	provenance: Partial<Omit<PanelReviewProvenance, "reviewerId">> = {},
): PanelReview | undefined {
	const value = parseJsonObject(text);
	if (
		!value ||
		!hasOnlyKeys(value, [
			"version",
			"reviewerId",
			"disposition",
			"blocking",
			"findings",
			"missingChecks",
			"limitations",
		]) ||
		value.version !== PANEL_REVIEW_VERSION ||
		value.reviewerId !== expectedReviewerId ||
		typeof value.disposition !== "string" ||
		!PANEL_DISPOSITIONS.includes(value.disposition as PanelDisposition) ||
		typeof value.blocking !== "boolean"
	) {
		return undefined;
	}
	const findings = objectArray(value.findings, parseFinding);
	const missingChecks = stringArray(value.missingChecks);
	const limitations = stringArray(value.limitations);
	if (!findings || !missingChecks || !limitations) return undefined;
	if (new Set(findings.map((finding) => finding.id)).size !== findings.length) return undefined;
	if (value.blocking && (findings.length === 0 || value.disposition === "pass")) return undefined;
	return {
		version: PANEL_REVIEW_VERSION,
		reviewerId: boundedId(expectedReviewerId),
		disposition: value.disposition as PanelDisposition,
		blocking: value.blocking,
		findings,
		missingChecks,
		limitations,
		provenance: {
			reviewerId: boundedId(expectedReviewerId),
			...(provenance.agent ? { agent: boundedId(provenance.agent) } : {}),
			...(provenance.model ? { model: boundedId(provenance.model) } : {}),
			taskGeneration: provenance.taskGeneration ?? 0,
		},
	};
}

export function parsePanelSynthesis(
	text: string,
	reviews: readonly PanelReview[],
	failedReviewerIds: readonly string[],
): PanelSynthesis | undefined {
	const value = parseJsonObject(text);
	if (
		!value ||
		!hasOnlyKeys(value, [
			"version",
			"disposition",
			"summary",
			"validReviewerIds",
			"failedReviewerIds",
			"agreements",
			"disagreements",
			"objections",
			"limitations",
		]) ||
		value.version !== PANEL_SYNTHESIS_VERSION ||
		typeof value.disposition !== "string" ||
		!PANEL_DISPOSITIONS.includes(value.disposition as PanelDisposition) ||
		typeof value.summary !== "string"
	) {
		return undefined;
	}
	const validReviewerIds = idArray(value.validReviewerIds);
	const parsedFailedReviewerIds = idArray(value.failedReviewerIds);
	const agreements = stringArray(value.agreements);
	const disagreements = objectArray(value.disagreements, parseDisagreement);
	const objections = objectArray(value.objections, parseObjection);
	const limitations = stringArray(value.limitations);
	if (
		!validReviewerIds ||
		!parsedFailedReviewerIds ||
		!agreements ||
		!disagreements ||
		!objections ||
		!limitations
	) {
		return undefined;
	}
	const expectedValid = reviews.map((review) => review.reviewerId);
	if (!sameIds(validReviewerIds, expectedValid)) return undefined;
	if (!sameIds(parsedFailedReviewerIds, failedReviewerIds)) return undefined;
	const validSet = new Set(expectedValid);
	if (disagreements.some((item) => item.reviewerIds.some((id) => !validSet.has(id))))
		return undefined;
	const blockers = reviews.flatMap((review) =>
		review.blocking
			? review.findings.map((finding) => `${review.reviewerId}\u0000${finding.id}`)
			: [],
	);
	const objectionKeys = objections.map((item) => `${item.reviewerId}\u0000${item.findingId}`);
	if (new Set(objectionKeys).size !== objectionKeys.length) return undefined;
	if (blockers.some((key) => !objectionKeys.includes(key))) return undefined;
	if (objections.some((item) => !validSet.has(item.reviewerId))) return undefined;
	if (objections.some((item) => item.resolution === "resolved" && item.evidence.length === 0)) {
		return undefined;
	}
	if (value.disposition === "pass" && objections.some((item) => item.resolution === "unresolved")) {
		return undefined;
	}
	return {
		version: PANEL_SYNTHESIS_VERSION,
		disposition: value.disposition as PanelDisposition,
		summary: boundedText(value.summary),
		validReviewerIds,
		failedReviewerIds: parsedFailedReviewerIds,
		agreements,
		disagreements,
		objections,
		limitations,
	};
}

function parseFinding(value: Record<string, unknown>): PanelFinding | undefined {
	if (
		!hasOnlyKeys(value, ["id", "severity", "title", "claim", "evidence", "verification"]) ||
		typeof value.id !== "string" ||
		typeof value.severity !== "string" ||
		!PANEL_SEVERITIES.includes(value.severity as PanelSeverity) ||
		typeof value.title !== "string" ||
		typeof value.claim !== "string"
	) {
		return undefined;
	}
	const id = boundedId(value.id);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) return undefined;
	const evidence = stringArray(value.evidence);
	const verification =
		value.verification === undefined ? undefined : stringArray(value.verification);
	if (!evidence || (value.verification !== undefined && !verification)) return undefined;
	return {
		id,
		severity: value.severity as PanelSeverity,
		title: boundedText(value.title),
		claim: boundedText(value.claim),
		evidence,
		...(verification ? { verification } : {}),
	};
}

function parseDisagreement(value: Record<string, unknown>): PanelDisagreement | undefined {
	if (!hasOnlyKeys(value, ["summary", "reviewerIds"]) || typeof value.summary !== "string") {
		return undefined;
	}
	const reviewerIds = idArray(value.reviewerIds);
	if (!reviewerIds || reviewerIds.length < 2) return undefined;
	return { summary: boundedText(value.summary), reviewerIds };
}

function parseObjection(value: Record<string, unknown>): PanelObjectionResolution | undefined {
	if (
		!hasOnlyKeys(value, ["reviewerId", "findingId", "resolution", "evidence"]) ||
		typeof value.reviewerId !== "string" ||
		typeof value.findingId !== "string" ||
		(value.resolution !== "resolved" && value.resolution !== "unresolved")
	) {
		return undefined;
	}
	const evidence = stringArray(value.evidence);
	if (!evidence) return undefined;
	return {
		reviewerId: boundedId(value.reviewerId),
		findingId: boundedId(value.findingId),
		resolution: value.resolution,
		evidence,
	};
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_OUTPUT_BYTES) return undefined;
	const source = text
		.trim()
		.replace(/^```(?:json)?\s*/u, "")
		.replace(/\s*```$/u, "")
		.trim();
	if (!source.startsWith("{") || !source.endsWith("}")) return undefined;
	try {
		const parsed: unknown = JSON.parse(source);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function stringArray(value: unknown): string[] | undefined {
	if (
		!Array.isArray(value) ||
		value.length > MAX_ITEMS ||
		value.some((item) => typeof item !== "string")
	) {
		return undefined;
	}
	return value.map((item) => boundedText(item as string));
}

function idArray(value: unknown): string[] | undefined {
	const values = stringArray(value)?.map(boundedId);
	if (!values || new Set(values).size !== values.length || values.some((id) => !id))
		return undefined;
	return values;
}

function objectArray<T>(
	value: unknown,
	parser: (value: Record<string, unknown>) => T | undefined,
): T[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	const parsed: T[] = [];
	for (const item of value) {
		if (!isPlainObject(item)) return undefined;
		const result = parser(item);
		if (!result) return undefined;
		parsed.push(result);
	}
	return parsed;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string): string {
	return truncateUtf8(redactPrivateText(value), MAX_TEXT_BYTES).text;
}

function boundedId(value: string): string {
	return truncateUtf8(redactPrivateText(value), MAX_ID_BYTES).text.trim();
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((id) => expected.includes(id));
}
