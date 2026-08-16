import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cachedModuleLoader } from "./cached-module-loader.js";
import { showSubagentHelp, showSubagentStatus } from "./config-status.js";
import type { SubagentMenuOwner, SubagentSettingsRuntime } from "./config-ui.js";

const SUBCOMMANDS = [
	{ value: "settings", label: "settings", description: "Configure subagent user settings" },
	{ value: "status", label: "status", description: "Show effective subagent settings" },
	{ value: "help", label: "help", description: "Show subagent settings help" },
];

type ConfigUiModule = Pick<
	typeof import("./config-ui.js"),
	"showSubagentManager" | "showSubagentSettings"
>;

export interface ConfigRegistrationDependencies {
	loadConfigUi?: () => Promise<ConfigUiModule>;
}

export function registerSubagentConfigLifecycle(pi: ExtensionAPI): SubagentMenuOwner {
	const owner: SubagentMenuOwner = { generation: 0, controller: new AbortController() };
	pi.on("session_start", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session replaced", "AbortError"));
		owner.controller = new AbortController();
	});
	pi.on("session_shutdown", () => {
		owner.generation += 1;
		owner.controller.abort(new DOMException("Subagent session shut down", "AbortError"));
	});
	return owner;
}

export function registerSubagentConfigCommand(
	pi: ExtensionAPI,
	runtime: SubagentSettingsRuntime,
	owner = registerSubagentConfigLifecycle(pi),
	dependencies: ConfigRegistrationDependencies = {},
): void {
	const loadConfigUi = cachedModuleLoader(
		dependencies.loadConfigUi ?? (() => import("./config-ui.js")),
	);
	pi.registerCommand("subagents", {
		description: "Manage current-session subagents and user settings",
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const subcommand = args.trim().toLowerCase();
			if (!subcommand && ctx.mode !== "tui") {
				showSubagentStatus(ctx, runtime);
				return;
			}
			if (subcommand === "status") {
				showSubagentStatus(ctx, runtime);
				return;
			}
			if (subcommand === "help") {
				showSubagentHelp(ctx, runtime);
				return;
			}
			if (!subcommand || subcommand === "settings") {
				const generation = owner.generation;
				const controller = owner.controller;
				const isCurrent = () =>
					generation === owner.generation &&
					controller === owner.controller &&
					!controller.signal.aborted;
				let configUi: ConfigUiModule;
				try {
					configUi = await loadConfigUi();
				} catch (error) {
					if (!isCurrent()) return;
					throw error;
				}
				if (!isCurrent()) return;
				if (!subcommand) await configUi.showSubagentManager(pi, ctx, runtime, owner);
				else await configUi.showSubagentSettings(ctx, runtime, owner);
				return;
			}
			if (ctx.mode === "tui" || ctx.hasUI) {
				ctx.ui.notify(`Unknown /subagents subcommand: ${subcommand}`, "warning");
			}
		},
	});
}
