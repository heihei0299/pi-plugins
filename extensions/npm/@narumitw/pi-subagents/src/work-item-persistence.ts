import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { redactPrivateText } from "./context.js";
import { WorkItemLedger, type WorkItemLedgerSnapshot } from "./work-item-ledger.js";

const WORKFLOW_STATE_DIRECTORY = "pi-subagents-workflows";
const DEFAULT_MAX_STORED_WORKFLOWS = 64;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WORKFLOW_STATE_BYTES = 1024 * 1024;

export interface SessionWorkflowPersistenceOptions {
	stateDir?: string;
	maxStoredWorkflows?: number;
	retentionMs?: number;
}

export interface SessionWorkflowInspection {
	workflows: WorkItemLedgerSnapshot[];
	invalid: number;
	omitted: number;
}

export class WorkItemPersistence {
	constructor(
		readonly filePath: string,
		private readonly afterSave?: () => Promise<void>,
	) {}

	async save(snapshot: WorkItemLedgerSnapshot): Promise<void> {
		const filePath = path.resolve(this.filePath);
		const sanitized = sanitizeWorkflowSnapshot(snapshot);
		const content = `${JSON.stringify(sanitized)}\n`;
		if (Buffer.byteLength(content, "utf8") > MAX_WORKFLOW_STATE_BYTES) {
			throw new Error("WorkItem workflow state exceeds the persistence size limit");
		}
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
			const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			try {
				await fs.promises.writeFile(temporary, content, { mode: 0o600 });
				await fs.promises.rename(temporary, filePath);
			} finally {
				await fs.promises.rm(temporary, { force: true });
			}
		});
		await this.afterSave?.();
	}

	load(): WorkItemLedger | undefined {
		const filePath = path.resolve(this.filePath);
		let source: string;
		try {
			const stat = fs.statSync(filePath);
			if (stat.size > MAX_WORKFLOW_STATE_BYTES)
				throw new Error("workflow state exceeds size limit");
			source = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			return WorkItemLedger.restore(JSON.parse(source) as WorkItemLedgerSnapshot);
		} catch {
			const quarantine = `${filePath}.invalid-${Date.now()}`;
			try {
				fs.renameSync(filePath, quarantine);
			} catch {
				// A concurrent owner may already have handled the invalid file.
			}
			return undefined;
		}
	}
}

export function createSessionWorkItemPersistence(
	owner: string,
	workflowId: string,
	options: SessionWorkflowPersistenceOptions = {},
): WorkItemPersistence {
	const maxStoredWorkflows = options.maxStoredWorkflows ?? DEFAULT_MAX_STORED_WORKFLOWS;
	const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
	if (!Number.isSafeInteger(maxStoredWorkflows) || maxStoredWorkflows < 1) {
		throw new Error("maxStoredWorkflows must be a positive safe integer");
	}
	if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
		throw new Error("workflow retentionMs must be a positive finite number");
	}
	const stateDir = resolveStateDirectory(options.stateDir);
	const prefix = sessionPrefix(owner);
	const filePath = path.join(stateDir, `${prefix}-${stableId(workflowId)}.json`);
	return new WorkItemPersistence(filePath, () =>
		pruneSessionWorkflows(stateDir, prefix, maxStoredWorkflows, retentionMs),
	);
}

export function inspectSessionWorkflows(
	owner: string,
	options: SessionWorkflowPersistenceOptions = {},
): SessionWorkflowInspection {
	const stateDir = resolveStateDirectory(options.stateDir);
	const prefix = `${sessionPrefix(owner)}-`;
	const limit = options.maxStoredWorkflows ?? DEFAULT_MAX_STORED_WORKFLOWS;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("maxStoredWorkflows must be a positive safe integer");
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(stateDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { workflows: [], invalid: 0, omitted: 0 };
		}
		throw error;
	}
	const candidates = entries
		.filter(
			(entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"),
		)
		.map((entry) => {
			const filePath = path.join(stateDir, entry.name);
			return { filePath, modifiedAt: safeModifiedAt(filePath) };
		})
		.sort((left, right) => right.modifiedAt - left.modifiedAt);
	const workflows: WorkItemLedgerSnapshot[] = [];
	let invalid = 0;
	for (const candidate of candidates.slice(0, limit)) {
		try {
			const stat = fs.statSync(candidate.filePath);
			if (stat.size > MAX_WORKFLOW_STATE_BYTES)
				throw new Error("workflow state exceeds size limit");
			const source = fs.readFileSync(candidate.filePath, "utf8");
			workflows.push(
				WorkItemLedger.restore(JSON.parse(source) as WorkItemLedgerSnapshot).snapshot(),
			);
		} catch {
			invalid++;
		}
	}
	return { workflows, invalid, omitted: Math.max(0, candidates.length - limit) };
}

