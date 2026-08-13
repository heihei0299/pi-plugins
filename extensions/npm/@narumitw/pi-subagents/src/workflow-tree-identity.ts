import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const WORKFLOW_TREE_IDENTITY_VERSION = "pi-subagents:workflow-tree:v1" as const;
export const DEFAULT_WORKFLOW_TREE_MAX_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILES = 256;

export interface WorkflowTreeIdentity {
	version: typeof WORKFLOW_TREE_IDENTITY_VERSION;
	kind: "git-commit" | "git-dirty";
	digest: string;
}

export interface CaptureWorkflowTreeIdentityOptions {
	maxBytes?: number;
	signal?: AbortSignal;
}

export async function captureWorkflowTreeIdentity(
	cwd: string,
	options: CaptureWorkflowTreeIdentityOptions = {},
): Promise<WorkflowTreeIdentity> {
	const maxBytes = options.maxBytes ?? DEFAULT_WORKFLOW_TREE_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error("Workflow tree identity maxBytes must be a positive safe integer");
	}
	throwIfAborted(options.signal);
	let canonicalCwd: string;
	try {
		canonicalCwd = await fs.promises.realpath(path.resolve(cwd));
	} catch {
		throw new Error("Workflow verification requires a readable Git repository directory");
	}
	const rootOutput = await git(
		canonicalCwd,
		["rev-parse", "--show-toplevel"],
		64 * 1024,
		options.signal,
	).catch((error) => {
		throw normalizedGitError(error, "Workflow verification requires a Git repository");
	});
	let repositoryRoot: string;
	try {
		repositoryRoot = await fs.promises.realpath(rootOutput.toString("utf8").trim());
	} catch {
		throw new Error("Workflow verification requires a readable Git repository root");
	}
	const relativeCwd = path.relative(repositoryRoot, canonicalCwd);
	if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
		throw new Error("Workflow verification cwd is outside its Git repository");
	}
	const submodules = await git(
		repositoryRoot,
		["submodule", "status", "--recursive"],
		64 * 1024,
		options.signal,
	).catch((error) => {
		throw normalizedGitError(error, "Workflow tree identity could not inspect submodules");
	});
	if (submodules.toString("utf8").trim()) {
		throw new Error("Workflow tree identity does not support repositories with submodules");
	}
	const head = (
		await git(repositoryRoot, ["rev-parse", "HEAD"], 64 * 1024, options.signal).catch((error) => {
			throw normalizedGitError(error, "Workflow verification requires a stable Git HEAD");
		})
	)
		.toString("utf8")
		.trim();
	if (!/^[a-f0-9]{40,64}$/u.test(head)) {
		throw new Error("Workflow verification requires a stable Git HEAD");
	}
	const commandLimit = maxBytes + 1;
	const indexDiff = await git(
		repositoryRoot,
		["diff", "--binary", "--no-ext-diff", "--cached", "HEAD", "--"],
		commandLimit,
		options.signal,
	).catch((error) => {
		throw normalizedGitError(error, "Workflow tree identity exceeded its size limit");
	});
	const worktreeDiff = await git(
		repositoryRoot,
		["diff", "--binary", "--no-ext-diff", "--"],
		commandLimit,
		options.signal,
	).catch((error) => {
		throw normalizedGitError(error, "Workflow tree identity exceeded its size limit");
	});
	if (indexDiff.length > maxBytes || worktreeDiff.length > maxBytes) {
		throw new Error("Workflow tree identity exceeded its size limit");
	}
	const untrackedOutput = await git(
		repositoryRoot,
		["ls-files", "--others", "--exclude-standard", "-z"],
		commandLimit,
		options.signal,
	).catch((error) => {
		throw normalizedGitError(error, "Workflow tree identity exceeded its size limit");
	});
	const untrackedEntries = splitNul(untrackedOutput).sort(Buffer.compare);
	if (untrackedEntries.length > MAX_UNTRACKED_FILES) {
		throw new Error("Workflow tree identity exceeded its untracked-file limit");
	}
	if (indexDiff.length === 0 && worktreeDiff.length === 0 && untrackedEntries.length === 0) {
		return identity("git-commit", hashParts([Buffer.from("commit\0"), Buffer.from(head)]));
	}
	let consumed = indexDiff.length + worktreeDiff.length + untrackedOutput.length;
	if (consumed > maxBytes) throw new Error("Workflow tree identity exceeded its size limit");
	const hasher = createHash("sha256");
	hasher.update("pi-subagents:workflow-tree:v1\0");
	updateHashFrame(hasher, "head", head);
	updateHashFrame(hasher, "index-diff", indexDiff);
	updateHashFrame(hasher, "worktree-diff", worktreeDiff);
	for (const rawRelativePath of untrackedEntries) {
		throwIfAborted(options.signal);
		const relativePath = decodeGitPath(rawRelativePath);
		const candidate = path.resolve(repositoryRoot, relativePath);
		const relative = path.relative(repositoryRoot, candidate);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error("Workflow tree identity encountered an unsafe untracked path");
		}
		let bytes: Buffer;
		let kind: string;
		try {
			const stat = await fs.promises.lstat(candidate);
			if (stat.isSymbolicLink()) {
				kind = "symlink";
				bytes = Buffer.from(await fs.promises.readlink(candidate), "utf8");
			} else if (stat.isFile()) {
				kind = "file";
				if (stat.size > maxBytes - consumed) {
					throw new Error("Workflow tree identity exceeded its size limit");
				}
				bytes = await readRegularFileNoFollow(candidate, stat, options.signal);
			} else {
				throw new Error("Workflow tree identity encountered an unsupported untracked file type");
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			if (error instanceof Error && error.message.startsWith("Workflow tree identity")) {
				throw error;
			}
			throw new Error("Workflow tree identity could not read an untracked entry");
		}
		consumed += rawRelativePath.length + bytes.length;
		if (consumed > maxBytes) throw new Error("Workflow tree identity exceeded its size limit");
		updateHashFrame(hasher, "untracked-kind", kind);
		updateHashFrame(hasher, "untracked-path", rawRelativePath);
		updateHashFrame(hasher, "untracked-content", bytes);
	}
	return identity("git-dirty", hasher.digest("hex"));
}

