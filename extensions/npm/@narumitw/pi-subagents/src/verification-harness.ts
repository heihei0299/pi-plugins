import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { redactPrivateText } from "./context.js";
import { appendBounded, truncateUtf8 } from "./limits.js";
import { terminateProcess } from "./runner.js";
import type { VerificationCheckReceipt } from "./verification-receipt.js";
import {
	captureWorkflowTreeIdentity,
	type WorkflowTreeIdentity,
} from "./workflow-tree-identity.js";

const execFileAsync = promisify(execFile);
const SAFE_COMMANDS = new Set(["git", "node", "npm", "npx"]);
const MAX_VISIBLE_FILES = 4096;
const MAX_CHANGED_PATH_BYTES = 8 * 1024;
const MAX_COPY_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_RECORDED_CHECK_OUTPUT_BYTES = 2 * 1024;
const DEFAULT_CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const VERIFICATION_KILL_GRACE_MS = 250;
const VERIFICATION_TERMINATION_DEADLINE_MS = VERIFICATION_KILL_GRACE_MS + 1_000;

export interface VerificationCheckRequest {
	id: string;
	command: string;
	args?: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface VerificationSubmission {
	treeIdentity: WorkflowTreeIdentity;
	baseRepositoryGeneration: string;
	patchDigest: string;
	changedPaths: string[];
	fileVersions: Record<string, string>;
}

export interface VerificationHarnessResult {
	disposableDirectory: string;
	checks: VerificationCheckReceipt[];
}

export async function captureVerificationSubmission(
	cwd: string,
	signal?: AbortSignal,
): Promise<VerificationSubmission> {
	throwIfAborted(signal);
	const repositoryRoot = await resolveRepositoryRoot(cwd, signal);
	const [treeIdentity, head, changed, untracked] = await Promise.all([
		captureWorkflowTreeIdentity(cwd, { signal }),
		git(repositoryRoot, ["rev-parse", "HEAD"], signal),
		git(repositoryRoot, ["diff", "--name-only", "-z", "HEAD", "--"], signal),
		git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
	]);
	throwIfAborted(signal);
	const baseRepositoryGeneration = head.trim();
	if (!/^[a-f0-9]{40,64}$/u.test(baseRepositoryGeneration)) {
		throw new Error("Verification submission has no stable repository generation");
	}
	const changedPaths = uniqueSorted([...splitNul(changed), ...splitNul(untracked)]);
	if (
		changedPaths.length > MAX_VISIBLE_FILES ||
		changedPaths.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0) >
			MAX_CHANGED_PATH_BYTES
	) {
		throw new Error("Verification submission exceeded its changed-path limit");
	}
	const fileVersions: Record<string, string> = {};
	for (const relative of changedPaths) {
		throwIfAborted(signal);
		assertSafeRelativePath(relative);
		const candidate = path.join(repositoryRoot, relative);
		try {
			const stat = await fs.promises.lstat(candidate);
			const value = stat.isSymbolicLink()
				? Buffer.from(await fs.promises.readlink(candidate), "utf8")
				: stat.isFile()
					? await readRegularFileNoFollow(candidate, stat, signal)
					: Buffer.from("unsupported", "utf8");
			fileVersions[relative] = createHash("sha256").update(value).digest("hex");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				fileVersions[relative] = "deleted";
				continue;
			}
			throw error;
		}
	}
	const patchDigest = createHash("sha256")
		.update("pi-subagents:verification-patch:v1\0")
		.update(baseRepositoryGeneration)
		.update("\0")
		.update(treeIdentity.digest)
		.digest("hex");
	return {
		treeIdentity,
		baseRepositoryGeneration,
		patchDigest,
		changedPaths,
		fileVersions,
	};
}

export async function runVerificationChecks(
	cwd: string,
	requests: readonly VerificationCheckRequest[],
	signal?: AbortSignal,
): Promise<VerificationHarnessResult> {
	validateVerificationChecks(requests);
	throwIfAborted(signal);
	const repositoryRoot = await resolveRepositoryRoot(cwd, signal);
	const disposableDirectory = await createDisposableDirectory(repositoryRoot);
	let registeredWorktree = false;
	try {
		// Treat setup as registered before awaiting so partial Git initialization is also pruned.
		registeredWorktree = true;
		await git(
			repositoryRoot,
			["worktree", "add", "--detach", "--no-checkout", disposableDirectory, "HEAD"],
			signal,
		);
		await copyVisibleSubmission(repositoryRoot, disposableDirectory, signal);
		const checks: VerificationCheckReceipt[] = [];
		for (const request of requests) {
			throwIfAborted(signal);
			checks.push(await runCheck(disposableDirectory, request, signal));
		}
		return { disposableDirectory, checks };
	} finally {
		await cleanupDisposableWorktree(repositoryRoot, disposableDirectory, registeredWorktree);
	}
}

