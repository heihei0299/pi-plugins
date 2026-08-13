export const DELEGATION_ADMISSION_VERSION = "pi-subagents:admission:v1" as const;

export type DelegationAdmissionRecommendation =
	| "parent-owned-direct"
	| "one-child"
	| "one-child-plus-verification"
	| "bounded-two-child"
	| "abstain-insufficient-evidence";

export interface DelegationAdmissionInput {
	contextPressure: "low" | "medium" | "high";
	independentWorkItems: number;
	coupling: "dense" | "sparse";
	verificationRequired: boolean;
	verificationAvailable: boolean;
	capabilitiesSupported: boolean;
	budgetAllowsChildren: boolean;
	generationCurrent: boolean;
	requirementsComplete: boolean;
}

export interface DelegationAdmissionDecision {
	version: typeof DELEGATION_ADMISSION_VERSION;
	recommendation: DelegationAdmissionRecommendation;
	reasonCodes: string[];
	benefitHypothesis: string;
	auditOnly: true;
}

export function evaluateDelegationAdmission(
	input: DelegationAdmissionInput,
): DelegationAdmissionDecision {
	if (!input.generationCurrent)
		return decision("abstain-insufficient-evidence", ["stale-generation"]);
	if (!input.requirementsComplete) {
		return decision("abstain-insufficient-evidence", ["requirements-incomplete"]);
	}
	if (!input.capabilitiesSupported) {
		return decision("abstain-insufficient-evidence", ["capability-unsupported"]);
	}
	if (!input.budgetAllowsChildren) {
		return decision("parent-owned-direct", ["child-budget-insufficient"]);
	}
	if (input.independentWorkItems >= 2 && input.coupling === "sparse") {
		return decision(
			"bounded-two-child",
			["declared-independent-work"],
			"parallel-critical-path-reduction",
		);
	}
	if (input.verificationRequired) {
		return input.verificationAvailable
			? decision(
					"one-child-plus-verification",
					["independent-verification-required"],
					"independent-error-detection",
				)
			: decision("abstain-insufficient-evidence", ["verification-unavailable"]);
	}
	if (input.contextPressure === "high") {
		return decision("one-child", ["declared-context-pressure"], "context-isolation");
	}
	return decision("parent-owned-direct", ["delegation-benefit-not-established"]);
}

function decision(
	recommendation: DelegationAdmissionRecommendation,
	reasonCodes: string[],
	benefitHypothesis = "none",
): DelegationAdmissionDecision {
	return {
		version: DELEGATION_ADMISSION_VERSION,
		recommendation,
		reasonCodes,
		benefitHypothesis,
		auditOnly: true,
	};
}
