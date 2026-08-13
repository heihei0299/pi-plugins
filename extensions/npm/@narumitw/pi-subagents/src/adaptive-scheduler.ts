import * as path from "node:path";
import type { WorkItemLedgerSnapshot, WorkItemRecord } from "./work-item-ledger.js";

export const ADAPTIVE_SCHEDULER_POLICY = "dependency-aware-v1" as const;

export type SchedulingReason =
	| "selected"
	| "dependency-not-ready"
	| "state-not-ready"
	| "budget-exhausted"
	| "capacity-exhausted"
	| "scope-conflict"
	| "verification-barrier";

export interface SchedulingDecisionItem {
	id: string;
	reason: SchedulingReason;
	criticalPathDepth: number;
}

export interface SchedulingDecision {
	policy: typeof ADAPTIVE_SCHEDULER_POLICY;
	workflowId: string;
	workflowGeneration: number;
	effectiveConcurrency: number;
	selected: string[];
	decisions: SchedulingDecisionItem[];
}

export interface AdaptiveSchedulerOptions {
	maxConcurrency: number;
	activeCount: number;
	transportCapacity: number;
	remainingBudgetMs: number;
	activeReadPaths?: string[];
	activeWritePaths?: string[];
	activeOwnershipKeys?: string[];
	activeMutatingCount?: number;
	maxMutatingConcurrency?: number;
}

