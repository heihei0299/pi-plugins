import type { SubagentResultFormat } from "./result-contract.js";
import { SUBAGENT_RESULT_FORMATS } from "./result-contract.js";

export const CAPABILITY_MANIFEST_VERSION = "pi-subagents:capabilities:v1" as const;
export const CAPABILITY_MODALITIES = ["text", "image", "audio"] as const;
export const FILESYSTEM_AUTHORITY = ["none", "read", "write"] as const;
export const EXTERNAL_AUTHORITY = ["none", "required"] as const;
export const CAPABILITY_HINTS = ["low", "medium", "high"] as const;
export type CapabilityHint = (typeof CAPABILITY_HINTS)[number];

const MAX_ITEMS = 50;
const MAX_ITEM_LENGTH = 256;
const MAX_LIMITATION_LENGTH = 1024;

export interface AgentAuthorityManifest {
	filesystem?: (typeof FILESYSTEM_AUTHORITY)[number];
	network?: (typeof EXTERNAL_AUTHORITY)[number];
	secrets?: (typeof EXTERNAL_AUTHORITY)[number];
}

export interface AgentCapabilityManifest {
	version: typeof CAPABILITY_MANIFEST_VERSION;
	capabilities: string[];
	modalities: Array<(typeof CAPABILITY_MODALITIES)[number]>;
	resultFormats: SubagentResultFormat[];
	authority?: AgentAuthorityManifest;
	verificationRoles: string[];
	contextStrengths?: string[];
	costHint?: CapabilityHint;
	latencyHint?: CapabilityHint;
	limitations: string[];
}

export function normalizeCapabilityManifest(value: unknown): AgentCapabilityManifest | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value) || value.version !== CAPABILITY_MANIFEST_VERSION) return undefined;
	const capabilities = identifiers(value.capabilities, false);
	const modalities = enumArray(value.modalities, CAPABILITY_MODALITIES);
	const resultFormats = enumArray(value.resultFormats, SUBAGENT_RESULT_FORMATS);
	const verificationRoles = identifiers(value.verificationRoles, false);
	const contextStrengths =
		value.contextStrengths === undefined ? undefined : identifiers(value.contextStrengths, false);
	const costHint = optionalEnum(value.costHint, CAPABILITY_HINTS);
	const latencyHint = optionalEnum(value.latencyHint, CAPABILITY_HINTS);
	const limitations = strings(value.limitations, MAX_LIMITATION_LENGTH);
	if (
		!capabilities ||
		!modalities ||
		!resultFormats ||
		!verificationRoles ||
		(contextStrengths === undefined && value.contextStrengths !== undefined) ||
		costHint === false ||
		latencyHint === false ||
		!limitations
	) {
		return undefined;
	}
	const authority = normalizeAuthority(value.authority);
	if (authority === false) return undefined;
	return {
		version: CAPABILITY_MANIFEST_VERSION,
		capabilities,
		modalities,
		resultFormats,
		...(authority === undefined ? {} : { authority }),
		verificationRoles,
		...(contextStrengths === undefined ? {} : { contextStrengths }),
		...(costHint === undefined ? {} : { costHint }),
		...(latencyHint === undefined ? {} : { latencyHint }),
		limitations,
	};
}

export function projectCapabilityManifest(
	manifest: AgentCapabilityManifest | undefined,
): AgentCapabilityManifest | undefined {
	return manifest ? structuredClone(manifest) : undefined;
}

function normalizeAuthority(value: unknown): AgentAuthorityManifest | undefined | false {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return false;
	const filesystem = optionalEnum(value.filesystem, FILESYSTEM_AUTHORITY);
	const network = optionalEnum(value.network, EXTERNAL_AUTHORITY);
	const secrets = optionalEnum(value.secrets, EXTERNAL_AUTHORITY);
	if (filesystem === false || network === false || secrets === false) return false;
	return {
		...(filesystem === undefined ? {} : { filesystem }),
		...(network === undefined ? {} : { network }),
		...(secrets === undefined ? {} : { secrets }),
	};
}

function identifiers(value: unknown, required: boolean): string[] | undefined {
	if (value === undefined) return required ? undefined : [];
	return strings(value, MAX_ITEM_LENGTH, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
}

function strings(value: unknown, maxLength: number, pattern?: RegExp): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const normalized = item.trim();
		if (!normalized || normalized.length > maxLength || (pattern && !pattern.test(normalized))) {
			return undefined;
		}
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function enumArray<const T extends readonly string[]>(
	value: unknown,
	allowed: T,
): Array<T[number]> | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	const result: Array<T[number]> = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string" || !allowed.includes(item)) return undefined;
		if (seen.has(item)) continue;
		seen.add(item);
		result.push(item as T[number]);
	}
	return result;
}

function optionalEnum<const T extends readonly string[]>(
	value: unknown,
	allowed: T,
): T[number] | undefined | false {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !allowed.includes(value)) return false;
	return value as T[number];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
