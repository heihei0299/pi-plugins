import type { PanelFinding, PanelReview } from "./panel-contract.js";
import type { PanelFailure } from "./panel-failure.js";

export interface PanelBlockingObjection {
	reviewerId: string;
	finding: PanelFinding;
}

export type PanelReconciliation =
	| {
			kind: "ready-for-synthesis";
			reviews: PanelReview[];
			failures: PanelFailure[];
			blockingObjections: PanelBlockingObjection[];
			verified: false;
	  }
	| {
			kind: "insufficient-panel";
			partialReviews: PanelReview[];
			failures: PanelFailure[];
			blockingObjections: PanelBlockingObjection[];
			consensus: false;
	  };

export function reconcilePanel(input: {
	reviews: PanelReview[];
	failures: PanelFailure[];
	minValidReviews: number;
}): PanelReconciliation {
	const reviews = [...input.reviews].sort((left, right) =>
		left.reviewerId.localeCompare(right.reviewerId),
	);
	const failures = [...input.failures].sort((left, right) =>
		(left.reviewerId ?? "").localeCompare(right.reviewerId ?? ""),
	);
	const blockingObjections = reviews.flatMap((review) =>
		review.blocking
			? review.findings.map((finding) => ({ reviewerId: review.reviewerId, finding }))
			: [],
	);
	if (reviews.length < input.minValidReviews) {
		return {
			kind: "insufficient-panel",
			partialReviews: reviews,
			failures,
			blockingObjections,
			consensus: false,
		};
	}
	return {
		kind: "ready-for-synthesis",
		reviews,
		failures,
		blockingObjections,
		verified: false,
	};
}
