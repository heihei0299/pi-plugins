import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { redactPrivateText } from "./context.js";
import { DEFAULT_MAX_CONTEXT_BYTES, MAX_SUBAGENT_TIMEOUT_MS, truncateUtf8 } from "./limits.js";

export const DELEGATION_CONTRACT_VERSION = "pi-subagents:delegation:v2" as const;
export const DELEGATION_CONTRACT_LEVELS = ["minimal", "full"] as const;
export const DELEGATION_ENFORCEMENT_MODES = ["audit", "enforce"] as const;
export const AUTHORITY_REQUIREMENTS = ["unspecified", "denied", "required"] as const;
export const DELEGATION_SIDE_EFFECT_POLICIES = ["read-only", "idempotent", "mutating"] as const;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_ITEM_BYTES = 4 * 1024;
const MAX_ITEMS = 50;
const MAX_TURNS_OR_TOOLS = 1_000_000;

const BoundedString = Type.String({ maxLength: MAX_TEXT_BYTES });
const BoundedItem = Type.String({ maxLength: MAX_ITEM_BYTES });
const BoundedItems = Type.Array(BoundedItem, { maxItems: MAX_ITEMS });
const DependencySchema = Type.Object(
	{
		taskId: Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_BYTES }),
		artifactId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_BYTES })),
		version: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_BYTES })),
	},
	{ additionalProperties: false },
);

