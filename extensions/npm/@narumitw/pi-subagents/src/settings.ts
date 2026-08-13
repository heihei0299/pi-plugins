import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type {
	AgentConfig,
	CompletionDelivery,
	ConsultationCwdPolicy,
	ConsultResourcePolicy,
	DelegationCwdPolicy,
	SubagentAgentConfig,
	SubagentSettings,
	SubagentThinkingLevel,
	SubagentTransportKind,
} from "./agents/types.js";
import { MAX_CONFIGURABLE_PARALLEL_TASKS } from "./limits.js";
import {
	type BlockingParallelLimitSettingsSnapshot,
	buildBlockingParallelLimitSettingsSnapshot,
	buildCompletionDeliverySettingsSnapshot,
	buildConsultResourceSettingsSnapshot,
	buildCwdPolicySettingsSnapshot,
	buildDelegationWorkflowSettingsSnapshot,
	buildStatefulLimitSettingsSnapshot,
	buildStatefulTransportSettingsSnapshot,
	buildSubagentSettingsSnapshot,
	type CompletionDeliverySettingsSnapshot,
	type ConsultResourceSettingsSnapshot,
	type CwdPolicySettingsSnapshot,
	type DelegationWorkflow,
	type DelegationWorkflowSettingsSnapshot,
	type InspectedSubagentSettingsDocument,
	type StatefulLimitSettingsSnapshot,
	type StatefulTransportSettingsSnapshot,
	type SubagentSettingsSnapshot,
} from "./settings/inspection.js";
import {
	hasOwn,
	isPlainObject,
	isPositiveInteger,
	normalizeSubagentSettings,
} from "./settings/schema.js";
import {
	isValidStatefulLimit,
	resolveStatefulLimits,
	STATEFUL_LIMIT_FIELDS,
	type StatefulLimitField,
	type StatefulLimits,
	statefulLimitDefinition,
} from "./stateful-limits.js";

export {
	type BlockingParallelLimitSettingsSnapshot,
	type CompletionDeliverySettingsSnapshot,
	type ConsultResourceSettingsSnapshot,
	type CwdPolicyFieldSnapshot,
	type CwdPolicySettingsSnapshot,
	DEFAULT_CONSULT_RESOURCE_POLICY,
	DEFAULT_CONSULTATION_CWD_POLICY,
	DEFAULT_DELEGATION_CWD_POLICY,
	type DelegationWorkflow,
	type DelegationWorkflowSettingsSnapshot,
	resolveBlockingMaxParallelTasks,
	resolveDelegationWorkflow,
	type StatefulLimitFieldSnapshot,
	type StatefulLimitSettingsSnapshot,
	type StatefulTransportSettingsSnapshot,
	type SubagentSettingsSnapshot,
} from "./settings/inspection.js";
export {
	hasOwn,
	normalizeAgentSettings,
	normalizeSubagentSettings,
} from "./settings/schema.js";

const SETTINGS_FILE = "pi-subagents.json";
const LEGACY_SETTINGS_FILE = "pi-subagents-config.json";
const SETTINGS_LOCK_FS_ADAPTER = {
	mkdir: fs.mkdir,
	mkdirSync: fs.mkdirSync,
	realpath: fs.realpath,
	realpathSync: fs.realpathSync,
	rmdir: fs.rmdir,
	rmdirSync: fs.rmdirSync,
	stat: fs.stat,
	statSync: fs.statSync,
	utimes: fs.utimes,
	utimesSync: fs.utimesSync,
};
let pendingSettingsNotice: string | undefined;

function resolveSubagentSettingsPaths(): {
	canonicalPath: string;
	legacyPath: string;
	activePath?: string;
} {
	const canonicalPath = path.join(getAgentDir(), SETTINGS_FILE);
	const legacyPath = path.join(getAgentDir(), LEGACY_SETTINGS_FILE);
	return {
		canonicalPath,
		legacyPath,
		activePath: fs.existsSync(canonicalPath)
			? canonicalPath
			: fs.existsSync(legacyPath)
				? legacyPath
				: undefined,
	};
}

