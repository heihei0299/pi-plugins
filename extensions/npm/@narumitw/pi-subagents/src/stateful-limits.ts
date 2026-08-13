import type { SubagentRuntimeSettings } from "./agents/types.js";

export const STATEFUL_LIMIT_FIELDS = [
	"maxAgents",
	"maxActiveTurns",
	"maxChildrenPerAgent",
	"maxDepth",
	"maxStoredAgents",
] as const;

export type StatefulLimitField = (typeof STATEFUL_LIMIT_FIELDS)[number];

export interface StatefulLimits {
	maxAgents: number;
	maxActiveTurns: number;
	maxChildrenPerAgent: number;
	maxDepth: number;
	maxStoredAgents: number;
}

export interface StatefulLimitDefinition {
	field: StatefulLimitField;
	label: string;
	description: string;
	defaultValue: number;
	minimum: number;
}

export const STATEFUL_LIMIT_DEFINITIONS: readonly StatefulLimitDefinition[] = [
	{
		field: "maxAgents",
		label: "Retained agents",
		description: "Running, queued, and reusable idle detached agents",
		defaultValue: 16,
		minimum: 1,
	},
	{
		field: "maxActiveTurns",
		label: "Active turns",
		description: "Detached agent turns that may run at the same time",
		defaultValue: 4,
		minimum: 1,
	},
	{
		field: "maxChildrenPerAgent",
		label: "Children per agent",
		description: "Direct child agents retained beneath one parent",
		defaultValue: 8,
		minimum: 1,
	},
	{
		field: "maxDepth",
		label: "Agent tree depth",
		description: "Nested child levels below a root agent",
		defaultValue: 3,
		minimum: 0,
	},
	{
		field: "maxStoredAgents",
		label: "Stored agents",
		description: "Detached agent records kept per session on disk",
		defaultValue: 50,
		minimum: 1,
	},
];

const definitionsByField = new Map(
	STATEFUL_LIMIT_DEFINITIONS.map((definition) => [definition.field, definition]),
);

export function statefulLimitDefinition(field: StatefulLimitField): StatefulLimitDefinition {
	const definition = definitionsByField.get(field);
	if (!definition) throw new Error(`Unknown stateful limit: ${field}`);
	return definition;
}

export function isStatefulLimitField(value: string): value is StatefulLimitField {
	return (STATEFUL_LIMIT_FIELDS as readonly string[]).includes(value);
}

export function isValidStatefulLimit(field: StatefulLimitField, value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= statefulLimitDefinition(field).minimum
	);
}

export function resolveStatefulLimits(settings?: SubagentRuntimeSettings): StatefulLimits {
	return Object.fromEntries(
		STATEFUL_LIMIT_DEFINITIONS.map((definition) => [
			definition.field,
			settings?.[definition.field] ?? definition.defaultValue,
		]),
	) as unknown as StatefulLimits;
}