export const DelegationContractSchema = Type.Object(
	{
		version: Type.Literal(DELEGATION_CONTRACT_VERSION),
		level: StringEnum(DELEGATION_CONTRACT_LEVELS),
		taskId: Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_BYTES }),
		objective: BoundedString,
		nonGoals: Type.Optional(BoundedItems),
		dependencies: Type.Optional(Type.Array(DependencySchema, { maxItems: MAX_ITEMS })),
		requiredInputs: Type.Optional(BoundedItems),
		requestedAuthority: Type.Optional(
			Type.Object(
				{
					capabilities: Type.Optional(BoundedItems),
					tools: Type.Optional(BoundedItems),
					readPaths: Type.Optional(BoundedItems),
					writePaths: Type.Optional(BoundedItems),
					network: Type.Optional(StringEnum(AUTHORITY_REQUIREMENTS)),
					secrets: Type.Optional(StringEnum(AUTHORITY_REQUIREMENTS)),
				},
				{ additionalProperties: false },
			),
		),
		acceptanceCriteria: Type.Optional(BoundedItems),
		requiredEvidence: Type.Optional(BoundedItems),
		budget: Type.Optional(
			Type.Object(
				{
					timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_TIMEOUT_MS })),
					maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TURNS_OR_TOOLS })),
					maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TURNS_OR_TOOLS })),
				},
				{ additionalProperties: false },
			),
		),
		admission: Type.Optional(
			Type.Object(
				{
					contextPressure: StringEnum(["low", "medium", "high"] as const),
					independentWorkItems: Type.Integer({ minimum: 1, maximum: 2 }),
					coupling: StringEnum(["dense", "sparse"] as const),
					verificationRequired: Type.Boolean(),
					verificationAvailable: Type.Boolean(),
					budgetAllowsChildren: Type.Boolean(),
					requirementsComplete: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		sideEffectPolicy: Type.Optional(StringEnum(DELEGATION_SIDE_EFFECT_POLICIES)),
		enforcement: Type.Optional(StringEnum(DELEGATION_ENFORCEMENT_MODES)),
	},
	{ additionalProperties: false },
);

export interface DelegationDependency {
	taskId: string;
	artifactId?: string;
	version?: string;
}

export interface DelegationAuthorityRequest {
	capabilities?: string[];
	tools?: string[];
	readPaths?: string[];
	writePaths?: string[];
	network?: (typeof AUTHORITY_REQUIREMENTS)[number];
	secrets?: (typeof AUTHORITY_REQUIREMENTS)[number];
}

export interface DelegationBudgetRequest {
	timeoutMs?: number;
	maxTurns?: number;
	maxToolCalls?: number;
}

export interface DelegationAdmissionRequest {
	contextPressure: "low" | "medium" | "high";
	independentWorkItems: number;
	coupling: "dense" | "sparse";
	verificationRequired: boolean;
	verificationAvailable: boolean;
	budgetAllowsChildren: boolean;
	requirementsComplete: boolean;
}

export interface DelegationContract {
	version: typeof DELEGATION_CONTRACT_VERSION;
	level: (typeof DELEGATION_CONTRACT_LEVELS)[number];
	taskId: string;
	objective: string;
	nonGoals: string[];
	dependencies: DelegationDependency[];
	requiredInputs: string[];
	requestedAuthority?: DelegationAuthorityRequest;
	acceptanceCriteria: string[];
	requiredEvidence: string[];
	budget?: DelegationBudgetRequest;
	admission?: DelegationAdmissionRequest;
	sideEffectPolicy: (typeof DELEGATION_SIDE_EFFECT_POLICIES)[number];
	enforcement: (typeof DELEGATION_ENFORCEMENT_MODES)[number];
}

export interface AppendedDelegationContract {
	text: string;
	contract?: DelegationContract;
	truncated: boolean;
}

export function normalizeDelegationContract(value: unknown): DelegationContract | undefined {
	if (!isPlainObject(value)) return undefined;
	if (
		!hasOnlyKeys(value, [
			"version",
			"level",
			"taskId",
			"objective",
			"nonGoals",
			"dependencies",
			"requiredInputs",
			"requestedAuthority",
			"acceptanceCriteria",
			"requiredEvidence",
			"budget",
			"admission",
			"sideEffectPolicy",
			"enforcement",
		])
	) {
		return undefined;
	}
	if (
		value.version !== DELEGATION_CONTRACT_VERSION ||
		typeof value.level !== "string" ||
		!DELEGATION_CONTRACT_LEVELS.includes(
			value.level as (typeof DELEGATION_CONTRACT_LEVELS)[number],
		) ||
		typeof value.taskId !== "string" ||
		!value.taskId.trim() ||
		typeof value.objective !== "string"
	) {
		return undefined;
	}
	const taskId = bounded(value.taskId, MAX_IDENTIFIER_BYTES);
	const objective = bounded(value.objective, MAX_TEXT_BYTES);
	if (!taskId || !objective) return undefined;
	const nonGoals = normalizeStrings(value.nonGoals);
	const requiredInputs = normalizeStrings(value.requiredInputs);
	const acceptanceCriteria = normalizeStrings(value.acceptanceCriteria);
	const requiredEvidence = normalizeStrings(value.requiredEvidence);
	if (!nonGoals || !requiredInputs || !acceptanceCriteria || !requiredEvidence) return undefined;
	const dependencies = normalizeDependencies(value.dependencies);
	if (!dependencies) return undefined;
	const authority = normalizeAuthority(value.requestedAuthority);
	if (authority === false) return undefined;
	const budget = normalizeBudget(value.budget);
	if (budget === false) return undefined;
	const admission = normalizeAdmission(value.admission);
	if (admission === false) return undefined;
	const sideEffectPolicy = value.sideEffectPolicy ?? "mutating";
	if (
		typeof sideEffectPolicy !== "string" ||
		!DELEGATION_SIDE_EFFECT_POLICIES.includes(
			sideEffectPolicy as (typeof DELEGATION_SIDE_EFFECT_POLICIES)[number],
		)
	) {
		return undefined;
	}
	const enforcement = value.enforcement ?? "audit";
	if (
		typeof enforcement !== "string" ||
		!DELEGATION_ENFORCEMENT_MODES.includes(
			enforcement as (typeof DELEGATION_ENFORCEMENT_MODES)[number],
		)
	) {
		return undefined;
	}
	return {
		version: DELEGATION_CONTRACT_VERSION,
		level: value.level as DelegationContract["level"],
		taskId,
		objective,
		nonGoals,
		dependencies,
		requiredInputs,
		...(authority === undefined ? {} : { requestedAuthority: authority }),
		acceptanceCriteria,
		requiredEvidence,
		...(budget === undefined ? {} : { budget }),
		...(admission === undefined ? {} : { admission }),
		sideEffectPolicy: sideEffectPolicy as DelegationContract["sideEffectPolicy"],
		enforcement: enforcement as DelegationContract["enforcement"],
	};
}

export function appendDelegationContract(
	prompt: string,
	value: unknown,
	maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
): AppendedDelegationContract {
	const contract = normalizeDelegationContract(value);
	if (!contract) return { text: prompt, truncated: false };
	const suffix = [
		"",
		"Delegation contract:",
		JSON.stringify(contract),
		"The requested authority is advisory until an executor-owned ExecutionPlan confirms which controls are enforceable and effective.",
		"Acknowledge missing inputs, authority, capabilities, or verification instead of guessing.",
	].join("\n");
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const boundedPrompt = truncateUtf8(
		redactPrivateText(prompt),
		Math.max(0, maxBytes - suffixBytes),
	);
	const text = truncateUtf8(`${boundedPrompt.text}${suffix}`, maxBytes);
	return {
		text: text.text,
		contract,
		truncated: boundedPrompt.truncated || text.truncated,
	};
}

function normalizeAdmission(value: unknown): DelegationAdmissionRequest | undefined | false {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return false;
	if (
		!hasOnlyKeys(value, [
			"contextPressure",
			"independentWorkItems",
			"coupling",
			"verificationRequired",
			"verificationAvailable",
			"budgetAllowsChildren",
			"requirementsComplete",
		]) ||
		!["low", "medium", "high"].includes(String(value.contextPressure)) ||
		!Number.isSafeInteger(value.independentWorkItems) ||
		Number(value.independentWorkItems) < 1 ||
		Number(value.independentWorkItems) > 2 ||
		!["dense", "sparse"].includes(String(value.coupling)) ||
		typeof value.verificationRequired !== "boolean" ||
		typeof value.verificationAvailable !== "boolean" ||
		typeof value.budgetAllowsChildren !== "boolean" ||
		typeof value.requirementsComplete !== "boolean"
	) {
		return false;
	}
	return {
		contextPressure: value.contextPressure as DelegationAdmissionRequest["contextPressure"],
		independentWorkItems: Number(value.independentWorkItems),
		coupling: value.coupling as DelegationAdmissionRequest["coupling"],
		verificationRequired: value.verificationRequired,
		verificationAvailable: value.verificationAvailable,
		budgetAllowsChildren: value.budgetAllowsChildren,
		requirementsComplete: value.requirementsComplete,
	};
}

function normalizeDependencies(value: unknown): DelegationDependency[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return undefined;
	const result: DelegationDependency[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (
			!isPlainObject(item) ||
			!hasOnlyKeys(item, ["taskId", "artifactId", "version"]) ||
			typeof item.taskId !== "string"
		) {
			return undefined;
		}
		const taskId = bounded(item.taskId, MAX_IDENTIFIER_BYTES);
		if (!taskId || seen.has(taskId)) return undefined;
		seen.add(taskId);
		const artifactId = optionalString(item.artifactId, MAX_IDENTIFIER_BYTES);
		const version = optionalString(item.version, MAX_IDENTIFIER_BYTES);
		if (artifactId === false || version === false) return undefined;
		result.push({
			taskId,
			...(artifactId === undefined ? {} : { artifactId }),
			...(version === undefined ? {} : { version }),
		});
	}
	return result;
}

function normalizeAuthority(value: unknown): DelegationAuthorityRequest | undefined | false {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) return false;
	if (
		!hasOnlyKeys(value, ["capabilities", "tools", "readPaths", "writePaths", "network", "secrets"])
	) {
		return false;
	}
	const capabilities = normalizeOptionalStrings(value.capabilities);
	const tools = normalizeOptionalStrings(value.tools);
	const readPaths = normalizeOptionalStrings(value.readPaths);
	const writePaths = normalizeOptionalStrings(value.writePaths);
	if (capabilities === false || tools === false || readPaths === false || writePaths === false) {
		return false;
	}
	const network = normalizeAuthorityRequirement(value.network);
	const secrets = normalizeAuthorityRequirement(value.secrets);
	if (network === false || secrets === false) return false;
	return {
		...(capabilities === undefined ? {} : { capabilities }),
		...(tools === undefined ? {} : { tools }),
		...(readPaths === undefined ? {} : { readPaths }),
		...(writePaths === undefined ? {} : { writePaths }),
		...(network === undefined ? {} : { network }),
		...(secrets === undefined ? {} : { secrets }),
	};
}