export function readSubagentSettings(): SubagentSettings | undefined {
	pendingSettingsNotice = undefined;
	const { canonicalPath, legacyPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === canonicalPath) {
		const canonical = readSettingsFile(canonicalPath);
		const notices: string[] = [];
		if (!canonical) notices.push(`${SETTINGS_FILE} is invalid and was ignored.`);
		if (fs.existsSync(legacyPath)) {
			notices.push(`${LEGACY_SETTINGS_FILE} ignored because ${SETTINGS_FILE} takes precedence.`);
		}
		if (notices.length > 0) pendingSettingsNotice = notices.join("\n");
		return canonical;
	}
	if (activePath === undefined) return undefined;
	const legacy = readSettingsFile(legacyPath);
	if (fs.existsSync(canonicalPath)) {
		const canonical = readSettingsFile(canonicalPath);
		pendingSettingsNotice = [
			...(!canonical ? [`${SETTINGS_FILE} is invalid and was ignored.`] : []),
			`${LEGACY_SETTINGS_FILE} ignored because ${SETTINGS_FILE} was created concurrently.`,
		].join("\n");
		return canonical;
	}
	if (!legacy) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE} is invalid and was ignored.`;
		return undefined;
	}
	pendingSettingsNotice = `Using legacy ${LEGACY_SETTINGS_FILE}; rename it to ${SETTINGS_FILE}. Future saves write ${SETTINGS_FILE} without modifying the legacy file.`;
	return legacy;
}

export function consumeSubagentSettingsNotice() {
	const notice = pendingSettingsNotice;
	pendingSettingsNotice = undefined;
	return notice;
}

export function saveSubagentConfig(settings: SubagentSettings): void {
	writeSettingsObject(settings);
}

export function subagentSettingsFilePath(): string {
	return path.join(getAgentDir(), SETTINGS_FILE);
}

function inspectSubagentSettingsDocument(): InspectedSubagentSettingsDocument {
	const { canonicalPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === undefined) return { path: canonicalPath };
	const inspected = inspectSubagentSettingsPath(activePath);
	return activePath !== canonicalPath && fs.existsSync(canonicalPath)
		? inspectSubagentSettingsPath(canonicalPath)
		: inspected;
}

function inspectSubagentSettingsPath(configPath: string): InspectedSubagentSettingsDocument {
	const fileName = path.basename(configPath);
	let contents: string;
	try {
		contents = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			path: configPath,
			error: `${fileName} could not be read${code ? ` (${safeErrorCode(code)})` : ""}`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(contents);
	} catch {
		return { path: configPath, error: `${fileName} contains malformed JSON` };
	}
	const settings = normalizeSubagentSettings(raw);
	if (!isPlainObject(raw) || !settings) {
		return { path: configPath, error: `${fileName} is not a valid settings object` };
	}
	return { path: configPath, raw, settings };
}

export function inspectSubagentSettings(): SubagentSettingsSnapshot {
	return buildSubagentSettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectConsultResourceSettings(): ConsultResourceSettingsSnapshot {
	return buildConsultResourceSettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectCwdPolicySettings(): CwdPolicySettingsSnapshot {
	return buildCwdPolicySettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectDelegationWorkflowSettings(): DelegationWorkflowSettingsSnapshot {
	return buildDelegationWorkflowSettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectCompletionDeliverySettings(): CompletionDeliverySettingsSnapshot {
	return buildCompletionDeliverySettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectStatefulTransportSettings(): StatefulTransportSettingsSnapshot {
	return buildStatefulTransportSettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectBlockingParallelLimitSettings(): BlockingParallelLimitSettingsSnapshot {
	return buildBlockingParallelLimitSettingsSnapshot(inspectSubagentSettingsDocument());
}

export function inspectStatefulLimitSettings(): StatefulLimitSettingsSnapshot {
	return buildStatefulLimitSettingsSnapshot(
		inspectSubagentSettingsDocument(),
		subagentSettingsFilePath(),
	);
}

export function updateDelegationWorkflowSetting(
	value: Exclude<DelegationWorkflow, "disabled">,
): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const blocking = raw.blocking;
		if (blocking !== undefined && !isPlainObject(blocking)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} blocking settings`);
		}
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				blocking: {
					...(blocking ?? {}),
					enabled: value !== "async-only",
				},
				stateful: {
					...(stateful ?? {}),
					enabled: value !== "blocking-only",
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateStatefulTransportSetting(value: SubagentTransportKind): void {
	if (!["subprocess", "in-process", "rpc", "auto"].includes(value)) {
		throw new Error(`Unsupported stateful transport: ${value}`);
	}
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				stateful: { ...(stateful ?? {}), transport: value },
			},
			update.replaceCanonical,
		);
	});
}

