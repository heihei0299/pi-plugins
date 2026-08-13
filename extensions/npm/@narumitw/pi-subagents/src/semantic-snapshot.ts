import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SEMANTIC_SNAPSHOT_VERSION = "pi-subagents:semantic-snapshot:v1" as const;
const SEMANTIC_COMPONENT_KEYS = [
	"agent",
	"rolePrompt",
	"tools",
	"model",
	"thinkingLevel",
	"transport",
	"trust",
	"repository",
	"artifacts",
	"workflowGeneration",
	"schedulerPolicy",
] as const;

export interface SemanticSnapshotInput {
	agentName: string;
	agentManifest?: unknown;
	rolePrompt: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: string;
	transport: string;
	trust: { kind: string; projectTrusted: boolean };
	repository: { kind: string; generation: string };
	artifacts: Record<string, string>;
	workflowGeneration: number;
	schedulerPolicy: string;
}

export interface SemanticSnapshot {
	version: typeof SEMANTIC_SNAPSHOT_VERSION;
	digest: string;
	components: {
		agent: string;
		rolePrompt: string;
		tools: string;
		model: string;
		thinkingLevel: string;
		transport: string;
		trust: string;
		repository: string;
		artifacts: string;
		workflowGeneration: string;
		schedulerPolicy: string;
	};
}

export interface RepositoryGeneration {
	kind: "git-commit" | "git-dirty" | "filesystem";
	generation: string;
}

export interface SemanticCompatibility {
	status: "compatible" | "warning" | "needs-revalidation" | "rejected";
	changedComponents: string[];
}

export async function captureRepositoryGeneration(cwd: string): Promise<RepositoryGeneration> {
	const resolved = await fs.promises.realpath(path.resolve(cwd));
	try {
		const result = await execFileAsync(
			"git",
			["-C", resolved, "status", "--porcelain=v2", "--branch", "--untracked-files=all"],
			{ encoding: "utf8", timeout: 2_000, maxBuffer: 256 * 1024 },
		);
		const lines = result.stdout.split("\n");
		const head = lines
			.find((line) => line.startsWith("# branch.oid "))
			?.slice("# branch.oid ".length)
			.trim();
		if (!head || head === "(initial)") throw new Error("Repository has no stable HEAD");
		const status = lines.filter((line) => line && !line.startsWith("# ")).join("\n");
		return status
			? { kind: "git-dirty", generation: digest({ head, status }) }
			: { kind: "git-commit", generation: head };
	} catch {
		return {
			kind: "filesystem",
			generation: digest({ path: resolved, failClosedNonce: randomUUID() }),
		};
	}
}

export async function captureSemanticResourceGeneration(paths: string[]): Promise<string> {
	const entries: Array<{ path: string; digest: string }> = [];
	let totalBytes = 0;
	const visit = async (candidate: string, label: string): Promise<void> => {
		if (entries.length >= 256 || totalBytes > 1024 * 1024) {
			throw new Error("Semantic resource snapshot exceeds bounds");
		}
		let stat: fs.Stats;
		try {
			stat = await fs.promises.lstat(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (stat.isSymbolicLink()) return;
		if (stat.isDirectory()) {
			const children = (await fs.promises.readdir(candidate)).sort();
			for (const child of children) await visit(path.join(candidate, child), `${label}/${child}`);
			return;
		}
		if (!stat.isFile()) return;
		totalBytes += stat.size;
		if (totalBytes > 1024 * 1024) throw new Error("Semantic resource snapshot exceeds bounds");
		entries.push({ path: label, digest: digestBytes(await fs.promises.readFile(candidate)) });
	};
	try {
		for (const [index, candidate] of paths.entries()) {
			await visit(path.resolve(candidate), `resource-${index}`);
		}
		return digest(entries);
	} catch {
		return digest({ failClosedNonce: randomUUID() });
	}
}

export function captureSemanticSnapshot(input: SemanticSnapshotInput): SemanticSnapshot {
	if (!Number.isSafeInteger(input.workflowGeneration) || input.workflowGeneration < 0) {
		throw new Error("workflowGeneration must be a non-negative safe integer");
	}
	const components = {
		agent: digest({ name: input.agentName, manifest: input.agentManifest ?? null }),
		rolePrompt: digest(input.rolePrompt),
		tools: digest([...(input.tools ?? [])].sort()),
		model: digest(input.model ?? null),
		thinkingLevel: digest(input.thinkingLevel ?? null),
		transport: digest(input.transport),
		trust: digest(input.trust),
		repository: digest(input.repository),
		artifacts: digest(input.artifacts),
		workflowGeneration: digest(input.workflowGeneration),
		schedulerPolicy: digest(input.schedulerPolicy),
	};
	return {
		version: SEMANTIC_SNAPSHOT_VERSION,
		digest: digest(components),
		components,
	};
}

export function isSemanticSnapshot(value: unknown): value is SemanticSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const snapshot = value as Partial<SemanticSnapshot>;
	return (
		snapshot.version === SEMANTIC_SNAPSHOT_VERSION &&
		typeof snapshot.digest === "string" &&
		/^[a-f0-9]{64}$/u.test(snapshot.digest) &&
		Boolean(snapshot.components) &&
		Object.keys(snapshot.components ?? {}).length === SEMANTIC_COMPONENT_KEYS.length &&
		SEMANTIC_COMPONENT_KEYS.every((key) =>
			/^[a-f0-9]{64}$/u.test(snapshot.components?.[key] ?? ""),
		) &&
		digest(snapshot.components) === snapshot.digest
	);
}

export function evaluateSemanticCompatibility(
	previous: SemanticSnapshot,
	current: SemanticSnapshot,
): SemanticCompatibility {
	if (
		previous.version !== SEMANTIC_SNAPSHOT_VERSION ||
		current.version !== SEMANTIC_SNAPSHOT_VERSION
	) {
		return { status: "rejected", changedComponents: ["version"] };
	}
	if (!isSemanticSnapshot(previous) || !isSemanticSnapshot(current)) {
		return { status: "rejected", changedComponents: ["invalid-snapshot"] };
	}
	if (previous.digest === current.digest) {
		return { status: "compatible", changedComponents: [] };
	}
	const changedComponents = SEMANTIC_COMPONENT_KEYS.filter(
		(key) => previous.components[key] !== current.components[key],
	).sort();
	const warningOnly = changedComponents.every((key) => key === "schedulerPolicy");
	return {
		status: warningOnly ? "warning" : "needs-revalidation",
		changedComponents,
	};
}

function digest(value: unknown): string {
	return digestBytes(stableStringify(value));
}

function digestBytes(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortValue(entry)]),
	);
}
