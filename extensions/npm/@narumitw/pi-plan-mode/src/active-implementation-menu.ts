import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";

interface ActiveImplementationMenuOptions {
	statusText: string;
	signal: AbortSignal;
	isCurrent(): boolean;
	show(): void;
	startNew(): void;
	clear(): void;
}

export async function showActiveImplementationMenu(
	ctx: ExtensionContext,
	options: ActiveImplementationMenuOptions,
) {
	type Action = "show" | "start-new" | "clear";
	const menu = defineMenu<undefined, "active", Action, ExtensionContext>({
		start: "active",
		screens: {
			active: () => ({
				kind: "actions",
				title: "Active implementation plan",
				lines: [options.statusText],
				items: [
					{ id: "show", label: "Show active implementation plan", action: "show" },
					{ id: "start-new", label: "Start a new plan", action: "start-new" },
					{ id: "clear", label: "Clear active implementation plan", action: "clear" },
				],
				hint: "close",
			}),
		},
		actions: {
			show: async () => {
				options.show();
				return { kind: "close" };
			},
			"start-new": async () => {
				options.startNew();
				return { kind: "close" };
			},
			clear: async () => {
				options.clear();
				return { kind: "close" };
			},
		},
	});
	await runMenu(ctx, menu, {
		getState: () => undefined,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});
}
