import type {
	CompletionDelivery,
	ConsultationCwdPolicy,
	ConsultResourcePolicy,
	DelegationCwdPolicy,
	SubagentSettings,
	SubagentTransportKind,
} from "../agents/types.js";
import { DEFAULT_MAX_PARALLEL_TASKS } from "../limits.js";
import {
	resolveStatefulLimits,
	STATEFUL_LIMIT_FIELDS,
	type StatefulLimitField,
} from "../stateful-limits.js";
import { hasOwn, isPlainObject } from "./schema.js";

const DEFAULT_COMPLETION_DELIVERY: CompletionDelivery = "next-turn";
export const DEFAULT_CONSULT_RESOURCE_POLICY: ConsultResourcePolicy = "project-context";
export const DEFAULT_CONSULTATION_CWD_POLICY: ConsultationCwdPolicy = "anywhere";
export const DEFAULT_DELEGATION_CWD_POLICY: DelegationCwdPolicy = "trusted-targets";

export type DelegationWorkflow = "all" | "async-only" | "blocking-only" | "disabled";

type SettingsSource = "default" | "user settings";

export interface InspectedSubagentSettingsDocument {
	path: string;
	raw?: Record<string, unknown>;
	settings?: SubagentSettings;
	error?: string;
}

export interface DelegationWorkflowSettingsSnapshot {
	path: string;
	value: DelegationWorkflow;
	source: SettingsSource;
	error?: string;
}

export interface CompletionDeliverySettingsSnapshot {
	path: string;
	value: CompletionDelivery;
	source: SettingsSource;
	error?: string;
}

export interface StatefulTransportSettingsSnapshot {
	path: string;
	value: SubagentTransportKind;
	source: SettingsSource;
	error?: string;
}

export interface BlockingParallelLimitSettingsSnapshot {
	path: string;
	value: number;
	source: SettingsSource;
	error?: string;
}

export interface StatefulLimitFieldSnapshot {
	value: number;
	source: SettingsSource;
}

export interface StatefulLimitSettingsSnapshot {
	path: string;
	writePath: string;
	values?: Record<StatefulLimitField, StatefulLimitFieldSnapshot>;
	error?: string;
}

export interface ConsultResourceSettingsSnapshot {
	path: string;
	value: ConsultResourcePolicy;
	source: SettingsSource;
	error?: string;
}

export interface CwdPolicyFieldSnapshot<T> {
	value: T;
	source: SettingsSource;
}

export interface CwdPolicySettingsSnapshot {
	path: string;
	consultation: CwdPolicyFieldSnapshot<ConsultationCwdPolicy>;
	delegation: CwdPolicyFieldSnapshot<DelegationCwdPolicy>;
	error?: string;
}

export interface SubagentSettingsSnapshot {
	path: string;
	settings?: SubagentSettings;
	source: SettingsSource;
	error?: string;
}

export function resolveDelegationWorkflow(
	blockingEnabled: boolean,
	statefulEnabled: boolean,
): DelegationWorkflow {
	if (blockingEnabled && statefulEnabled) return "all";
	if (statefulEnabled) return "async-only";
	if (blockingEnabled) return "blocking-only";
	return "disabled";
}

export function resolveBlockingMaxParallelTasks(settings?: SubagentSettings): number {
	return settings?.blocking?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
}

export function buildSubagentSettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): SubagentSettingsSnapshot {
	return {
		path: inspected.path,
		settings: inspected.settings,
		source: inspected.settings ? "user settings" : "default",
		...(inspected.error ? { error: inspected.error } : {}),
	};
}

export function buildConsultResourceSettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): ConsultResourceSettingsSnapshot {
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_CONSULT_RESOURCE_POLICY,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.consult) && hasOwn(inspected.raw.consult, "resources");
	return {
		path: inspected.path,
		value: inspected.settings.consult?.resources ?? DEFAULT_CONSULT_RESOURCE_POLICY,
		source: explicit ? "user settings" : "default",
	};
}

export function buildCwdPolicySettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): CwdPolicySettingsSnapshot {
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			consultation: { value: DEFAULT_CONSULTATION_CWD_POLICY, source: "default" },
			delegation: { value: DEFAULT_DELEGATION_CWD_POLICY, source: "default" },
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const rawPolicy = isPlainObject(inspected.raw.cwdPolicy) ? inspected.raw.cwdPolicy : undefined;
	return {
		path: inspected.path,
		consultation: {
			value: inspected.settings.cwdPolicy?.consultation ?? DEFAULT_CONSULTATION_CWD_POLICY,
			source: rawPolicy && hasOwn(rawPolicy, "consultation") ? "user settings" : "default",
		},
		delegation: {
			value: inspected.settings.cwdPolicy?.delegation ?? DEFAULT_DELEGATION_CWD_POLICY,
			source: rawPolicy && hasOwn(rawPolicy, "delegation") ? "user settings" : "default",
		},
	};
}

export function buildDelegationWorkflowSettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): DelegationWorkflowSettingsSnapshot {
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: "all",
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		(isPlainObject(inspected.raw.blocking) && hasOwn(inspected.raw.blocking, "enabled")) ||
		(isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "enabled"));
	return {
		path: inspected.path,
		value: resolveDelegationWorkflow(
			inspected.settings.blocking?.enabled !== false,
			inspected.settings.stateful?.enabled !== false,
		),
		source: explicit ? "user settings" : "default",
	};
}

export function buildCompletionDeliverySettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): CompletionDeliverySettingsSnapshot {
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_COMPLETION_DELIVERY,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "completionDelivery");
	return {
		path: inspected.path,
		value: inspected.settings.stateful?.completionDelivery ?? DEFAULT_COMPLETION_DELIVERY,
		source: explicit ? "user settings" : "default",
	};
}

export function buildStatefulTransportSettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): StatefulTransportSettingsSnapshot {
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: "subprocess",
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "transport");
	return {
		path: inspected.path,
		value: inspected.settings.stateful?.transport ?? "subprocess",
		source: explicit ? "user settings" : "default",
	};
}

export function buildBlockingParallelLimitSettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
): BlockingParallelLimitSettingsSnapshot {
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_MAX_PARALLEL_TASKS,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.blocking) && hasOwn(inspected.raw.blocking, "maxParallelTasks");
	return {
		path: inspected.path,
		value: resolveBlockingMaxParallelTasks(inspected.settings),
		source: explicit ? "user settings" : "default",
	};
}

export function buildStatefulLimitSettingsSnapshot(
	inspected: InspectedSubagentSettingsDocument,
	writePath: string,
): StatefulLimitSettingsSnapshot {
	if (inspected.error) {
		return { path: inspected.path, writePath, error: inspected.error };
	}
	const resolved = resolveStatefulLimits(inspected.settings?.stateful);
	const rawStateful = isPlainObject(inspected.raw?.stateful) ? inspected.raw.stateful : undefined;
	return {
		path: inspected.path,
		writePath,
		values: Object.fromEntries(
			STATEFUL_LIMIT_FIELDS.map((field) => [
				field,
				{
					value: resolved[field],
					source: rawStateful && hasOwn(rawStateful, field) ? "user settings" : "default",
				},
			]),
		) as unknown as Record<StatefulLimitField, StatefulLimitFieldSnapshot>,
	};
}
