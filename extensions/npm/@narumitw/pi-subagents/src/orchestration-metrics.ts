import type { SingleResult } from "./runner.js";
import type { WorkItemLedgerSnapshot } from "./work-item-ledger.js";

export interface OrchestrationMetrics {
	workItems: number;
	completed: number;
	failedOrBlocked: number;
	invalidated: number;
	requiredTransfers: number;
	resolvedTransfers: number;
	transferCoverage: number;
	attempts: number;
	hedgedTasks: number;
	requestedTools: number;
	effectiveRequestedTools: number;
	permissionPrecision: number;
	workerReportedVerification: number;
	executorAcceptedVerification: number;
	verificationRework: number;
	verificationRejected: number;
	verificationInvalid: number;
	verificationTreeMismatch: number;
	panelValidReviews?: number;
	panelFailedReviews?: number;
	panelBlockingObjections?: number;
	panelDissent?: number;
	panelSynthesisState?: string;
}

export function calculateOrchestrationMetrics(
	workflow: WorkItemLedgerSnapshot | undefined,
	results: SingleResult[],
	panel?: {
		validReviewCount: number;
		failedReviewCount: number;
		blockingObjectionCount: number;
		dissentCount: number;
		state: string;
	},
): OrchestrationMetrics {
	const items = workflow?.items ?? [];
	const requiredTransfers = items.reduce((sum, item) => sum + item.inputArtifacts.length, 0);
	const resolvedTransfers = items.reduce(
		(sum, item) => sum + Object.keys(item.inputArtifactVersions).length,
		0,
	);
	const requestedTools = results.reduce(
		(sum, result) => sum + (result.executionPlan?.requestedTools.length ?? 0),
		0,
	);
	const effectiveRequestedTools = results.reduce((sum, result) => {
		const plan = result.executionPlan;
		if (!plan) return sum;
		return (
			sum +
			plan.requestedTools.filter((tool) => plan.effectiveTools?.includes(tool) === true).length
		);
	}, 0);
	return {
		workItems: items.length,
		completed: items.filter((item) => item.state === "completed").length,
		failedOrBlocked: items.filter((item) =>
			["failed", "blocked", "needs-input", "interrupted"].includes(item.state),
		).length,
		invalidated: items.filter((item) => ["stale", "invalidated"].includes(item.state)).length,
		requiredTransfers,
		resolvedTransfers,
		transferCoverage: requiredTransfers === 0 ? 1 : resolvedTransfers / requiredTransfers,
		attempts: results.reduce((sum, result) => sum + (result.attemptCount ?? 1), 0),
		hedgedTasks: results.filter((result) => result.hedged).length,
		requestedTools,
		effectiveRequestedTools,
		permissionPrecision: requestedTools === 0 ? 1 : effectiveRequestedTools / requestedTools,
		workerReportedVerification: results.filter(
			(result, index) =>
				!items[index]?.verifierFor &&
				result.structuredResult?.version === "pi-subagents:result:v2" &&
				result.structuredResult.verification.some(
					(verification) => verification.status === "passed",
				),
		).length,
		executorAcceptedVerification: items.filter((item) => item.verificationAccepted).length,
		verificationRework: items.filter(
			(item) =>
				!item.verifierFor &&
				(item.verificationReceipt?.decision === "rework" ||
					item.acceptanceReceiptHistory.some((receipt) => receipt.decision === "rework")),
		).length,
		verificationRejected: items.filter(
			(item) =>
				!item.verifierFor &&
				(item.verificationReceipt?.decision === "reject" || item.acceptanceState === "rejected"),
		).length,
		verificationInvalid: items.filter(
			(item) => !item.verifierFor && item.outcomeReason === "verification-receipt-invalid",
		).length,
		verificationTreeMismatch: items.filter(
			(item) =>
				!item.verifierFor &&
				[
					"verification-tree-mismatch",
					"verification-tree-unavailable",
					"verification-tree-drift",
				].includes(item.outcomeReason ?? ""),
		).length,
		...(panel
			? {
					panelValidReviews: panel.validReviewCount,
					panelFailedReviews: panel.failedReviewCount,
					panelBlockingObjections: panel.blockingObjectionCount,
					panelDissent: panel.dissentCount,
					panelSynthesisState: panel.state,
				}
			: {}),
	};
}
