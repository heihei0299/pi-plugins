import { createHash } from "node:crypto";
import { type ExecutionPlan, isExecutionPlan } from "./execution-plan.js";

export const CAPABILITY_GRANT_VERSION = "pi-subagents:capability-grant:v1" as const;

export interface CapabilityGrant {
	version: typeof CAPABILITY_GRANT_VERSION;
	id: string;
	executionPlanId: string;
	taskGeneration: number;
	effectiveTools?: string[];
	issuedAt: number;
	expiresAt: number;
	state: "active" | "revoked";
	revokedAt?: number;
	revocationReason?: string;
}

function grantId(projection: {
	executionPlanId: string;
	taskGeneration: number;
	effectiveTools?: string[];
	issuedAt: number;
	expiresAt: number;
}): string {
	return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

export function issueCapabilityGrant(
	plan: ExecutionPlan,
	issuedAt: number,
	lifetimeMs: number,
): CapabilityGrant {
	if (!Number.isFinite(issuedAt) || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
		throw new Error("Capability grant requires finite issuance and lifetime bounds");
	}
	const expiresAt = issuedAt + lifetimeMs;
	const projection = {
		executionPlanId: plan.id,
		taskGeneration: plan.taskGeneration,
		effectiveTools: plan.effectiveTools,
		issuedAt,
		expiresAt,
	};
	return {
		version: CAPABILITY_GRANT_VERSION,
		id: grantId(projection),
		...projection,
		state: "active",
	};
}

export function revokeCapabilityGrant(
	grant: CapabilityGrant,
	reason: string,
	revokedAt: number,
): CapabilityGrant {
	if (grant.state === "revoked") throw new Error("Capability grant is already revoked");
	grant.state = "revoked";
	grant.revokedAt = revokedAt;
	grant.revocationReason = reason.slice(0, 256);
	return structuredClone(grant);
}

export function isCapabilityGrant(value: unknown): value is CapabilityGrant {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const grant = value as Partial<CapabilityGrant>;
	const validShape =
		grant.version === CAPABILITY_GRANT_VERSION &&
		typeof grant.id === "string" &&
		/^[a-f0-9]{64}$/u.test(grant.id) &&
		typeof grant.executionPlanId === "string" &&
		/^[a-f0-9]{64}$/u.test(grant.executionPlanId) &&
		Number.isSafeInteger(grant.taskGeneration) &&
		Number(grant.taskGeneration) >= 0 &&
		Number.isFinite(grant.issuedAt) &&
		Number.isFinite(grant.expiresAt) &&
		Number(grant.expiresAt) >= Number(grant.issuedAt) &&
		(grant.state === "active" || grant.state === "revoked") &&
		(grant.state === "active"
			? grant.revokedAt === undefined && grant.revocationReason === undefined
			: Number.isFinite(grant.revokedAt) &&
				typeof grant.revocationReason === "string" &&
				grant.revocationReason.length > 0) &&
		(grant.effectiveTools === undefined ||
			(Array.isArray(grant.effectiveTools) &&
				grant.effectiveTools.every((tool) => typeof tool === "string")));
	if (!validShape) return false;
	const validated = grant as CapabilityGrant;
	const expectedId = grantId({
		executionPlanId: validated.executionPlanId,
		taskGeneration: validated.taskGeneration,
		effectiveTools: validated.effectiveTools,
		issuedAt: validated.issuedAt,
		expiresAt: validated.expiresAt,
	});
	return validated.id === expectedId;
}

export function isCapabilityGrantActive(
	grant: CapabilityGrant,
	plan: ExecutionPlan,
	now: number,
): boolean {
	return (
		isCapabilityGrant(grant) &&
		isExecutionPlan(plan) &&
		grant.state === "active" &&
		grant.executionPlanId === plan.id &&
		grant.taskGeneration === plan.taskGeneration &&
		JSON.stringify(grant.effectiveTools ?? null) === JSON.stringify(plan.effectiveTools ?? null) &&
		now >= grant.issuedAt &&
		now <= grant.expiresAt
	);
}
