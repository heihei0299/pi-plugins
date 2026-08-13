import { createHash } from "node:crypto";
import {
	type DelegationAdmissionDecision,
	evaluateDelegationAdmission,
} from "./admission-policy.js";
import {
	type AgentConfig,
	type AgentSource,
	resolveAgentToolNames,
	type SubagentThinkingLevel,
} from "./agents/types.js";
import type { TargetPolicyAudit } from "./cwd-policy.js";
import type { DelegationContract } from "./delegation-contract.js";
import type { SubagentResultFormat } from "./result-contract.js";

export const EXECUTION_PLAN_VERSION = "pi-subagents:execution-plan:v1" as const;
export const EXECUTION_ACKNOWLEDGEMENT_VERSION = "pi-subagents:acknowledgement:v1" as const;

export type CapabilityFit = "match" | "mismatch" | "unknown";
export type ExecutionPlanTransport = "subprocess" | "in-process" | "rpc" | "auto";

export interface ExecutionPlanAgentProjection {
	name: string;
	source: AgentSource;
	capabilitiesKnown: boolean;
}

export interface ExecutionPlan {
	version: typeof EXECUTION_PLAN_VERSION;
	id: string;
	mode: "audit" | "enforce";
	taskId?: string;
	taskGeneration: number;
	cancellationLineage: string[];
	admission: DelegationAdmissionDecision;
	agent: ExecutionPlanAgentProjection;
	capabilityFit: CapabilityFit;
	missingCapabilities: string[];
	requestedCapabilities: string[];
	declaredCapabilities: string[];
	requestedTools: string[];
	effectiveTools?: string[];
	missingTools: string[];
	overgrantedTools: string[];
	resultFormat: SubagentResultFormat;
	sideEffectPolicy: "read-only" | "idempotent" | "mutating";
	resultFormatSupported: boolean | "unknown";
	target: TargetPolicyAudit;
	workspaceMode: "shared" | "worktree";
	transport: ExecutionPlanTransport;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	unsupportedGuarantees: string[];
	warnings: string[];
}

export interface ExecutionAcknowledgement {
	version: typeof EXECUTION_ACKNOWLEDGEMENT_VERSION;
	status: "accepted" | "rejected";
	reasonCodes: string[];
	recoveryActions: string[];
}

export interface CreateExecutionPlanInput {
	contract?: DelegationContract;
	agent: AgentConfig;
	effectiveTools?: string[];
	target: TargetPolicyAudit;
	workspaceMode: "shared" | "worktree";
	transport: ExecutionPlanTransport;
	resultFormat: SubagentResultFormat;
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	taskGeneration?: number;
	cancellationLineage?: string[];
}

export function createExecutionPlan(input: CreateExecutionPlanInput): ExecutionPlan {
	const manifest = input.agent.capabilityManifest;
	const requestedCapabilities = unique(input.contract?.requestedAuthority?.capabilities ?? []);
	const declaredCapabilities = unique(manifest?.capabilities ?? []);
	const missingCapabilities = requestedCapabilities.filter(
		(capability) => !declaredCapabilities.includes(capability),
	);
	const capabilityFit: CapabilityFit = manifest
		? missingCapabilities.length > 0
			? "mismatch"
			: "match"
		: "unknown";
	const requestedTools = unique(input.contract?.requestedAuthority?.tools ?? []);
	const effectiveTools = input.effectiveTools ? unique(input.effectiveTools) : undefined;
	const missingTools = requestedTools.filter((tool) => !(effectiveTools ?? []).includes(tool));
	const overgrantedTools =
		requestedTools.length === 0
			? []
			: (effectiveTools ?? []).filter((tool) => !requestedTools.includes(tool));
	const resultFormatSupported = manifest
		? manifest.resultFormats.includes(input.resultFormat)
		: "unknown";
	const unsupportedGuarantees = unsupported(input.contract);
	const taskGeneration = input.taskGeneration ?? 0;
	const cancellationLineage = [...(input.cancellationLineage ?? [])];
	const admissionRequest = input.contract?.admission;
	const admission = evaluateDelegationAdmission({
		contextPressure: admissionRequest?.contextPressure ?? "low",
		independentWorkItems: admissionRequest?.independentWorkItems ?? 1,
		coupling: admissionRequest?.coupling ?? "dense",
		verificationRequired: admissionRequest?.verificationRequired ?? false,
		verificationAvailable: admissionRequest?.verificationAvailable ?? false,
		capabilitiesSupported: capabilityFit === "match" && missingTools.length === 0,
		budgetAllowsChildren: admissionRequest?.budgetAllowsChildren ?? true,
		generationCurrent: true,
		requirementsComplete: admissionRequest?.requirementsComplete ?? false,
	});
	const warnings: string[] = [];
	if (!manifest) warnings.push("agent-capabilities-unknown");
	if (missingCapabilities.length > 0) warnings.push("capability-mismatch");
	if (missingTools.length > 0) warnings.push("requested-tools-missing");
	if (overgrantedTools.length > 0) warnings.push("tools-overgranted");
	if (resultFormatSupported === false) warnings.push("result-format-unsupported");
	if (unsupportedGuarantees.length > 0) warnings.push("unsupported-guarantees");
	const planWithoutId: Omit<ExecutionPlan, "id"> = {
		version: EXECUTION_PLAN_VERSION,
		mode: input.contract?.enforcement ?? "audit",
		...(input.contract?.taskId ? { taskId: input.contract.taskId } : {}),
		agent: {
			name: input.agent.name,
			source: input.agent.source,
			capabilitiesKnown: manifest !== undefined,
		},
		capabilityFit,
		missingCapabilities,
		requestedCapabilities,
		declaredCapabilities,
		requestedTools,
		...(effectiveTools === undefined ? {} : { effectiveTools }),
		missingTools,
		overgrantedTools,
		resultFormat: input.resultFormat,
		sideEffectPolicy: input.contract?.sideEffectPolicy ?? "mutating",
		resultFormatSupported,
		target: structuredClone(input.target),
		workspaceMode: input.workspaceMode,
		transport: input.transport,
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
		unsupportedGuarantees,
		warnings,
		taskGeneration,
		cancellationLineage,
		admission,
	};
	return { ...planWithoutId, id: executionPlanId(planWithoutId) };
}