function safeModifiedAt(filePath: string): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

function resolveStateDirectory(stateDir: string | undefined): string {
	return path.resolve(stateDir ?? path.join(getAgentDir(), WORKFLOW_STATE_DIRECTORY));
}

function sessionPrefix(owner: string): string {
	return stableId(`session:${owner}`);
}

function stableId(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function pruneSessionWorkflows(
	stateDir: string,
	prefix: string,
	maxStoredWorkflows: number,
	retentionMs: number,
): Promise<void> {
	await withFileMutationQueue(path.join(stateDir, `${prefix}.prune`), async () => {
		const cutoff = Date.now() - retentionMs;
		const entries = (await fs.promises.readdir(stateDir, { withFileTypes: true }))
			.filter(
				(entry) =>
					entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".json"),
			)
			.map((entry) => path.join(stateDir, entry.name));
		const records = await Promise.all(
			entries.map(async (filePath) => ({
				filePath,
				modifiedAt: (await fs.promises.stat(filePath)).mtimeMs,
			})),
		);
		records.sort((left, right) => right.modifiedAt - left.modifiedAt);
		await Promise.all(
			records
				.filter((record, index) => index >= maxStoredWorkflows || record.modifiedAt < cutoff)
				.map((record) => fs.promises.rm(record.filePath, { force: true })),
		);
	});
}

function sanitizeWorkflowSnapshot(snapshot: WorkItemLedgerSnapshot): WorkItemLedgerSnapshot {
	const sanitized = structuredClone(snapshot);
	for (const item of sanitized.items) {
		item.objective = redact(item.objective);
		item.selectedAgentName = item.selectedAgentName ? redact(item.selectedAgentName) : undefined;
		item.requiredCapabilities = item.requiredCapabilities.map(redact);
		item.requiredTools = item.requiredTools.map(redact);
		item.readPaths = item.readPaths.map(redact);
		item.writePaths = item.writePaths.map(redact);
		item.ownershipKeys = item.ownershipKeys.map(redact);
		item.acceptanceCriteria = item.acceptanceCriteria.map(redact);
		item.requiredEvidence = item.requiredEvidence.map(redact);
		item.invalidationReasons = item.invalidationReasons.map(redact);
		item.outcomeReason = item.outcomeReason ? redact(item.outcomeReason) : undefined;
		if (item.verificationReceipt) {
			item.verificationReceipt.summary = redact(item.verificationReceipt.summary);
			item.verificationReceipt.evidence = item.verificationReceipt.evidence.map(redact);
			item.verificationReceipt.limitations = item.verificationReceipt.limitations.map(redact);
		}
		for (const receipt of [
			...item.acceptanceReceiptHistory,
			...(item.acceptanceReceipt ? [item.acceptanceReceipt] : []),
		]) {
			receipt.summary = redact(receipt.summary);
			receipt.findings = receipt.findings.map(redact);
			receipt.changedPaths = receipt.changedPaths.map(redact);
			receipt.allowedScopes = receipt.allowedScopes.map(redact);
			receipt.acceptanceCriteria = receipt.acceptanceCriteria.map(redact);
			receipt.requiredEvidenceIds = receipt.requiredEvidenceIds.map(redact);
			receipt.dependencyVersions = redactRecord(receipt.dependencyVersions);
			receipt.readSetVersions = redactRecord(receipt.readSetVersions);
			receipt.evidence = redactRecord(receipt.evidence);
			for (const check of receipt.checks) {
				check.stdout = redact(check.stdout);
				check.stderr = redact(check.stderr);
			}
		}
		if (item.submission) {
			item.submission.changedPaths = item.submission.changedPaths.map(redact);
			item.submission.fileVersions = Object.fromEntries(
				Object.entries(item.submission.fileVersions).map(([key, value]) => [redact(key), value]),
			);
		}
		for (const artifact of [...item.artifacts, ...item.artifactHistory]) {
			artifact.kind = redact(artifact.kind);
			artifact.version = redact(artifact.version);
			artifact.digest = artifact.digest ? redact(artifact.digest) : undefined;
		}
	}
	WorkItemLedger.restore(sanitized);
	return sanitized;
}

function redactRecord(value: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [redact(key), redact(item)]),
	);
}

function redact(value: string): string {
	return redactPrivateText(value).trim();
}
