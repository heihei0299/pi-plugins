import type { SingleResult } from "./runner.js";
import {
	formatResultFailure as formatBaseResultFailure,
	getResultFinalOutput as getBaseResultFinalOutput,
	isResultError as isBaseResultError,
} from "./runner-result.js";

export function getResultFinalOutput(result: SingleResult): string {
	return getBaseResultFinalOutput(result);
}

export function isResultError(result: SingleResult): boolean {
	return (
		isBaseResultError(result) ||
		result.resultContractInvalid === true ||
		(result.outcome !== undefined &&
			result.outcome.status !== "completed" &&
			result.outcome.status !== "partial")
	);
}

export function formatResultFailure(result: SingleResult): string {
	const contractError = result.resultContractInvalid
		? `Subagent returned an invalid ${result.resultFormat ?? "structured"} result contract`
		: result.outcome && !["completed", "partial"].includes(result.outcome.status)
			? `Subagent outcome ${result.outcome.status}${result.outcome.reasonCode ? ` (${result.outcome.reasonCode})` : ""}; recovery: ${result.outcome.recoveryActions.join(", ") || "none"}`
			: undefined;
	return contractError
		? formatBaseResultFailure({ ...result, errorMessage: contractError })
		: formatBaseResultFailure(result);
}
