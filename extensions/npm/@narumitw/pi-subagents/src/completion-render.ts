import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { MAX_TOOL_MESSAGE_BYTES } from "./limits.js";
import {
	COLLAPSED_LIST_LIMIT,
	expansionHint,
	type RenderStatus,
	recordList,
	recordValue,
	safeBlock,
	safeLine,
	statusBadge,
} from "./render-common.js";

export const SUBAGENT_COMPLETION_MESSAGE_TYPE = "pi-subagent-completion";

export const renderCompletionMessage: MessageRenderer = (message, options, theme) => {
	const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
	if (options.expanded) {
		box.addChild(
			new ExactText(
				theme.fg("customMessageLabel", theme.bold(`[${SUBAGENT_COMPLETION_MESSAGE_TYPE}]`)),
			),
		);
		box.addChild(new Spacer(1));
		box.addChild(
			new ExactText(
				safeBlock(messageText(message.content), "(no completion content)", MAX_TOOL_MESSAGE_BYTES),
				(text) => theme.fg("customMessageText", text),
			),
		);
		return box;
	}

	box.addChild(new ExactText(collapsedCompletion(message.content, message.details, theme)));
	return box;
};

function collapsedCompletion(contentValue: unknown, detailsValue: unknown, theme: Theme): string {
	const content = safeBlock(messageText(contentValue), "", MAX_TOOL_MESSAGE_BYTES);
	const details = recordValue(detailsValue) ?? {};
	const completions = recordList(details.completions);
	if (completions.length > 0 || details.completionCount !== undefined) {
		return collapsedBatch(details, completions, theme);
	}
	return collapsedSingle(content, details, theme);
}

function collapsedSingle(content: string, details: Record<string, unknown>, theme: Theme): string {
	const agent = optionalLine(details.agent) || extractedField(content, "Agent") || "subagent";
	const state = optionalLine(details.state) || extractedField(content, "State") || "completed";
	const task = optionalLine(details.task) || extractedField(content, "Task");
	const payload = payloadPreview(content);
	const lines = [
		`${statusBadge(theme, renderStatus(state))}${theme.fg("muted", " · ")}${theme.fg("customMessageLabel", theme.bold(agent))}`,
	];
	if (task) lines.push(`${theme.fg("muted", "Task: ")}${theme.fg("customMessageText", task)}`);
	if (payload) {
		lines.push(`${theme.fg("muted", "Payload: ")}${theme.fg("customMessageText", payload)}`);
	}
	lines.push(expansionHint());
	return lines.join("\n");
}

function collapsedBatch(
	details: Record<string, unknown>,
	completions: Record<string, unknown>[],
	theme: Theme,
): string {
	const declaredCount =
		typeof details.completionCount === "number" && Number.isFinite(details.completionCount)
			? Math.max(0, Math.floor(details.completionCount))
			: completions.length;
	const count = Math.max(declaredCount, completions.length);
	const statuses = completions.map((completion) => renderStatus(optionalLine(completion.state)));
	const icon = statuses.includes("failed")
		? theme.fg("error", "✗")
		: statuses.some((status) => status !== "completed" && status !== "closed")
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const lines = [
		`${icon} ${theme.fg("customMessageLabel", theme.bold(`${count} subagent completions`))}`,
	];
	for (const completion of completions.slice(0, COLLAPSED_LIST_LIMIT)) {
		const agent = optionalLine(completion.agent) || "subagent";
		const state = optionalLine(completion.state) || "completed";
		const task = optionalLine(completion.task);
		lines.push(
			`${theme.fg("muted", "• ")}${theme.fg("accent", agent)} · ${statusBadge(theme, renderStatus(state))}${task ? theme.fg("dim", ` — ${task}`) : ""}`,
		);
	}
	const visibleCount = Math.min(completions.length, COLLAPSED_LIST_LIMIT);
	if (count > visibleCount) {
		lines.push(theme.fg("muted", `… ${count - visibleCount} more`));
	}
	lines.push(expansionHint());
	return lines.join("\n");
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((part) => {
			const record = recordValue(part);
			return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join("\n");
}

function extractedField(content: string, label: string): string {
	const prefix = `${label}:`;
	const line = content.split("\n").find((candidate) => candidate.startsWith(prefix));
	return line ? safeLine(line.slice(prefix.length), "", 512) : "";
}

function payloadPreview(content: string): string {
	const marker = "\nPayload:\n";
	const start = content.indexOf(marker);
	if (start < 0) return "";
	for (const line of content.slice(start + marker.length).split("\n")) {
		const preview = safeLine(line, "", 1024);
		if (preview) return preview;
	}
	return "";
}

function optionalLine(value: unknown): string {
	return typeof value === "string" ? safeLine(value, "", 512) : "";
}

function renderStatus(state: string): RenderStatus {
	switch (state) {
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		case "closed":
			return "closed";
		case "blocked":
		case "needs-input":
		case "abstained":
		case "stale":
			return "warning";
		default:
			return "completed";
	}
}

class ExactText implements Component {
	constructor(
		private readonly value: string,
		private readonly style: (text: string) => string = (text) => text,
	) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return this.value
			.split("\n")
			.flatMap((line) => hardWrapExact(line, safeWidth))
			.map(this.style);
	}

	invalidate(): void {}
}

function hardWrapExact(value: string, width: number): string[] {
	if (value.length === 0) return [""];
	const columns = visibleWidth(value);
	if (columns === 0) return [value];
	const lines: string[] = [];
	let column = 0;
	while (column < columns) {
		const chunk = sliceByColumn(value, column, width, true);
		const chunkWidth = visibleWidth(chunk);
		if (chunkWidth > 0) {
			lines.push(chunk);
			column += chunkWidth;
			continue;
		}
		const oversized = sliceByColumn(value, column, width, false);
		const oversizedWidth = visibleWidth(oversized);
		lines.push("?".repeat(width));
		column += Math.max(1, oversizedWidth);
	}
	return lines;
}
