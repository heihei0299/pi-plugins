import * as path from "node:path";

export interface ManagedIntegrationExpectation {
	taskId: string;
	taskGeneration: number;
	baseRepositoryGeneration: string;
	dependencyVersions: Record<string, string>;
	readSetVersions: Record<string, string>;
	executionPlanId: string;
	allowedScopes: string[];
	patchDigest: string;
	requiredEvidence: string[];
}

export interface ManagedIntegrationCandidate extends ManagedIntegrationExpectation {
	changedPaths: string[];
	evidence: Record<string, string>;
	verifier: {
		freshContext: boolean;
		exactIntegratedTree: boolean;
		status: "accepted" | "rework" | "rejected";
	};
}

export interface ManagedIntegrationAcceptance {
	status: "accepted";
	taskId: string;
	taskGeneration: number;
	patchDigest: string;
	executionPlanId: string;
}

export function verifyManagedIntegration(
	expected: ManagedIntegrationExpectation,
	candidate: ManagedIntegrationCandidate,
): ManagedIntegrationAcceptance {
	if (
		candidate.taskId !== expected.taskId ||
		candidate.taskGeneration !== expected.taskGeneration
	) {
		throw new Error("Managed integration rejected stale task generation");
	}
	if (candidate.baseRepositoryGeneration !== expected.baseRepositoryGeneration) {
		throw new Error("Managed integration rejected stale base repository generation");
	}
	if (candidate.executionPlanId !== expected.executionPlanId) {
		throw new Error("Managed integration rejected stale execution plan identity");
	}
	if (!sameRecord(candidate.dependencyVersions, expected.dependencyVersions)) {
		throw new Error("Managed integration rejected stale dependency versions");
	}
	if (!sameRecord(candidate.readSetVersions, expected.readSetVersions)) {
		throw new Error("Managed integration rejected stale read-set versions");
	}
	if (candidate.patchDigest !== expected.patchDigest) {
		throw new Error("Managed integration rejected patch digest mismatch");
	}
	const allowedScopes = expected.allowedScopes.map(normalizedPath);
	if (
		!candidate.changedPaths.every((changedPath) => {
			const normalizedChangedPath = normalizedPath(changedPath);
			return allowedScopes.some(
				(scope) =>
					normalizedChangedPath === scope ||
					normalizedChangedPath.startsWith(`${scope}${path.sep}`),
			);
		})
	) {
		throw new Error("Managed integration rejected a path outside the accepted scope");
	}
	if (expected.requiredEvidence.some((id) => !candidate.evidence[id])) {
		throw new Error("Managed integration rejected missing required evidence");
	}
	if (!candidate.verifier.freshContext || !candidate.verifier.exactIntegratedTree) {
		throw new Error("Managed integration requires a fresh verifier on the exact integrated tree");
	}
	if (candidate.verifier.status !== "accepted") {
		throw new Error(`Managed integration verifier returned ${candidate.verifier.status}`);
	}
	return {
		status: "accepted",
		taskId: expected.taskId,
		taskGeneration: expected.taskGeneration,
		patchDigest: expected.patchDigest,
		executionPlanId: expected.executionPlanId,
	};
}

function normalizedPath(value: string): string {
	if (!value || value.includes("\0")) throw new Error("Managed integration scope is invalid");
	return path.resolve(path.sep, value.replaceAll("\\", path.sep));
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
	const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
	const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}
