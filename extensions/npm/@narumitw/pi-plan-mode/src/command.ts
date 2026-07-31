export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "show", label: "show", description: "Show the ready or active plan" },
	{ value: "finalize", label: "finalize", description: "Request a completed plan" },
	{ value: "implement", label: "implement", description: "Implement the completed plan" },
	{ value: "exit", label: "exit", description: "Leave Plan mode or clear the active plan" },
	{ value: "off", label: "off", description: "Leave Plan mode or clear the active plan" },
	{ value: "tools", label: "tools", description: "Select tools allowed in Plan mode" },
];

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}
