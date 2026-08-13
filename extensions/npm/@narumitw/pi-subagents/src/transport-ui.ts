import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentTransportKind } from "./agents/types.js";
import { safeTerminalLine as safeTerminalText } from "./safe-text.js";
import { inspectStatefulTransportSettings, updateStatefulTransportSetting } from "./settings.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";

const TRANSPORT_OPTIONS: Array<{
	value: SubagentTransportKind;
	label: string;
	description: string;
}> = [
	{
		value: "subprocess",
		label: "Fresh subprocess",
		description: "Compatibility path with a fresh isolated Pi process for every turn.",
	},
	{
		value: "in-process",
		label: "In process",
		description:
			"Lowest follow-up overhead for built-in tools, with shared memory and crash boundary.",
	},
	{
		value: "rpc",
		label: "Persistent RPC process",
		description: "Retain native history in one isolated Pi process per active retained agent.",
	},
	{
		value: "auto",
		label: "Automatic",
		description:
			"Read-only built-ins use in-process, write-capable built-ins use RPC, and custom tools use subprocess.",
	},
];

export interface TransportUiRuntime {
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
}

export function transportSettingsScreen(runtime: TransportUiRuntime) {
	const configured = inspectStatefulTransportSettings();
	const current = runtime.getRuntimeStatus();
	return {
		kind: "actions" as const,
		title: configured.error ? "Detached Transport · Read only" : "Detached Transport",
		lines: [
			`Current session: ${transportLabel(current.transport)}`,
			`Configured after reload: ${transportLabel(configured.value)} (${configured.source})`,
			"Transport isolation is not a filesystem or network sandbox.",
			"RPC v1 disables child extensions and supports built-in Pi tools only.",
			...(configured.error
				? [
						`Settings cannot be edited: ${safeTerminalText(configured.error)}`,
						`Repair ${safeTerminalText(configured.path)} and retry.`,
					]
				: []),
		],
		items: [
			...(configured.error
				? []
				: TRANSPORT_OPTIONS.map((option) => ({
						id: option.value,
						label: option.label,
						description: option.description,
						action: "set-transport" as const,
					}))),
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export async function applyTransportSetting(
	value: string,
	ctx: ExtensionCommandContext,
	runtime: TransportUiRuntime,
	signal: AbortSignal,
	isCurrent: () => boolean,
) {
	if (!isTransport(value)) return { kind: "rejected" as const };
	const before = inspectStatefulTransportSettings();
	if (before.error) return { kind: "rejected" as const };
	if (value === before.value) return { kind: "stay" as const };
	const status = runtime.getRuntimeStatus();
	if (status.retainedAgents > 0) {
		ctx.ui.notify(
			`Cannot change transport while ${status.retainedAgents} detached agent${status.retainedAgents === 1 ? " is" : "s are"} retained. Clear Current agents first.`,
			"warning",
		);
		return { kind: "rejected" as const };
	}
	const option = TRANSPORT_OPTIONS.find((candidate) => candidate.value === value);
	const confirmed = await ctx.ui.confirm(
		`Use ${transportLabel(value)} after reload?`,
		`${option?.description ?? ""}\n\nThis saves the setting but does not reload Pi automatically.`,
		{ signal },
	);
	if (signal.aborted || !isCurrent()) return { kind: "close" as const };
	if (!confirmed) return { kind: "rejected" as const };
	const after = inspectStatefulTransportSettings();
	if (after.error || after.value !== before.value || after.source !== before.source) {
		ctx.ui.notify("Transport settings changed while confirming; review again.", "warning");
		return { kind: "rejected" as const };
	}
	if (runtime.getRuntimeStatus().retainedAgents > 0) {
		ctx.ui.notify(
			"Detached agents appeared while confirming; clear them before changing transport.",
			"warning",
		);
		return { kind: "rejected" as const };
	}
	try {
		updateStatefulTransportSetting(value);
		ctx.ui.notify(`Saved ${transportLabel(value)}. Run /reload when ready.`, "info");
		return { kind: "stay" as const };
	} catch (error) {
		ctx.ui.notify(
			`Transport was not saved; the previous setting remains: ${safeTerminalText(error instanceof Error ? error.message : String(error))}`,
			"error",
		);
		return { kind: "rejected" as const };
	}
}

export function responsivenessSetupScreen(runtime: TransportUiRuntime) {
	const current = runtime.getRuntimeStatus();
	const configured = inspectStatefulTransportSettings();
	return {
		kind: "actions" as const,
		title: "Responsiveness Setup",
		lines: [
			`Current transport: ${transportLabel(current.transport)}`,
			`Configured transport: ${transportLabel(configured.value)}`,
			"Transport, completion delivery, and thinking defaults are separate explicit choices.",
			"Use Automatic to reduce retained follow-up startup while keeping custom-tool compatibility.",
		],
		items: [
			{
				id: "auto",
				label: "Preview Automatic transport",
				description: "Choose a deterministic transport before each retained agent starts",
				action: "set-transport" as const,
			},
			{ id: "transport", label: "Compare all transports", to: "transport" as const },
			{
				id: "completion",
				label: "Completion delivery",
				description: "Choose separately whether an idle root resumes for synthesis",
				to: "settings" as const,
			},
			{
				id: "thinking",
				label: "Thinking profiles",
				description: "Preview explicit Fast, Balanced, or Deep per-agent defaults",
				to: "execution-profiles" as const,
			},
			{ id: "back", label: "Back", action: "back" as const },
		],
		hint: "back" as const,
	};
}

export function transportLabel(value: SubagentTransportKind): string {
	return TRANSPORT_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function isTransport(value: string): value is SubagentTransportKind {
	return ["subprocess", "in-process", "rpc", "auto"].includes(value);
}