export function resolveContractTools(
	configuredTools: string[] | undefined,
	contract: DelegationContract | undefined,
): string[] | undefined {
	const requested = contract?.requestedAuthority?.tools;
	if (contract?.enforcement !== "enforce" || requested === undefined) {
		return configuredTools ? unique(configuredTools) : undefined;
	}
	const availableTools = resolveAgentToolNames(configuredTools);
	return unique(requested.filter((tool) => availableTools.includes(tool)));
}

export function acknowledgeExecutionPlan(plan: ExecutionPlan): ExecutionAcknowledgement {
	if (plan.mode === "audit") {
		return {
			version: EXECUTION_ACKNOWLEDGEMENT_VERSION,
			status: "accepted",
			reasonCodes: [],
			recoveryActions: [],
		};
	}
	const reasonCodes: string[] = [];
	const recoveryActions: string[] = [];
	if (plan.capabilityFit === "unknown") {
		reasonCodes.push("capabilities-unknown");
		recoveryActions.push("declare-capabilities", "reroute");
	}
	if (plan.missingCapabilities.length > 0) {
		reasonCodes.push("capability-mismatch");
		recoveryActions.push("reroute");
	}
	if (plan.missingTools.length > 0) {
		reasonCodes.push("authority-missing");
		recoveryActions.push("grant-authority", "reroute");
	}
	if (plan.overgrantedTools.length > 0) {
		reasonCodes.push("authority-overgranted");
		recoveryActions.push("narrow-authority");
	}
	if (plan.resultFormatSupported !== true) {
		reasonCodes.push("result-format-unsupported");
		recoveryActions.push("reroute", "change-result-format");
	}
	if (plan.unsupportedGuarantees.length > 0) {
		reasonCodes.push("unsupported-guarantee");
		recoveryActions.push("stop");
	}
	return {
		version: EXECUTION_ACKNOWLEDGEMENT_VERSION,
		status: reasonCodes.length === 0 ? "accepted" : "rejected",
		reasonCodes: unique(reasonCodes),
		recoveryActions: unique(recoveryActions),
	};
}

export function copyExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
	const { id: _storedId, ...cloned } = structuredClone(plan);
	const legacyAdmission = evaluateDelegationAdmission({
		contextPressure: "low",
		independentWorkItems: 1,
		coupling: "dense",
		verificationRequired: false,
		verificationAvailable: false,
		capabilitiesSupported: false,
		budgetAllowsChildren: true,
		generationCurrent: true,
		requirementsComplete: false,
	});
	const normalized = {
		...cloned,
		sideEffectPolicy: plan.sideEffectPolicy ?? "mutating",
		taskGeneration: plan.taskGeneration ?? 0,
		cancellationLineage: plan.cancellationLineage ?? [],
		admission: plan.admission ?? legacyAdmission,
	};
	return { ...normalized, id: executionPlanId(normalized) };
}

