import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentSettings } from "./agents/types.js";
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
	type DelegationWorkflowSettingsSnapshot,
	type InspectedSubagentSettingsDocument,
	type StatefulLimitSettingsSnapshot,
	type StatefulTransportSettingsSnapshot,
	type SubagentSettingsSnapshot,
} from "./settings/inspection.js";
import { isPlainObject, normalizeSubagentSettings } from "./settings/schema.js";

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
export { hasOwn, normalizeAgentSettings, normalizeSubagentSettings } from "./settings/schema.js";

export const SUBAGENT_SETTINGS_FILE = "pi-subagents.json";
const LEGACY_SETTINGS_FILE = "pi-subagents-config.json";
let pendingSettingsNotice: string | undefined;

export function resolveSubagentSettingsPaths(): {
	canonicalPath: string;
	legacyPath: string;
	activePath?: string;
} {
	const canonicalPath = path.join(getAgentDir(), SUBAGENT_SETTINGS_FILE);
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
		if (!canonical) notices.push(`${SUBAGENT_SETTINGS_FILE} is invalid and was ignored.`);
		if (fs.existsSync(legacyPath)) {
			notices.push(
				`${LEGACY_SETTINGS_FILE} ignored because ${SUBAGENT_SETTINGS_FILE} takes precedence.`,
			);
		}
		if (notices.length > 0) pendingSettingsNotice = notices.join("\n");
		return canonical;
	}
	if (activePath === undefined) return undefined;
	const legacy = readSettingsFile(legacyPath);
	if (fs.existsSync(canonicalPath)) {
		const canonical = readSettingsFile(canonicalPath);
		pendingSettingsNotice = [
			...(!canonical ? [`${SUBAGENT_SETTINGS_FILE} is invalid and was ignored.`] : []),
			`${LEGACY_SETTINGS_FILE} ignored because ${SUBAGENT_SETTINGS_FILE} was created concurrently.`,
		].join("\n");
		return canonical;
	}
	if (!legacy) {
		pendingSettingsNotice = `${LEGACY_SETTINGS_FILE} is invalid and was ignored.`;
		return undefined;
	}
	pendingSettingsNotice = `Using legacy ${LEGACY_SETTINGS_FILE}; rename it to ${SUBAGENT_SETTINGS_FILE}. Future saves write ${SUBAGENT_SETTINGS_FILE} without modifying the legacy file.`;
	return legacy;
}

export function consumeSubagentSettingsNotice() {
	const notice = pendingSettingsNotice;
	pendingSettingsNotice = undefined;
	return notice;
}

export function subagentSettingsFilePath(): string {
	return path.join(getAgentDir(), SUBAGENT_SETTINGS_FILE);
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

export function pathEntryExists(filePath: string): boolean {
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

export function readSettingsSnapshot(configPath: string): {
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