export function sameWorkflowTreeIdentity(
	left: WorkflowTreeIdentity,
	right: WorkflowTreeIdentity,
): boolean {
	return (
		isWorkflowTreeIdentity(left) &&
		isWorkflowTreeIdentity(right) &&
		left.kind === right.kind &&
		left.digest === right.digest
	);
}

export function isWorkflowTreeIdentity(value: unknown): value is WorkflowTreeIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<WorkflowTreeIdentity>;
	if (
		Object.keys(value as Record<string, unknown>).some(
			(key) => !["version", "kind", "digest"].includes(key),
		)
	) {
		return false;
	}
	return (
		candidate.version === WORKFLOW_TREE_IDENTITY_VERSION &&
		(candidate.kind === "git-commit" || candidate.kind === "git-dirty") &&
		typeof candidate.digest === "string" &&
		/^[a-f0-9]{64}$/u.test(candidate.digest)
	);
}

function identity(kind: WorkflowTreeIdentity["kind"], digest: string): WorkflowTreeIdentity {
	return { version: WORKFLOW_TREE_IDENTITY_VERSION, kind, digest };
}

function hashParts(parts: Buffer[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex");
}

function updateHashFrame(hash: Hash, label: string, value: string | Buffer): void {
	const labelBytes = Buffer.from(label, "utf8");
	const valueBytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
	const header = Buffer.allocUnsafe(8);
	header.writeUInt32BE(labelBytes.length, 0);
	header.writeUInt32BE(valueBytes.length, 4);
	hash.update(header);
	hash.update(labelBytes);
	hash.update(valueBytes);
}

function splitNul(value: Buffer): Buffer[] {
	const entries: Buffer[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== 0) continue;
		if (index > start) entries.push(value.subarray(start, index));
		start = index + 1;
	}
	if (start < value.length) entries.push(value.subarray(start));
	return entries;
}

function decodeGitPath(value: Buffer): string {
	const decoded = value.toString("utf8");
	if (!decoded || decoded.includes("\0") || !Buffer.from(decoded, "utf8").equals(value)) {
		throw new Error("Workflow tree identity encountered an unsupported Git path encoding");
	}
	return decoded;
}

async function readRegularFileNoFollow(
	filePath: string,
	expected: fs.Stats,
	signal: AbortSignal | undefined,
): Promise<Buffer> {
	throwIfAborted(signal);
	const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
			throw new Error("Workflow tree identity file changed during capture");
		}
		const content = await handle.readFile({ signal });
		const after = await handle.stat();
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs
		) {
			throw new Error("Workflow tree identity file changed during capture");
		}
		return content;
	} finally {
		await handle.close();
	}
}

function git(
	cwd: string,
	args: string[],
	maxBuffer: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ encoding: "buffer", maxBuffer, signal },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("Workflow tree identity capture was cancelled");
	error.name = "AbortError";
	throw error;
}

function normalizedGitError(error: unknown, fallback: string): Error {
	if (error instanceof Error && error.name === "AbortError") return error;
	const message = error instanceof Error ? error.message : String(error);
	return new Error(
		/maxBuffer|stdout.*large|SIGTERM/iu.test(message) ? `${fallback}: size limit` : fallback,
	);
}
