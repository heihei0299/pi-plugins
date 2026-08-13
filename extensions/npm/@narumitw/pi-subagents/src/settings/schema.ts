import {
	CONSULT_RESOURCE_POLICIES,
	CONSULTATION_CWD_POLICIES,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	DELEGATION_CWD_POLICIES,
	type DelegationCwdPolicy,
	isThinkingLevel,
	type SubagentAgentConfig,
	type SubagentSettings,
} from "../agents/types.js";
import { MAX_CONFIGURABLE_PARALLEL_TASKS, MAX_SUBAGENT_TIMEOUT_MS } from "../limits.js";
import { isValidStatefulLimit, STATEFUL_LIMIT_FIELDS } from "../stateful-limits.js";

export function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

export function isPositiveInteger(value: unknown): value is number {
	return isPositiveNumber(value) && Number.isSafeInteger(value);
}

export function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
	if (!isPlainObject(value)) return undefined;

	const config: SubagentAgentConfig = {};
	let hasKnownField = false;

	if (hasOwn(value, "tools")) {
		if (!isStringArray(value.tools)) return undefined;
		config.tools = value.tools;
		hasKnownField = true;
	}

	if (hasOwn(value, "model")) {
		if (value.model !== null && typeof value.model !== "string") return undefined;
		config.model = value.model;
		hasKnownField = true;
	}

	if (hasOwn(value, "thinkingLevel")) {
		if (value.thinkingLevel !== null && !isThinkingLevel(value.thinkingLevel)) return undefined;
		config.thinkingLevel = value.thinkingLevel;
		hasKnownField = true;
	}

	if (hasOwn(value, "timeoutMs")) {
		if (
			value.timeoutMs !== null &&
			(!isPositiveNumber(value.timeoutMs) || value.timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)
		) {
			return undefined;
		}
		config.timeoutMs = value.timeoutMs;
		hasKnownField = true;
	}

	return hasKnownField ? config : undefined;
}

export function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
	if (!isPlainObject(value)) return undefined;
	const settings: SubagentSettings = {};
	if (hasOwn(value, "agents")) {
		if (!isPlainObject(value.agents)) return undefined;
		const agents: Record<string, SubagentAgentConfig> = {};
		for (const [name, rawConfig] of Object.entries(value.agents)) {
			const config = normalizeAgentSettings(rawConfig);
			if (config) agents[name] = config;
		}
		if (Object.keys(agents).length > 0) settings.agents = agents;
	}
	if (hasOwn(value, "blocking")) {
		if (!isPlainObject(value.blocking)) return undefined;
		const blocking: NonNullable<SubagentSettings["blocking"]> = {};
		if (hasOwn(value.blocking, "enabled")) {
			if (typeof value.blocking.enabled !== "boolean") return undefined;
			blocking.enabled = value.blocking.enabled;
		}
		if (hasOwn(value.blocking, "maxParallelTasks")) {
			if (
				!isPositiveInteger(value.blocking.maxParallelTasks) ||
				value.blocking.maxParallelTasks > MAX_CONFIGURABLE_PARALLEL_TASKS
			) {
				return undefined;
			}
			blocking.maxParallelTasks = value.blocking.maxParallelTasks;
		}
		settings.blocking = blocking;
	}
	if (hasOwn(value, "stateful")) {
		if (!isPlainObject(value.stateful)) return undefined;
		const runtime: NonNullable<SubagentSettings["stateful"]> = {};
		if (hasOwn(value.stateful, "transport")) {
			if (
				value.stateful.transport !== "subprocess" &&
				value.stateful.transport !== "in-process" &&
				value.stateful.transport !== "rpc" &&
				value.stateful.transport !== "auto"
			) {
				return undefined;
			}
			runtime.transport = value.stateful.transport;
		}
		if (hasOwn(value.stateful, "completionDelivery")) {
			if (
				value.stateful.completionDelivery !== "next-turn" &&
				value.stateful.completionDelivery !== "auto-resume"
			) {
				return undefined;
			}
			runtime.completionDelivery = value.stateful.completionDelivery;
		}
		for (const key of STATEFUL_LIMIT_FIELDS) {
			if (hasOwn(value.stateful, key)) {
				if (!isValidStatefulLimit(key, value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		for (const key of ["maxMailboxMessages", "maxMailboxMessageBytes", "idleTtlMs"] as const) {
			if (hasOwn(value.stateful, key)) {
				if (!isPositiveInteger(value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		if (hasOwn(value.stateful, "retentionDays")) {
			if (!isPositiveNumber(value.stateful.retentionDays)) return undefined;
			runtime.retentionDays = value.stateful.retentionDays;
		}
		if (hasOwn(value.stateful, "enabled")) {
			if (typeof value.stateful.enabled !== "boolean") return undefined;
			runtime.enabled = value.stateful.enabled;
		}
		settings.stateful = runtime;
	}
	if (hasOwn(value, "consult")) {
		if (!isPlainObject(value.consult)) return undefined;
		const consult: NonNullable<SubagentSettings["consult"]> = {};
		if (hasOwn(value.consult, "resources")) {
			if (
				typeof value.consult.resources !== "string" ||
				!CONSULT_RESOURCE_POLICIES.includes(value.consult.resources as ConsultResourcePolicy)
			) {
				return undefined;
			}
			consult.resources = value.consult.resources as ConsultResourcePolicy;
		}
		settings.consult = consult;
	}
	if (hasOwn(value, "cwdPolicy")) {
		if (!isPlainObject(value.cwdPolicy)) return undefined;
		const cwdPolicy: NonNullable<SubagentSettings["cwdPolicy"]> = {};
		if (hasOwn(value.cwdPolicy, "consultation")) {
			if (
				typeof value.cwdPolicy.consultation !== "string" ||
				!CONSULTATION_CWD_POLICIES.includes(value.cwdPolicy.consultation as ConsultationCwdPolicy)
			) {
				return undefined;
			}
			cwdPolicy.consultation = value.cwdPolicy.consultation as ConsultationCwdPolicy;
		}
		if (hasOwn(value.cwdPolicy, "delegation")) {
			if (
				typeof value.cwdPolicy.delegation !== "string" ||
				!DELEGATION_CWD_POLICIES.includes(value.cwdPolicy.delegation as DelegationCwdPolicy)
			) {
				return undefined;
			}
			cwdPolicy.delegation = value.cwdPolicy.delegation as DelegationCwdPolicy;
		}
		settings.cwdPolicy = cwdPolicy;
	}
	return settings;
}