export class AdaptiveScheduler {
	decide(snapshot: WorkItemLedgerSnapshot, options: AdaptiveSchedulerOptions): SchedulingDecision {
		validateOptions(options);
		const depth = criticalPathDepths(snapshot.items);
		const ready = snapshot.items
			.filter((item) => item.state === "ready")
			.sort(
				(left, right) =>
					(depth.get(right.id) ?? 0) - (depth.get(left.id) ?? 0) || left.id.localeCompare(right.id),
			);
		const availableSlots = Math.max(
			0,
			Math.min(
				options.maxConcurrency - options.activeCount,
				options.transportCapacity - options.activeCount,
				ready.length,
			),
		);
		const effectiveConcurrency = options.remainingBudgetMs > 0 ? availableSlots : 0;
		const readyVerifier = ready.find((item) => item.verifierFor !== undefined);
		if (readyVerifier) {
			const verifierMayStart = effectiveConcurrency > 0 && options.activeCount === 0;
			return {
				policy: ADAPTIVE_SCHEDULER_POLICY,
				workflowId: snapshot.workflowId,
				workflowGeneration: snapshot.generation,
				effectiveConcurrency: verifierMayStart ? 1 : 0,
				selected: verifierMayStart ? [readyVerifier.id] : [],
				decisions: snapshot.items
					.map((item) => ({
						id: item.id,
						reason:
							item.id === readyVerifier.id
								? verifierMayStart
									? ("selected" as const)
									: ("capacity-exhausted" as const)
								: item.state === "ready"
									? ("verification-barrier" as const)
									: item.state === "pending"
										? ("dependency-not-ready" as const)
										: ("state-not-ready" as const),
						criticalPathDepth: depth.get(item.id) ?? 0,
					}))
					.sort((left, right) => left.id.localeCompare(right.id)),
			};
		}
		const selected: string[] = [];
		let mutatingCount = options.activeMutatingCount ?? 0;
		const maxMutatingConcurrency = options.maxMutatingConcurrency ?? 2;
		const selectedReadPaths = normalizedScopes(options.activeReadPaths ?? []);
		const selectedWritePaths = normalizedScopes(options.activeWritePaths ?? []);
		const selectedOwnership = new Set(options.activeOwnershipKeys ?? []);
		const reasons = new Map<string, SchedulingReason>();
		for (const item of ready) {
			if (options.remainingBudgetMs <= 0) {
				reasons.set(item.id, "budget-exhausted");
				continue;
			}
			if (
				selected.length >= effectiveConcurrency ||
				(item.sideEffectPolicy !== "read-only" && mutatingCount >= maxMutatingConcurrency)
			) {
				reasons.set(item.id, "capacity-exhausted");
				continue;
			}
			if (hasConflict(item, selectedReadPaths, selectedWritePaths, selectedOwnership)) {
				reasons.set(item.id, "scope-conflict");
				continue;
			}
			selected.push(item.id);
			if (item.sideEffectPolicy !== "read-only") mutatingCount++;
			reasons.set(item.id, "selected");
			for (const scope of normalizedScopes(item.readPaths)) selectedReadPaths.add(scope);
			for (const scope of normalizedScopes(item.writePaths)) selectedWritePaths.add(scope);
			for (const key of item.ownershipKeys) selectedOwnership.add(key);
		}
		const decisions = snapshot.items
			.map((item) => ({
				id: item.id,
				reason:
					reasons.get(item.id) ??
					(item.state === "pending" ? "dependency-not-ready" : "state-not-ready"),
				criticalPathDepth: depth.get(item.id) ?? 0,
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
		return {
			policy: ADAPTIVE_SCHEDULER_POLICY,
			workflowId: snapshot.workflowId,
			workflowGeneration: snapshot.generation,
			effectiveConcurrency,
			selected,
			decisions,
		};
	}
}

function hasConflict(
	item: WorkItemRecord,
	readPaths: ReadonlySet<string>,
	writePaths: ReadonlySet<string>,
	ownership: ReadonlySet<string>,
): boolean {
	const candidateReads = normalizedScopes(item.readPaths);
	const candidateWrites = normalizedScopes(item.writePaths);
	return (
		[...candidateWrites].some(
			(scope) => overlapsAny(scope, readPaths) || overlapsAny(scope, writePaths),
		) ||
		[...candidateReads].some((scope) => overlapsAny(scope, writePaths)) ||
		item.ownershipKeys.some((key) => ownership.has(key))
	);
}

function normalizedScopes(values: readonly string[]): Set<string> {
	return new Set(values.map(normalizeScope));
}

function normalizeScope(value: string): string {
	const normalized = path.posix.normalize(value.trim().replace(/\\+/gu, "/"));
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:\//u.test(normalized)
	) {
		return "";
	}
	return normalized.replace(/^\.\//u, "").replace(/\/$/u, "");
}

function overlapsAny(scope: string, candidates: ReadonlySet<string>): boolean {
	return [...candidates].some((candidate) => scopesOverlap(scope, candidate));
}

function scopesOverlap(left: string, right: string): boolean {
	if (!left || !right || left === right) return true;
	return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function criticalPathDepths(items: WorkItemRecord[]): Map<string, number> {
	const byId = new Map(items.map((item) => [item.id, item]));
	const memo = new Map<string, number>();
	const visit = (id: string): number => {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		const item = byId.get(id);
		if (!item || item.dependents.length === 0) {
			memo.set(id, 0);
			return 0;
		}
		const value = 1 + Math.max(...item.dependents.map(visit));
		memo.set(id, value);
		return value;
	};
	for (const item of items) visit(item.id);
	return memo;
}

function validateOptions(options: AdaptiveSchedulerOptions): void {
	for (const [name, value] of [
		["maxConcurrency", options.maxConcurrency],
		["activeCount", options.activeCount],
		["transportCapacity", options.transportCapacity],
	] as const) {
		if (!Number.isSafeInteger(value) || value < (name === "activeCount" ? 0 : 1)) {
			throw new Error(
				`${name} must be a ${name === "activeCount" ? "non-negative" : "positive"} safe integer`,
			);
		}
	}
	for (const [name, value] of [
		["activeMutatingCount", options.activeMutatingCount ?? 0],
		["maxMutatingConcurrency", options.maxMutatingConcurrency ?? 2],
	] as const) {
		if (!Number.isSafeInteger(value) || value < (name === "activeMutatingCount" ? 0 : 1)) {
			throw new Error(`${name} has an invalid bound`);
		}
	}
	if (!Number.isFinite(options.remainingBudgetMs) || options.remainingBudgetMs < 0) {
		throw new Error("remainingBudgetMs must be a non-negative finite number");
	}
}