async function createDisposableDirectory(repositoryRoot: string): Promise<string> {
	const dependencyRoot = path.join(repositoryRoot, "node_modules");
	let parent = os.tmpdir();
	try {
		const stat = await fs.promises.lstat(dependencyRoot);
		if (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			(await isIgnoredDependencyDirectory(repositoryRoot))
		) {
			parent = dependencyRoot;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return fs.promises.mkdtemp(path.join(parent, ".pi-subagents-verification-"));
}

async function isIgnoredDependencyDirectory(repositoryRoot: string): Promise<boolean> {
	try {
		await execFileAsync(
			"git",
			[
				"-C",
				repositoryRoot,
				"check-ignore",
				"--quiet",
				"node_modules/.pi-subagents-verification-probe",
			],
			{ encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
		);
		return true;
	} catch (error) {
		if ((error as { code?: string | number }).code === 1) return false;
		throw error;
	}
}

async function cleanupDisposableWorktree(
	repositoryRoot: string,
	disposableDirectory: string,
	registered: boolean,
): Promise<void> {
	let removedRegistration = !registered;
	if (registered) {
		try {
			await execFileAsync(
				"git",
				["-C", repositoryRoot, "worktree", "remove", "--force", "--force", disposableDirectory],
				{ encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
			);
			removedRegistration = true;
		} catch {
			// Remove the directory first, then let Git prune its now-stale registration below.
		}
	}
	await fs.promises.rm(disposableDirectory, { recursive: true, force: true });
	if (!removedRegistration) {
		try {
			await execFileAsync("git", ["-C", repositoryRoot, "worktree", "prune"], {
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024,
			});
		} catch {
			throw new Error("Verification harness could not clean its disposable Git worktree");
		}
	}
}

async function copyVisibleSubmission(
	repositoryRoot: string,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	const output = await git(
		repositoryRoot,
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		signal,
	);
	const files = uniqueSorted(splitNul(output));
	if (files.length > MAX_VISIBLE_FILES) {
		throw new Error("Verification disposable copy exceeded its file limit");
	}
	let copiedBytes = 0;
	for (const relative of files) {
		throwIfAborted(signal);
		assertSafeRelativePath(relative);
		const source = path.join(repositoryRoot, relative);
		const target = path.join(destination, relative);
		let stat: fs.Stats;
		try {
			stat = await fs.promises.lstat(source);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		if (stat.isSymbolicLink()) {
			const link = await fs.promises.readlink(source);
			const resolvedLink = path.resolve(path.dirname(target), link);
			if (resolvedLink !== destination && !resolvedLink.startsWith(`${destination}${path.sep}`)) {
				throw new Error("Verification disposable copy rejected an external symlink");
			}
			copiedBytes += Buffer.byteLength(link, "utf8");
			await fs.promises.symlink(link, target);
		} else if (stat.isFile()) {
			if (stat.size > MAX_COPY_BYTES - copiedBytes) {
				throw new Error("Verification disposable copy exceeded its byte limit");
			}
			const bytes = await readRegularFileNoFollow(source, stat, signal);
			copiedBytes += bytes.length;
			await fs.promises.writeFile(target, bytes, { flag: "wx", mode: stat.mode });
		} else {
			throw new Error("Verification disposable copy encountered an unsupported file type");
		}
	}
}

async function readRegularFileNoFollow(
	filePath: string,
	expected: fs.Stats,
	signal?: AbortSignal,
): Promise<Buffer> {
	throwIfAborted(signal);
	const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
			throw new Error("Verification disposable source changed during copy");
		}
		const bytes = await handle.readFile({ signal });
		const after = await handle.stat();
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs
		) {
			throw new Error("Verification disposable source changed during copy");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function runCheck(
	root: string,
	request: VerificationCheckRequest,
	signal?: AbortSignal,
): Promise<VerificationCheckReceipt> {
	const startedAt = Date.now();
	const checkCwd = path.resolve(root, request.cwd ?? ".");
	if (checkCwd !== root && !checkCwd.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Unsafe verification cwd for ${request.id}`);
	}
	throwIfAborted(signal);
	const result = await executeCheckProcess(
		request.command,
		request.args ?? [],
		checkCwd,
		request.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
		signal,
	);
	if (result.aborted) throw abortError();
	const boundedStdout = truncateUtf8(
		redactPrivateText(result.stdout),
		MAX_RECORDED_CHECK_OUTPUT_BYTES,
	);
	const boundedStderr = truncateUtf8(
		redactPrivateText(result.stderr),
		MAX_RECORDED_CHECK_OUTPUT_BYTES,
	);
	return {
		id: request.id,
		command: request.command,
		args: (request.args ?? []).map(redactPrivateText),
		cwd: redactPrivateText(request.cwd ?? "."),
		status: result.exitCode === 0 ? "passed" : "failed",
		exitCode: result.exitCode,
		stdout: boundedStdout.text,
		stderr: boundedStderr.text,
		durationMs: Math.max(0, Date.now() - startedAt),
		truncated: result.truncated || boundedStdout.truncated || boundedStderr.truncated,
	};
}

interface CheckProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	aborted: boolean;
}

function executeCheckProcess(
	command: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<CheckProcessResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let aborted = false;
		let timedOut = false;
		let outputExceeded = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let terminationDeadline: NodeJS.Timeout | undefined;
		let cleanupTermination: (() => void) | undefined;
		let abortHandler: (() => void) | undefined;
		const proc = spawn(command, args, {
			cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: verificationEnvironment(),
		});
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (terminationDeadline) clearTimeout(terminationDeadline);
			cleanupTermination?.();
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
			resolve({ exitCode, stdout, stderr, truncated, aborted });
		};
		const beginTermination = () => {
			if (cleanupTermination || settled) return;
			cleanupTermination = terminateProcess(proc, VERIFICATION_KILL_GRACE_MS);
			terminationDeadline = setTimeout(() => {
				proc.stdout?.destroy();
				proc.stderr?.destroy();
				finish(aborted ? 130 : timedOut ? 124 : -1);
			}, VERIFICATION_TERMINATION_DEADLINE_MS);
			terminationDeadline.unref();
		};
		const appendOutput = (current: string, chunk: Buffer): string => {
			const appended = appendBounded(current, chunk.toString(), MAX_COMMAND_OUTPUT_BYTES);
			truncated ||= appended.truncated;
			if (appended.truncated && !outputExceeded) {
				outputExceeded = true;
				beginTermination();
			}
			return appended.text;
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendOutput(stdout, chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendOutput(stderr, chunk);
		});
		proc.once("close", (code) => {
			finish(aborted ? 130 : timedOut ? 124 : outputExceeded ? -1 : (code ?? -1));
		});
		proc.once("error", (error) => {
			const appended = appendBounded(stderr, error.message, MAX_COMMAND_OUTPUT_BYTES);
			stderr = appended.text;
			truncated ||= appended.truncated;
			if (proc.pid) beginTermination();
			else finish(-1);
		});

		timeout = setTimeout(() => {
			timedOut = true;
			beginTermination();
		}, timeoutMs);
		timeout.unref();
		if (signal) {
			abortHandler = () => {
				aborted = true;
				beginTermination();
			};
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}

export function validateVerificationChecks(requests: readonly VerificationCheckRequest[]): void {
	if (requests.length > 32) throw new Error("Too many deterministic verification checks");
	const ids = new Set<string>();
	for (const request of requests) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.id) || ids.has(request.id)) {
			throw new Error("Verification checks require unique bounded ids");
		}
		ids.add(request.id);
		if (!SAFE_COMMANDS.has(request.command)) {
			throw new Error(`Unsafe verification command: ${request.command}`);
		}
		if ((request.args?.length ?? 0) > 64)
			throw new Error("Too many verification command arguments");
		if (
			request.args?.some(
				(value) => typeof value !== "string" || value.includes("\0") || value.length > 4096,
			)
		) {
			throw new Error("Unsafe verification command argument");
		}
		if (request.cwd !== undefined) assertSafeRelativePath(request.cwd);
		if (
			request.timeoutMs !== undefined &&
			(!Number.isSafeInteger(request.timeoutMs) ||
				request.timeoutMs < 1 ||
				request.timeoutMs > 600_000)
		) {
			throw new Error("Invalid verification check timeout");
		}
	}
}

async function resolveRepositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	let canonical: string;
	try {
		canonical = await fs.promises.realpath(path.resolve(cwd));
	} catch {
		throw new Error("Verification harness requires a readable Git repository directory");
	}
	const root = (await git(canonical, ["rev-parse", "--show-toplevel"], signal)).trim();
	return fs.promises.realpath(root);
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	try {
		const result = await execFileAsync("git", ["-C", cwd, ...args], {
			signal,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		return result.stdout;
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			throw abortError();
		}
		throw new Error("Verification harness could not inspect the Git repository");
	}
}

function verificationEnvironment(): NodeJS.ProcessEnv {
	const allowed = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"];
	return Object.fromEntries(
		allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
	);
}

function splitNul(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertSafeRelativePath(value: string): void {
	if (
		!value ||
		value.includes("\0") ||
		path.isAbsolute(value) ||
		path.normalize(value).split(path.sep).includes("..")
	) {
		throw new Error("Verification harness encountered an unsafe relative path");
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function abortError(): Error {
	const error = new Error("Verification harness was cancelled");
	error.name = "AbortError";
	return error;
}
