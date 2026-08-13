import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import {
	type PanelReview,
	panelReviewInstruction,
	panelSynthesisInstruction,
} from "./panel-contract.js";
import type { PanelFailure } from "./panel-failure.js";
import type { PanelPreset } from "./panel-planning.js";

const PRESET_GUIDANCE: Record<PanelPreset, string> = {
	"code-review":
		"Review correctness, regressions, baseline security, maintainability, tests, and integration risk.",
	research:
		"Assess source quality, evidence traceability, contradictory evidence, uncertainty, and unsupported claims.",
	"security-review":
		"Review trust boundaries, authority, injection, data exposure, unsafe side effects, and missing mitigations.",
	custom: "Apply the shared task and your assigned focus without inventing unstated requirements.",
};

const PROMPT_SEPARATOR = "\n\n";
const MAX_REVIEWER_SUFFIX_BYTES = 12 * 1024;
const REVIEWER_SHARED_BYTES = DEFAULT_MAX_CONTEXT_BYTES - MAX_REVIEWER_SUFFIX_BYTES;

export function buildPanelReviewerPrompt(input: {
	panelId: string;
	preset: PanelPreset;
	task: string;
	context?: string;
	reviewerId: string;
	focus?: string;
}): string {
	const shared = buildReviewerSharedBlock(input);
	const reviewer = [
		`Reviewer id: ${input.reviewerId}`,
		input.focus ? `Reviewer focus:\n${input.focus}` : undefined,
		"Work independently and do not assume another reviewer will catch or resolve a problem.",
		`Panel review contract:\n${panelReviewInstruction(input.reviewerId)}`,
	]
		.filter((part): part is string => Boolean(part))
		.join(PROMPT_SEPARATOR);
	return joinWithRequiredSuffix(shared, reviewer);
}

export function buildPanelSynthesisPrompt(input: {
	panelId: string;
	task: string;
	reviews: readonly PanelReview[];
	failures: readonly PanelFailure[];
}): string {
	const validIds = input.reviews.map((review) => review.reviewerId);
	const failedIds = input.failures
		.map((failure) => failure.reviewerId)
		.filter((id): id is string => Boolean(id));
	const artifacts = input.reviews.map((review) => ({
		reviewerId: review.reviewerId,
		disposition: review.disposition,
		blocking: review.blocking,
		findings: review.findings,
		missingChecks: review.missingChecks,
		limitations: review.limitations,
		provenance: review.provenance,
	}));
	const requiredSuffix = [
		"Reconcile evidence without majority voting and without erasing dissent.",
		`Panel synthesis contract:\n${panelSynthesisInstruction(validIds, failedIds)}`,
	].join(PROMPT_SEPARATOR);
	const fixedPrefixParts = [
		`Panel: ${input.panelId}`,
		"Shared task:\n",
		`Panel evidence artifacts:\n${JSON.stringify(artifacts)}`,
		`Failed or invalid reviewers:\n${JSON.stringify(input.failures)}`,
	];
	const taskBudget = Math.max(
		0,
		DEFAULT_MAX_CONTEXT_BYTES -
			byteLength(fixedPrefixParts.join(PROMPT_SEPARATOR)) -
			byteLength(PROMPT_SEPARATOR) -
			byteLength(requiredSuffix),
	);
	const prefix = [
		fixedPrefixParts[0],
		`Shared task:\n${truncateUtf8(input.task, taskBudget).text}`,
		fixedPrefixParts[2],
		fixedPrefixParts[3],
	].join(PROMPT_SEPARATOR);
	return joinWithRequiredSuffix(prefix, requiredSuffix);
}

function buildReviewerSharedBlock(input: {
	panelId: string;
	preset: PanelPreset;
	task: string;
	context?: string;
}): string {
	const context = input.context || undefined;
	const hasContext = context !== undefined;
	const fixedParts = [
		`Panel: ${input.panelId}`,
		`Preset: ${input.preset}`,
		"Shared task:\n",
		hasContext ? "Shared context:\n" : undefined,
		`Preset guidance:\n${PRESET_GUIDANCE[input.preset]}`,
	].filter((part): part is string => part !== undefined);
	const contentBudget = Math.max(
		0,
		REVIEWER_SHARED_BYTES - byteLength(fixedParts.join(PROMPT_SEPARATOR)),
	);
	const taskBudget = hasContext ? Math.floor(contentBudget / 2) : contentBudget;
	const contextBudget = contentBudget - taskBudget;
	return [
		fixedParts[0],
		fixedParts[1],
		`Shared task:\n${truncateUtf8(input.task, taskBudget).text}`,
		hasContext ? `Shared context:\n${truncateUtf8(context, contextBudget).text}` : undefined,
		fixedParts.at(-1),
	]
		.filter((part): part is string => part !== undefined)
		.join(PROMPT_SEPARATOR);
}

function joinWithRequiredSuffix(prefix: string, suffix: string): string {
	const suffixBytes = byteLength(PROMPT_SEPARATOR) + byteLength(suffix);
	if (suffixBytes > DEFAULT_MAX_CONTEXT_BYTES) {
		throw new Error("Panel prompt contract exceeds the bounded context limit");
	}
	const boundedPrefix = truncateUtf8(prefix, DEFAULT_MAX_CONTEXT_BYTES - suffixBytes).text;
	return `${boundedPrefix}${PROMPT_SEPARATOR}${suffix}`;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
