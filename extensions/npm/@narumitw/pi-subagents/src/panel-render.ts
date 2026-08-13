import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentParams } from "./params.js";
import { safeBlock, safeLine } from "./render-common.js";
import type { SubagentDetails } from "./runner.js";

export function renderPanelCall(args: SubagentParams, theme: Theme): Text | undefined {
	const panel = args.panel;
	if (!panel) return undefined;
	const scope = args.agentScope ?? "user";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `panel ${panel.preset ?? "custom"} (${panel.reviewers.length} reviewers)`) +
		theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview(panel.task, 80))}`;
	for (const reviewer of panel.reviewers.slice(0, 3)) {
		text += `\n  ${theme.fg("muted", `${safeLine(reviewer.id, "reviewer", 256)}:`)} ${theme.fg("accent", safeLine(reviewer.agent, "agent", 256))}`;
		if (reviewer.focus) text += theme.fg("dim", ` ${preview(reviewer.focus, 40)}`);
	}
	if (panel.reviewers.length > 3) {
		text += `\n  ${theme.fg("muted", `... +${panel.reviewers.length - 3} more`)}`;
	}
	text += `\n  ${theme.fg("muted", "synthesis → ")}${theme.fg("accent", safeLine(panel.synthesizer.agent, "agent", 256))}`;
	return new Text(text, 0, 0);
}

export function renderPanelResult(
	details: SubagentDetails,
	expanded: boolean,
	isPartial: boolean,
	theme: Theme,
): Text | undefined {
	const panel = details.panel;
	if (details.mode !== "panel" || !panel) return undefined;
	const running = isPartial || panel.state === "running";
	const status = running ? "running" : panel.state;
	const color =
		status === "completed"
			? "success"
			: status === "running" || status === "degraded"
				? "warning"
				: "error";
	let text = `${theme.fg(color, status)} ${theme.fg("accent", safeLine(panel.preset, "panel", 128))}`;
	text += theme.fg(
		"muted",
		` · valid ${panel.validReviewCount}/${panel.reviewerIds.length} · failed ${panel.failedReviewCount} · blockers ${panel.blockingObjectionCount} · dissent ${panel.dissentCount}`,
	);
	if (panel.synthesis) {
		text += `\n${theme.fg("toolOutput", safeBlock(panel.synthesis.summary, "", 8 * 1024))}`;
	} else if (panel.state === "insufficient-panel") {
		text += `\n${theme.fg("warning", "Synthesis skipped because too few valid reviews remained.")}`;
	}
	if (!expanded) return new Text(text, 0, 0);

	text += `\n\n${theme.fg("muted", "Shared task: ")}${theme.fg("dim", safeBlock(panel.sharedTaskPreview, "", 2 * 1024))}`;
	text += `\n\n${theme.fg("muted", "Reviewers:")}`;
	for (const reviewerId of panel.reviewerIds) {
		const artifact = panel.evidence.find((candidate) => candidate.reviewerId === reviewerId);
		const failure = panel.failures.find((candidate) => candidate.reviewerId === reviewerId);
		const result = details.results.find(
			(candidate) => candidate.step === panel.reviewerIds.indexOf(reviewerId) + 1,
		);
		const model = result?.actualModel ?? result?.model;
		text += `\n  ${theme.fg("accent", safeLine(reviewerId, "reviewer", 256))}`;
		if (model) text += theme.fg("muted", ` · ${safeLine(model, "", 256)}`);
		if (artifact) {
			text += theme.fg(
				"muted",
				` · ${artifact.review.disposition} · revision ${artifact.revision}`,
			);
			for (const finding of artifact.review.findings) {
				text += `\n    ${theme.fg(finding.severity === "critical" || finding.severity === "high" ? "error" : "warning", `[${finding.severity}]`)} ${safeLine(finding.title, "finding", 512)}`;
			}
		} else if (failure) {
			text += theme.fg("error", ` · ${safeLine(failure.kind, "failed", 128)}`);
		}
	}
	if (panel.synthesis?.disagreements.length) {
		text += `\n\n${theme.fg("muted", "Disagreements:")}`;
		for (const disagreement of panel.synthesis.disagreements) {
			text += `\n  ${safeLine(disagreement.summary, "disagreement", 1024)}`;
		}
	}
	if (panel.synthesis?.objections.length) {
		text += `\n\n${theme.fg("muted", "Blocking objections:")}`;
		for (const objection of panel.synthesis.objections) {
			text += `\n  ${safeLine(`${objection.reviewerId}/${objection.findingId}: ${objection.resolution}`, "objection", 1024)}`;
		}
	}
	const limitations = panel.synthesis?.limitations ?? [];
	if (limitations.length) {
		text += `\n\n${theme.fg("muted", "Limitations:")}`;
		for (const limitation of limitations) text += `\n  ${safeLine(limitation, "", 1024)}`;
	}
	text += `\n\n${theme.fg("muted", `Budget: review ${panel.budgets.reviewMs}ms · finalization ${panel.budgets.finalizationMs}ms · synthesis ${panel.budgets.synthesisMs}ms · cleanup ${panel.budgets.cleanupMs}ms`)}`;
	text += `\n${theme.fg("muted", `Cleanup: ${panel.cleanupComplete ? "complete" : "pending"}`)}`;
	return new Text(text, 0, 0);
}

function preview(value: unknown, maxLength: number): string {
	const text = safeLine(value, "", 2 * 1024);
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
