import type { SingleResult } from "./runner.js";

export const PANEL_FAILURE_KINDS = [
	"transient-launch",
	"transient-transport",
	"invalid-contract",
	"semantic-stall",
	"permission-denied",
	"budget-exhausted",
	"cancelled",
	"task-failed",
] as const;

export type PanelFailureKind = (typeof PANEL_FAILURE_KINDS)[number];

export interface PanelFailure {
	reviewerId?: string;
	kind: PanelFailureKind;
	retryable: boolean;
	message?: string;
}

export function classifyPanelFailure(
	result: Partial<
		Pick<
			SingleResult,
			| "launchFailed"
			| "resultContractInvalid"
			| "stopReason"
			| "timedOut"
			| "aborted"
			| "errorMessage"
			| "stderr"
			| "termination"
		>
	>,
): Omit<PanelFailure, "reviewerId" | "message"> {
	if (result.launchFailed) return { kind: "transient-launch", retryable: true };
	if (result.resultContractInvalid) return { kind: "invalid-contract", retryable: false };
	if (result.stopReason === "semantic-stall" || result.termination?.reason === "idle_timeout") {
		return { kind: "semantic-stall", retryable: false };
	}
	if (result.aborted || result.stopReason === "aborted")
		return { kind: "cancelled", retryable: false };
	if (result.timedOut || result.stopReason === "timeout") {
		return { kind: "budget-exhausted", retryable: false };
	}
	const message = `${result.errorMessage ?? ""}\n${result.stderr ?? ""}`;
	if (/permission|denied|not allowed|unauthori[sz]ed/iu.test(message)) {
		return { kind: "permission-denied", retryable: false };
	}
	if (/transport|socket|connection reset|temporar|econnreset|eai_again/iu.test(message)) {
		return { kind: "transient-transport", retryable: true };
	}
	return { kind: "task-failed", retryable: false };
}
