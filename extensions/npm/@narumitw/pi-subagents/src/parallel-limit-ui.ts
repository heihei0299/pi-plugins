import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MAX_BLOCKING_PARALLEL_CONCURRENCY, MAX_CONFIGURABLE_PARALLEL_TASKS } from "./limits.js";
import {
	inspectBlockingParallelLimitSettings,
	updateBlockingMaxParallelTasksSetting,
} from "./settings.js";

export interface BlockingParallelLimitRuntime {
	getMaxParallelTasks(): number;
	setMaxParallelTasks(value: number): void;
}

export function blockingParallelLimitScreen(runtime: BlockingParallelLimitRuntime) {
	const limit = inspectBlockingParallelLimitSettings();
	return {
		kind: "input" as const,
		title: "Maximum Parallel Workers",
		lines: [
			`Current: ${runtime.getMaxParallelTasks()} worker tasks per blocking call`,
			`Allowed: 1-${MAX_CONFIGURABLE_PARALLEL_TASKS}`,
			`Parallel execution still starts at most ${MAX_BLOCKING_PARALLEL_CONCURRENCY} workers at once.`,
			safeTerminalText(limit.path),
		],
		placeholder: "Enter a whole number",
		action: "set-parallel-limit" as const,
		hint: "back" as const,
	};
}

export function applyBlockingParallelLimitSetting(
	value: string | undefined,
	ctx: ExtensionCommandContext,
	runtime: BlockingParallelLimitRuntime,
) {
	const normalized = value?.trim() ?? "";
	if (!/^\d+$/u.test(normalized)) {
		notifyValidationError(ctx);
		return { kind: "rejected" as const };
	}
	const next = Number(normalized);
	if (!Number.isSafeInteger(next) || next < 1 || next > MAX_CONFIGURABLE_PARALLEL_TASKS) {
		notifyValidationError(ctx);
		return { kind: "rejected" as const };
	}
	const configured = inspectBlockingParallelLimitSettings();
	if (configured.error) {
		ctx.ui.notify(
			`Subagent settings cannot be edited: ${safeTerminalText(configured.error)}`,
			"error",
		);
		return { kind: "rejected" as const };
	}
	const previousRuntime = runtime.getMaxParallelTasks();
	const runtimeChanged = next !== previousRuntime;
	const settingsChanged = next !== configured.value;
	if (!runtimeChanged && !settingsChanged) return { kind: "back" as const };

	if (runtimeChanged) {
		try {
			runtime.setMaxParallelTasks(next);
		} catch (error) {
			ctx.ui.notify(
				`Parallel-worker limit was not applied; user settings are unchanged: ${formatError(error)}`,
				"error",
			);
			return { kind: "rejected" as const };
		}
	}
	if (settingsChanged) {
		try {
			updateBlockingMaxParallelTasksSetting(next);
		} catch (saveError) {
			if (runtimeChanged) {
				try {
					runtime.setMaxParallelTasks(previousRuntime);
				} catch (rollbackError) {
					ctx.ui.notify(
						`Subagent settings were not saved, and the runtime rollback failed: ${formatError(new AggregateError([saveError, rollbackError]))}`,
						"error",
					);
					return { kind: "rejected" as const };
				}
			}
			ctx.ui.notify(
				"Subagent settings were not saved; the previous runtime limit was restored.",
				"error",
			);
			return { kind: "rejected" as const };
		}
	}
	ctx.ui.notify(
		`${settingsChanged ? "Saved and " : ""}applied: maximum ${next} parallel workers per blocking call.`,
		"info",
	);
	return { kind: "back" as const };
}

function notifyValidationError(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		`Maximum parallel workers must be a whole number from 1 to ${MAX_CONFIGURABLE_PARALLEL_TASKS}.`,
		"warning",
	);
}

function safeTerminalText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

function formatError(error: unknown): string {
	return safeTerminalText(error instanceof Error ? error.message : String(error));
}