export function rotateExecutionPlanGeneration(plan: ExecutionPlan): ExecutionPlan {
	const normalized = copyExecutionPlan(plan);
	const { id: previousId, ...withoutId } = normalized;
	const rotated = {
		...withoutId,
		taskGeneration: normalized.taskGeneration + 1,
		cancellationLineage: [...normalized.cancellationLineage, previousId],
	};
	return { ...rotated, id: executionPlanId(rotated) };
}

export function isExecutionPlan(value: unknown): value is ExecutionPlan {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const plan = value as Partial<ExecutionPlan>;
	return (
		plan.version === EXECUTION_PLAN_VERSION &&
		(plan.mode === "audit" || plan.mode === "enforce") &&
		Boolean(plan.agent) &&
		typeof plan.agent?.name === "string" &&
		["built-in", "user", "project"].includes(String(plan.agent?.source)) &&
		["match", "mismatch", "unknown"].includes(String(plan.capabilityFit)) &&
		Array.isArray(plan.missingCapabilities) &&
		plan.missingCapabilities.every((item) => typeof item === "string") &&
		Array.isArray(plan.requestedCapabilities) &&
		plan.requestedCapabilities.every((item) => typeof item === "string") &&
		Array.isArray(plan.declaredCapabilities) &&
		plan.declaredCapabilities.every((item) => typeof item === "string") &&
		Array.isArray(plan.missingTools) &&
		plan.missingTools.every((item) => typeof item === "string") &&
		Array.isArray(plan.requestedTools) &&
		plan.requestedTools.every((item) => typeof item === "string") &&
		(plan.effectiveTools === undefined ||
			(Array.isArray(plan.effectiveTools) &&
				plan.effectiveTools.every((item) => typeof item === "string"))) &&
		Array.isArray(plan.overgrantedTools) &&
		plan.overgrantedTools.every((item) => typeof item === "string") &&
		["text", "structured-v1", "structured-v2"].includes(String(plan.resultFormat)) &&
		(typeof plan.resultFormatSupported === "boolean" || plan.resultFormatSupported === "unknown") &&
		Boolean(plan.target) &&
		typeof plan.target?.cwd === "string" &&
		["current-workspace", "external"].includes(String(plan.target?.boundary)) &&
		(plan.workspaceMode === "shared" || plan.workspaceMode === "worktree") &&
		["subprocess", "in-process", "rpc", "auto"].includes(String(plan.transport)) &&
		typeof plan.id === "string" &&
		/^[a-f0-9]{64}$/u.test(plan.id) &&
		(plan.taskGeneration === undefined ||
			(Number.isSafeInteger(plan.taskGeneration) && Number(plan.taskGeneration) >= 0)) &&
		(plan.cancellationLineage === undefined ||
			(Array.isArray(plan.cancellationLineage) &&
				plan.cancellationLineage.every((item) => typeof item === "string"))) &&
		(plan.admission === undefined ||
			(typeof plan.admission === "object" &&
				plan.admission.auditOnly === true &&
				typeof plan.admission.recommendation === "string" &&
				Array.isArray(plan.admission.reasonCodes) &&
				plan.admission.reasonCodes.every((item) => typeof item === "string"))) &&
		(plan.sideEffectPolicy === undefined ||
			["read-only", "idempotent", "mutating"].includes(String(plan.sideEffectPolicy))) &&
		Array.isArray(plan.unsupportedGuarantees) &&
		plan.unsupportedGuarantees.every((item) => typeof item === "string") &&
		Array.isArray(plan.warnings) &&
		plan.warnings.every((item) => typeof item === "string") &&
		copyExecutionPlan(plan as ExecutionPlan).id === plan.id
	);
}

function executionPlanId(plan: Omit<ExecutionPlan, "id"> | Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function unsupported(contract: DelegationContract | undefined): string[] {
	if (!contract?.requestedAuthority) return [];
	const authority = contract.requestedAuthority;
	const result: string[] = [];
	if (authority.readPaths && authority.readPaths.length > 0) result.push("read-path-scope");
	if (authority.writePaths && authority.writePaths.length > 0) result.push("write-path-scope");
	if (authority.network === "denied") result.push("network-denial");
	if (authority.network === "required") result.push("network-availability");
	if (authority.secrets === "denied") result.push("secret-denial");
	if (authority.secrets === "required") result.push("secret-availability");
	return result;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
