import type { SubagentOutcomeStatus } from "./result-contract.js";

export interface ClassifiedSubagentOutcome {
	status: SubagentOutcomeStatus;
	reasonCode?: string;
	recoveryActions: string[];
	retryable: boolean;
}

const TRANSIENT_REASONS = new Set(["transient-transport", "transient-tool"]);

export function classifyStructuredOutcome(
	status: SubagentOutcomeStatus,
	reasonCode?: string,
): ClassifiedSubagentOutcome {
	if (TRANSIENT_REASONS.has(reasonCode ?? "") && status === "failed") {
		return {
			status,
			...(reasonCode ? { reasonCode } : {}),
			recoveryActions: ["retry"],
			retryable: true,
		};
	}
	const recoveryActions = recoveryFor(status, reasonCode);
	return {
		status,
		...(reasonCode ? { reasonCode } : {}),
		recoveryActions,
		retryable: false,
	};
}

function recoveryFor(status: SubagentOutcomeStatus, reasonCode?: string): string[] {
	if (reasonCode === "missing-dependency" || reasonCode === "missing-context") {
		return ["supply-input"];
	}
	if (reasonCode === "ambiguous-task") return ["clarify"];
	if (reasonCode === "capability-mismatch" || reasonCode === "authority-missing") {
		return ["reroute"];
	}
	if (reasonCode === "dependency-superseded" || status === "stale") return ["revalidate"];
	if (reasonCode === "verification-failed") return ["replan", "verify"];
	if (reasonCode === "unsupported-guarantee") return ["stop"];
	switch (status) {
		case "completed":
		case "partial":
			return [];
		case "needs-input":
			return ["supply-input"];
		case "blocked":
			return ["clarify"];
		case "abstained":
			return ["reroute"];
		case "contract-invalid":
			return ["repair-contract"];
		case "interrupted":
			return ["stop"];
		case "failed":
			return ["stop"];
	}
}
