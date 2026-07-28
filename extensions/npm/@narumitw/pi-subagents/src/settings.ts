import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
	type AgentConfig,
	type CompletionDelivery,
	isThinkingLevel,
	type SubagentAgentConfig,
	type SubagentSettings,
	type SubagentThinkingLevel,
} from "./agents.js";

export function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function isPositiveInteger(value: unknown): value is number {
	return isPositiveNumber(value) && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeAgentSettings(value: unknown): SubagentAgentConfig | undefined {
	if (!isPlainObject(value)) return undefined;

	const config: SubagentAgentConfig = {};
	let hasKnownField = false;

	if (hasOwn(value, "tools")) {
		if (!isStringArray(value.tools)) return undefined;
		config.tools = value.tools;
		hasKnownField = true;
	}

	if (hasOwn(value, "model")) {
		if (value.model !== null && typeof value.model !== "string") return undefined;
		config.model = value.model;
		hasKnownField = true;
	}

	if (hasOwn(value, "thinkingLevel")) {
		if (value.thinkingLevel !== null && !isThinkingLevel(value.thinkingLevel)) return undefined;
		config.thinkingLevel = value.thinkingLevel;
		hasKnownField = true;
	}

	if (hasOwn(value, "timeoutMs")) {
		if (value.timeoutMs !== null && !isPositiveNumber(value.timeoutMs)) return undefined;
		config.timeoutMs = value.timeoutMs;
		hasKnownField = true;
	}

	return hasKnownField ? config : undefined;
}

export function normalizeSubagentSettings(value: unknown): SubagentSettings | undefined {
	if (!isPlainObject(value)) return undefined;
	const settings: SubagentSettings = {};
	if (hasOwn(value, "agents")) {
		if (!isPlainObject(value.agents)) return undefined;
		const agents: Record<string, SubagentAgentConfig> = {};
		for (const [name, rawConfig] of Object.entries(value.agents)) {
			const config = normalizeAgentSettings(rawConfig);
			if (config) agents[name] = config;
		}
		if (Object.keys(agents).length > 0) settings.agents = agents;
	}
	if (hasOwn(value, "blocking")) {
		if (!isPlainObject(value.blocking)) return undefined;
		const blocking: NonNullable<SubagentSettings["blocking"]> = {};
		if (hasOwn(value.blocking, "enabled")) {
			if (typeof value.blocking.enabled !== "boolean") return undefined;
			blocking.enabled = value.blocking.enabled;
		}
		settings.blocking = blocking;
	}
	if (hasOwn(value, "stateful")) {
		if (!isPlainObject(value.stateful)) return undefined;
		const runtime: NonNullable<SubagentSettings["stateful"]> = {};
		if (hasOwn(value.stateful, "transport")) {
			if (value.stateful.transport !== "subprocess" && value.stateful.transport !== "in-process") {
				return undefined;
			}
			runtime.transport = value.stateful.transport;
		}
		if (hasOwn(value.stateful, "completionDelivery")) {
			if (
				value.stateful.completionDelivery !== "next-turn" &&
				value.stateful.completionDelivery !== "auto-resume"
			) {
				return undefined;
			}
			runtime.completionDelivery = value.stateful.completionDelivery;
		}
		for (const key of [
			"maxAgents",
			"maxActiveTurns",
			"maxChildrenPerAgent",
			"maxMailboxMessages",
			"maxMailboxMessageBytes",
			"idleTtlMs",
			"maxStoredAgents",
		] as const) {
			if (hasOwn(value.stateful, key)) {
				if (!isPositiveInteger(value.stateful[key])) return undefined;
				runtime[key] = value.stateful[key];
			}
		}
		if (hasOwn(value.stateful, "maxDepth")) {
			if (!isNonNegativeInteger(value.stateful.maxDepth)) return undefined;
			runtime.maxDepth = value.stateful.maxDepth;
		}
		if (hasOwn(value.stateful, "retentionDays")) {
			if (!isPositiveNumber(value.stateful.retentionDays)) return undefined;
			runtime.retentionDays = value.stateful.retentionDays;
		}
		if (hasOwn(value.stateful, "enabled")) {
			if (typeof value.stateful.enabled !== "boolean") return undefined;
			runtime.enabled = value.stateful.enabled;
		}
		settings.stateful = runtime;
	}
	return settings;
}

const SETTINGS_FILE = "pi-subagents.json";
const LEGACY_SETTINGS_FILE = "pi-subagents-config.json";
const DEFAULT_COMPLETION_DELIVERY: CompletionDelivery = "next-turn";
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

export type DelegationWorkflow = "all" | "async-only" | "blocking-only" | "disabled";

export interface DelegationWorkflowSettingsSnapshot {
	path: string;
	value: DelegationWorkflow;
	source: "default" | "user settings";
	error?: string;
}

export interface CompletionDeliverySettingsSnapshot {
	path: string;
	value: CompletionDelivery;
	source: "default" | "user settings";
	error?: string;
}

export function subagentSettingsFilePath(): string {
	return path.join(getAgentDir(), SETTINGS_FILE);
}

export function resolveDelegationWorkflow(
	blockingEnabled: boolean,
	statefulEnabled: boolean,
): DelegationWorkflow {
	if (blockingEnabled && statefulEnabled) return "all";
	if (statefulEnabled) return "async-only";
	if (blockingEnabled) return "blocking-only";
	return "disabled";
}

function inspectSubagentSettingsDocument(): {
	path: string;
	raw?: Record<string, unknown>;
	settings?: SubagentSettings;
	error?: string;
} {
	const { canonicalPath, activePath } = resolveSubagentSettingsPaths();
	if (activePath === undefined) return { path: canonicalPath };
	const inspected = inspectSubagentSettingsPath(activePath);
	return activePath !== canonicalPath && fs.existsSync(canonicalPath)
		? inspectSubagentSettingsPath(canonicalPath)
		: inspected;
}

function inspectSubagentSettingsPath(configPath: string): {
	path: string;
	raw?: Record<string, unknown>;
	settings?: SubagentSettings;
	error?: string;
} {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
		const settings = normalizeSubagentSettings(raw);
		if (!isPlainObject(raw) || !settings) {
			throw new Error(`${path.basename(configPath)} is not a valid settings object`);
		}
		return { path: configPath, raw, settings };
	} catch (error) {
		return { path: configPath, error: formatError(error) };
	}
}