export function updateCompletionDeliverySetting(value: CompletionDelivery): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				stateful: {
					...(stateful ?? {}),
					completionDelivery: value,
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateBlockingMaxParallelTasksSetting(value: number): void {
	if (!isPositiveInteger(value) || value > MAX_CONFIGURABLE_PARALLEL_TASKS) {
		throw new Error(
			`Maximum parallel tasks must be an integer between 1 and ${MAX_CONFIGURABLE_PARALLEL_TASKS}`,
		);
	}
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const blocking = raw.blocking;
		if (blocking !== undefined && !isPlainObject(blocking)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} blocking settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				blocking: {
					...(blocking ?? {}),
					maxParallelTasks: value,
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateStatefulLimitSetting(
	field: StatefulLimitField,
	value: number,
	expected?: StatefulLimits,
): void {
	if (!isValidStatefulLimit(field, value)) {
		throw new Error(
			`${field} must be a safe integer greater than or equal to ${statefulLimitDefinition(field).minimum}`,
		);
	}
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const stateful = raw.stateful;
		if (stateful !== undefined && !isPlainObject(stateful)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} stateful settings`);
		}
		const normalized = normalizeSubagentSettings(raw);
		if (!normalized) throw new Error(`Cannot update invalid ${SETTINGS_FILE}`);
		if (expected && !sameStatefulLimits(resolveStatefulLimits(normalized.stateful), expected)) {
			throw new Error("Detached limit settings changed; reopen settings and retry");
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				stateful: { ...(stateful ?? {}), [field]: value },
			},
			update.replaceCanonical,
		);
	});
}

export function updateConsultResourceSetting(value: ConsultResourcePolicy): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const consult = raw.consult;
		if (consult !== undefined && !isPlainObject(consult)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} consult settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				consult: {
					...(consult ?? {}),
					resources: value,
				},
			},
			update.replaceCanonical,
		);
	});
}

export function updateCwdPolicySetting(field: "consultation", value: ConsultationCwdPolicy): void;
export function updateCwdPolicySetting(field: "delegation", value: DelegationCwdPolicy): void;
export function updateCwdPolicySetting(
	field: "consultation" | "delegation",
	value: ConsultationCwdPolicy | DelegationCwdPolicy,
): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const cwdPolicy = raw.cwdPolicy;
		if (cwdPolicy !== undefined && !isPlainObject(cwdPolicy)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} cwdPolicy settings`);
		}
		writeSettingsObjectUnlocked(
			{
				...raw,
				cwdPolicy: { ...(cwdPolicy ?? {}), [field]: value },
			},
			update.replaceCanonical,
		);
	});
}

export type AgentSettingsPatch = {
	tools?: string[] | undefined;
	model?: string | null | undefined;
	thinkingLevel?: SubagentThinkingLevel | null | undefined;
	timeoutMs?: number | null | undefined;
};

export function updateAgentToolsSetting(name: string, tools: string[] | undefined): void {
	updateAgentSettingsPatch({ [name]: { tools } });
}