function normalizeBudget(value: unknown): DelegationBudgetRequest | undefined | false {
	if (value === undefined) return undefined;
	if (!isPlainObject(value) || !hasOnlyKeys(value, ["timeoutMs", "maxTurns", "maxToolCalls"])) {
		return false;
	}
	const timeoutMs = optionalInteger(value.timeoutMs, MAX_SUBAGENT_TIMEOUT_MS);
	const maxTurns = optionalInteger(value.maxTurns, MAX_TURNS_OR_TOOLS);
	const maxToolCalls = optionalInteger(value.maxToolCalls, MAX_TURNS_OR_TOOLS);
	if (timeoutMs === false || maxTurns === false || maxToolCalls === false) return false;
	return {
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(maxTurns === undefined ? {} : { maxTurns }),
		...(maxToolCalls === undefined ? {} : { maxToolCalls }),
	};
}

function normalizeStrings(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	const normalized = normalizeOptionalStrings(value);
	return normalized === false ? undefined : normalized;
}

function normalizeOptionalStrings(value: unknown): string[] | undefined | false {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_ITEMS) return false;
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") return false;
		const normalized = bounded(item, MAX_ITEM_BYTES);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function normalizeAuthorityRequirement(
	value: unknown,
): (typeof AUTHORITY_REQUIREMENTS)[number] | undefined | false {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		!AUTHORITY_REQUIREMENTS.includes(value as (typeof AUTHORITY_REQUIREMENTS)[number])
	) {
		return false;
	}
	return value as (typeof AUTHORITY_REQUIREMENTS)[number];
}

function optionalString(value: unknown, maxBytes: number): string | undefined | false {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return false;
	const normalized = bounded(value, maxBytes);
	return normalized || false;
}

function optionalInteger(value: unknown, max: number): number | undefined | false {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
		return false;
	return value as number;
}

function bounded(value: string, maxBytes: number): string {
	return truncateUtf8(redactPrivateText(value), maxBytes).text.trim();
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