export function inspectDelegationWorkflowSettings(): DelegationWorkflowSettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: "all",
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		(isPlainObject(inspected.raw.blocking) && hasOwn(inspected.raw.blocking, "enabled")) ||
		(isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "enabled"));
	return {
		path: inspected.path,
		value: resolveDelegationWorkflow(
			inspected.settings.blocking?.enabled !== false,
			inspected.settings.stateful?.enabled !== false,
		),
		source: explicit ? "user settings" : "default",
	};
}

export function inspectCompletionDeliverySettings(): CompletionDeliverySettingsSnapshot {
	const inspected = inspectSubagentSettingsDocument();
	if (!inspected.raw || !inspected.settings) {
		return {
			path: inspected.path,
			value: DEFAULT_COMPLETION_DELIVERY,
			source: "default",
			...(inspected.error ? { error: inspected.error } : {}),
		};
	}
	const explicit =
		isPlainObject(inspected.raw.stateful) && hasOwn(inspected.raw.stateful, "completionDelivery");
	return {
		path: inspected.path,
		value: inspected.settings.stateful?.completionDelivery ?? DEFAULT_COMPLETION_DELIVERY,
		source: explicit ? "user settings" : "default",
	};
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

export function updateAgentToolsSetting(name: string, tools: string[] | undefined): void {
	withSettingsMutationLock(() => {
		const update = readSettingsObjectForUpdate();
		const raw = update.document;
		const rawAgents = raw.agents;
		if (rawAgents !== undefined && !isPlainObject(rawAgents)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} agent settings`);
		}
		const agents = { ...(rawAgents ?? {}) };
		const rawAgent = hasOwn(agents, name) ? agents[name] : undefined;
		if (rawAgent !== undefined && !isPlainObject(rawAgent)) {
			throw new Error(`Cannot update invalid ${SETTINGS_FILE} settings for ${name}`);
		}
		const agent = { ...(rawAgent ?? {}) };
		if (tools === undefined) delete agent.tools;
		else agent.tools = tools;
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
	} catch (error) {
		throw new Error(`Cannot update malformed ${activeFile}: ${formatError(error)}`);
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

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
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