export function updateAgentSettingsPatch(patches: Record<string, AgentSettingsPatch>): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const rawAgents = raw.agents;
		if (rawAgents !== undefined && !isPlainObject(rawAgents)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} agent settings`);
		}
		const agents = { ...(rawAgents ?? {}) };
		for (const [name, patch] of Object.entries(patches)) {
			const rawAgent = hasOwn(agents, name) ? agents[name] : undefined;
			if (rawAgent !== undefined && !isPlainObject(rawAgent)) {
				throw new Error(`Cannot update invalid ${SETTINGS_FILE} settings for ${name}`);
			}
			const agent = { ...(rawAgent ?? {}) };
			for (const field of ["tools", "model", "thinkingLevel", "timeoutMs"] as const) {
				if (!hasOwn(patch, field)) continue;
				const value = patch[field];
				if (value === undefined) delete agent[field];
				else
					Object.defineProperty(agent, field, {
						value,
						enumerable: true,
						configurable: true,
						writable: true,
					});
			}
			if (Object.keys(agent).length > 0) {
				Object.defineProperty(agents, name, {
					value: agent,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			} else {
				delete agents[name];
			}
		}

		const normalized = normalizeSubagentSettings({
			...raw,
			...(Object.keys(agents).length > 0 ? { agents } : {}),
		});
		if (!normalized) throw new Error(`Cannot update invalid ${SETTINGS_FILE} agent settings`);
		const updated = { ...raw };
		if (Object.keys(agents).length > 0) updated.agents = agents;
		else delete updated.agents;
		writeSettingsObjectUnlocked(updated, update.replaceCanonical);
	});
}

interface SettingsObjectForUpdate {
	document: Record<string, unknown>;
	replaceCanonical: boolean;
}

function readSettingsObjectForUpdate(): SettingsObjectForUpdate {
	const { canonicalPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === undefined) return { document: {}, replaceCanonical: false };
	const activeFile = path.basename(activePath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(activePath, "utf8"));
	} catch {
		throw new Error(`Cannot update malformed ${activeFile}`);
	}
	if (!isPlainObject(parsed) || !normalizeSubagentSettings(parsed)) {
		throw new Error(`Cannot update invalid ${activeFile}`);
	}
	return { document: parsed, replaceCanonical: activePath === canonicalPath };
}

function writeSettingsObject(settings: object, replaceCanonical?: boolean): void {
	withSettingsMutationLock(() => writeSettingsObjectUnlocked(settings, replaceCanonical));
}

function writeSettingsObjectUnlocked(settings: object, replaceCanonical?: boolean): void {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });
	const configPath = path.join(agentDir, SETTINGS_FILE);
	const tempFile = path.join(agentDir, `.${SETTINGS_FILE}.${randomUUID()}.tmp`);
	// Updates seeded from a missing or legacy document must remain exclusive even if the
	// canonical path appears after the read and before publication.
	const firstCanonicalPublication = !(replaceCanonical ?? pathEntryExists(configPath));
	try {
		fs.writeFileSync(tempFile, `${JSON.stringify(settings, null, "\t")}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		if (firstCanonicalPublication && pathEntryExists(configPath)) {
			throw new Error(`${SETTINGS_FILE} was created concurrently; reopen settings and retry`);
		}
		fs.renameSync(tempFile, configPath);
	} finally {
		try {
			fs.rmSync(tempFile, { force: true });
		} catch {
			// Preserve the save result if best-effort temp cleanup fails.
		}
	}
}

function withSettingsMutationLock<T>(mutate: () => T): T {
	const agentDir = getAgentDir();
	fs.mkdirSync(agentDir, { recursive: true });
	const configPath = path.join(agentDir, SETTINGS_FILE);
	const release = lockfile.lockSync(configPath, {
		fs: SETTINGS_LOCK_FS_ADAPTER,
		lockfilePath: `${configPath}.mutation-lock`,
		realpath: false,
	});
	try {
		return mutate();
	} finally {
		release();
	}
}

function sameStatefulLimits(left: StatefulLimits, right: StatefulLimits): boolean {
	return STATEFUL_LIMIT_FIELDS.every((field) => left[field] === right[field]);
}

function pathEntryExists(filePath: string): boolean {
	try {
		fs.lstatSync(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function readSettingsFile(configPath: string): SubagentSettings | undefined {
	return readSettingsSnapshot(configPath).settings;
}

function readSettingsSnapshot(configPath: string): {
	settings?: SubagentSettings;
	contents?: string;
} {
	try {
		const contents = fs.readFileSync(configPath, "utf8");
		return { settings: normalizeSubagentSettings(JSON.parse(contents)), contents };
	} catch {
		return {};
	}
}

function safeErrorCode(value: string): string {
	return value.replace(/[^A-Z0-9_-]/giu, "?").slice(0, 64);
}

export function uniqueToolNames(tools: string[]): string[] {
	return [...new Set(tools)];
}

export function sameToolSet(left: string[], right: string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) return false;
	return [...leftSet].every((tool) => rightSet.has(tool));
}

export function resolveSubagentThinkingLevel(
	agents: readonly Pick<AgentConfig, "name" | "thinkingLevel">[],
	agentName: string,
	topLevelThinkingLevel?: SubagentThinkingLevel,
	localThinkingLevel?: SubagentThinkingLevel,
): SubagentThinkingLevel | undefined {
	return (
		localThinkingLevel ??
		topLevelThinkingLevel ??
		agents.find((agent) => agent.name === agentName)?.thinkingLevel
	);
}

export function hasAnyAgentOverride(config: SubagentAgentConfig): boolean {
	return (
		hasOwn(config, "tools") ||
		hasOwn(config, "model") ||
		hasOwn(config, "thinkingLevel") ||
		hasOwn(config, "timeoutMs")
	);
}
