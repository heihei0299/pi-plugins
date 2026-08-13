import type { PanelReview } from "./panel-contract.js";

const MAX_PANEL_EVIDENCE_BYTES = 24 * 1024;
export interface PanelEvidenceArtifact {
	panelId: string;
	reviewerId: string;
	revision: number;
	review: PanelReview;
}

export class PanelEvidenceLedger {
	private readonly latestByReviewer = new Map<string, PanelEvidenceArtifact>();

	constructor(
		private readonly panelId: string,
		private readonly maxArtifacts: number,
	) {}

	publish(review: PanelReview, revision: number): boolean {
		if (!Number.isSafeInteger(revision) || revision < 1) return false;
		const current = this.latestByReviewer.get(review.reviewerId);
		if (
			current &&
			current.review.provenance?.taskGeneration !== review.provenance?.taskGeneration
		) {
			return false;
		}
		if ((!current && revision !== 1) || (current && revision !== current.revision + 1))
			return false;
		if (!current && this.latestByReviewer.size >= this.maxArtifacts) return false;
		const artifact = {
			panelId: this.panelId,
			reviewerId: review.reviewerId,
			revision,
			review: structuredClone(review),
		};
		const candidate = [
			...[...this.latestByReviewer.values()].filter(
				(item) => item.reviewerId !== review.reviewerId,
			),
			artifact,
		];
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_PANEL_EVIDENCE_BYTES)
			return false;
		this.latestByReviewer.set(review.reviewerId, artifact);
		return true;
	}

	latest(reviewerId: string): PanelEvidenceArtifact | undefined {
		const artifact = this.latestByReviewer.get(reviewerId);
		return artifact ? structuredClone(artifact) : undefined;
	}

	snapshot(): PanelEvidenceArtifact[] {
		return [...this.latestByReviewer.values()]
			.sort((left, right) => left.reviewerId.localeCompare(right.reviewerId))
			.map((artifact) => structuredClone(artifact));
	}
}
