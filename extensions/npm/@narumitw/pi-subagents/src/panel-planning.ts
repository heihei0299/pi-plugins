import type { AgentConfig } from "./agents/types.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import { type WorkItemDefinition, WorkItemLedger } from "./work-item-ledger.js";

export const PANEL_PRESETS = ["code-review", "research", "security-review", "custom"] as const;
export type PanelPreset = (typeof PANEL_PRESETS)[number];

export interface PanelReviewerRequest {
	id: string;
	agent: string;
	focus?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	maxTurns?: number;
	maxToolCalls?: number;
	thinkingLevel?: string;
}

export interface PanelSynthesizerRequest {
	agent: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	maxTurns?: number;
	maxToolCalls?: number;
	thinkingLevel?: string;
}

export interface PanelRequestLike {
	id?: string;
	preset?: PanelPreset;
	task: string;
	context?: string;
	reviewers: PanelReviewerRequest[];
	synthesizer: PanelSynthesizerRequest;
	minValidReviews?: number;
}

export interface PanelPhaseBudgets {
	totalMs: number;
	reviewMs: number;
	finalizationMs: number;
	synthesisMs: number;
	cleanupMs: number;
	reviewerTimeoutMs: number;
}

const MIN_PHASE_MS = 1;
const MAX_ID_BYTES = 256;
const MAX_FOCUS_BYTES = 8 * 1024;

export function planPanelBudgets(totalMs: number, _reviewerCount: number): PanelPhaseBudgets {
	const normalized = Math.floor(totalMs);
	if (!Number.isSafeInteger(normalized) || normalized < 4 * MIN_PHASE_MS) {
		throw new Error(
			"Panel total timeout is too small to reserve review, finalization, synthesis, and cleanup phases",
		);
	}
	const cleanupMs = Math.max(MIN_PHASE_MS, Math.floor(normalized * 0.05));
	const synthesisMs = Math.max(MIN_PHASE_MS, Math.floor(normalized * 0.2));
	const finalizationMs = Math.max(MIN_PHASE_MS, Math.floor(normalized * 0.1));
	const reviewMs = normalized - cleanupMs - synthesisMs - finalizationMs;
	if (reviewMs < MIN_PHASE_MS) {
		throw new Error("Panel total timeout is too small for the review phase");
	}
	return {
		totalMs: normalized,
		reviewMs,
		finalizationMs,
		synthesisMs,
		cleanupMs,
		reviewerTimeoutMs: reviewMs,
	};
}

export function createPanelWorkLedger(
	panelId: string,
	panel: PanelRequestLike,
	agents: readonly AgentConfig[],
): WorkItemLedger {
	const taskPreview = truncateUtf8(panel.task, 256).text;
	const reviewerItems: WorkItemDefinition[] = panel.reviewers.map((reviewer) => {
		const agent = agents.find((candidate) => candidate.name === reviewer.agent);
		return {
			id: `review:${reviewer.id}`,
			objective: `Panel review ${reviewer.id}: ${taskPreview}`,
			dependencies: [],
			inputArtifacts: [],
			inputArtifactVersions: {},
			requiredCapabilities: ["independent-review"],
			requiredTools: [],
			selectedAgentName: reviewer.agent,
			sideEffectPolicy:
				agent?.capabilityManifest?.authority?.filesystem === "read" ? "read-only" : "mutating",
			readPaths: [],
			writePaths: [],
			ownershipKeys: [],
			acceptanceCriteria: ["Return one valid panel-review:v1 evidence artifact"],
		};
	});
	return WorkItemLedger.create({
		workflowId: panelId,
		items: [
			...reviewerItems,
			{
				id: "synthesis",
				objective: "Reconcile valid panel evidence while preserving objections and dissent",
				dependencies: reviewerItems.map((item) => item.id),
				dependencyPolicy: "settled",
				inputArtifacts: [],
				inputArtifactVersions: {},
				requiredCapabilities: ["evidence-review"],
				requiredTools: [],
				selectedAgentName: panel.synthesizer.agent,
				sideEffectPolicy: "read-only",
				readPaths: [],
				writePaths: [],
				ownershipKeys: [],
				acceptanceCriteria: [
					"Preserve every blocking objection and disagreement with evidence-backed resolution state",
				],
				integrationOwner: true,
			},
		],
	});
}

export function validatePanelRequest(panel: PanelRequestLike, maxReviewers = 64): void {
	if (
		panel.id !== undefined &&
		(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(panel.id) ||
			Buffer.byteLength(panel.id, "utf8") > MAX_ID_BYTES)
	) {
		throw new Error("Panel id must use 1-256 safe identifier bytes");
	}
	if (!panel.task.trim()) throw new Error("Panel task must not be empty");
	if (Buffer.byteLength(panel.task, "utf8") > DEFAULT_MAX_CONTEXT_BYTES) {
		throw new Error("Panel task exceeds the bounded context limit");
	}
	if (panel.context && Buffer.byteLength(panel.context, "utf8") > DEFAULT_MAX_CONTEXT_BYTES) {
		throw new Error("Panel shared context exceeds the bounded context limit");
	}
	if (panel.reviewers.length < 2) throw new Error("Panel mode requires at least two reviewers");
	if (panel.reviewers.length > maxReviewers) {
		throw new Error(
			`Panel has too many reviewers (${panel.reviewers.length}); configured max is ${maxReviewers}`,
		);
	}
	const ids = panel.reviewers.map((reviewer) => reviewer.id.trim());
	if (
		ids.some(
			(id) =>
				!id ||
				Buffer.byteLength(id, "utf8") > MAX_ID_BYTES ||
				!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id),
		)
	) {
		throw new Error("Panel reviewer ids must use 1-256 safe identifier bytes");
	}
	if (new Set(ids).size !== ids.length) throw new Error("Panel reviewer ids must be unique");
	if (panel.reviewers.some((reviewer) => !reviewer.agent.trim())) {
		throw new Error("Every panel reviewer must name an agent");
	}
	if (
		panel.reviewers.some(
			(reviewer) => reviewer.focus && Buffer.byteLength(reviewer.focus, "utf8") > MAX_FOCUS_BYTES,
		)
	) {
		throw new Error("Panel reviewer focus exceeds the bounded field limit");
	}
	if (!panel.synthesizer.agent.trim()) throw new Error("Panel synthesizer must name an agent");
	const minValid = panel.minValidReviews ?? 2;
	if (!Number.isInteger(minValid) || minValid < 2 || minValid > panel.reviewers.length) {
		throw new Error("minValidReviews must be between two and the reviewer count");
	}
}
