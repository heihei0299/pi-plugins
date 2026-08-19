/**
 * Filesystem and frontmatter discovery for user and trusted project agents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { normalizeCapabilityManifest } from "../capabilities.js";
import { BUILT_IN_AGENTS } from "./built-ins.js";
import type { AgentConfig, AgentScope, SubagentSettings } from "./types.js";
import { isThinkingLevel } from "./types.js";

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	omittedAgentDefinitions?: number;
	metadataDiscoveryIncomplete?: boolean;
}

export interface AgentDiscoveryOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

interface LoadedAgents {
	agents: AgentConfig[];
	omittedAgentDefinitions: number;
	metadataDiscoveryIncomplete: boolean;
}

function readFileBoundedSync(
	filePath: string,
	maxBytes: number | undefined,
): { content?: string; bytes: number; limited: boolean } {
	if (maxBytes === undefined) {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			return { content, bytes: Buffer.byteLength(content), limited: false };
		} catch {
			return { bytes: 0, limited: false };
		}
	}

	const readLimit = Math.max(0, maxBytes);
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		if (!fs.fstatSync(fd).isFile()) return { bytes: 0, limited: false };
		const buffer = Buffer.allocUnsafe(readLimit + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > readLimit) return { bytes: offset, limited: true };
		return { content: buffer.subarray(0, offset).toString("utf-8"), bytes: offset, limited: false };
	} catch {
		return { bytes: 0, limited: false };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
	options: AgentDiscoveryOptions = {},
): LoadedAgents {
	const agents: AgentConfig[] = [];
	let omittedAgentDefinitions = 0;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			agents,
			omittedAgentDefinitions,
			metadataDiscoveryIncomplete: (error as NodeJS.ErrnoException).code !== "ENOENT",
		};
	}

	const agentEntries = entries
		.filter((entry) => entry.name.endsWith(".md"))
		.filter((entry) => entry.isFile() || entry.isSymbolicLink());
	let totalBytes = 0;

	for (const [index, entry] of agentEntries.entries()) {
		if (options.maxFiles !== undefined && index >= options.maxFiles) {
			omittedAgentDefinitions += agentEntries.length - index;
			break;
		}
		const filePath = path.join(dir, entry.name);
		const remainingBytes =
			options.maxTotalBytes === undefined ? undefined : options.maxTotalBytes - totalBytes;
		if (remainingBytes !== undefined && remainingBytes <= 0) {
			omittedAgentDefinitions++;
			continue;
		}
		const maxBytes =
			options.maxFileBytes === undefined
				? remainingBytes
				: remainingBytes === undefined
					? options.maxFileBytes
					: Math.min(options.maxFileBytes, remainingBytes);
		const loaded = readFileBoundedSync(filePath, maxBytes);
		totalBytes += Math.min(loaded.bytes, maxBytes ?? loaded.bytes);
		if (loaded.limited || loaded.content === undefined) {
			if (loaded.limited) omittedAgentDefinitions++;
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(loaded.content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		const hasTools = hasOwn(frontmatter, "tools");
		const rawTools = frontmatter.tools;
		let tools: string[] | undefined;
		if (hasTools) {
			if (rawTools === null) {
				tools = [];
			} else if (Array.isArray(rawTools)) {
				if (!rawTools.every((tool): tool is string => typeof tool === "string")) continue;
				tools = rawTools.map((tool) => tool.trim()).filter(Boolean);
			} else if (typeof rawTools === "string") {
				tools = rawTools
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean);
			} else {
				continue;
			}
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			...(hasTools ? { tools: tools ?? [] } : {}),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinkingLevel: isThinkingLevel(frontmatter.thinkingLevel)
				? frontmatter.thinkingLevel
				: undefined,
			capabilityManifest: normalizeCapabilityManifest(frontmatter.capabilityManifest),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return { agents, omittedAgentDefinitions, metadataDiscoveryIncomplete: false };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.hasOwn(obj, key);
}

function applyAgentOverride(
	agent: AgentConfig,
	override: NonNullable<SubagentSettings["agents"]>[string],
): AgentConfig {
	const nextAgent: AgentConfig = { ...agent };
	if (hasOwn(override, "tools")) nextAgent.tools = override.tools;
	if (hasOwn(override, "model")) {
		nextAgent.model = override.model === null ? undefined : override.model;
	}
	if (hasOwn(override, "thinkingLevel")) {
		nextAgent.thinkingLevel = override.thinkingLevel === null ? undefined : override.thinkingLevel;
	}
	if (hasOwn(override, "timeoutMs")) {
		nextAgent.timeoutMs = override.timeoutMs === null ? undefined : override.timeoutMs;
	}
	return nextAgent;
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	config?: SubagentSettings,
	options: AgentDiscoveryOptions = {},
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userLoaded =
		scope === "project"
			? { agents: [], omittedAgentDefinitions: 0, metadataDiscoveryIncomplete: false }
			: loadAgentsFromDir(userDir, "user", options);
	const projectLoaded =
		scope === "user" || !projectAgentsDir
			? { agents: [], omittedAgentDefinitions: 0, metadataDiscoveryIncomplete: false }
			: loadAgentsFromDir(projectAgentsDir, "project", options);
	const userAgents = userLoaded.agents;
	const projectAgents = projectLoaded.agents;

	const agentMap = new Map<string, AgentConfig>();

	// Lowest priority: built-ins are always available, then user agents, then
	// trusted project agents if requested. This mirrors the subagent boundary
	// pattern in ./src: stable built-ins plus overridable local definitions.
	for (const agent of BUILT_IN_AGENTS) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	// Apply user-configured overrides (from /subagents → Agent tool settings) on top of
	// the final resolved agent map, regardless of agent source.
	const configuredAgents = config?.agents ?? {};
	for (const [name, override] of Object.entries(configuredAgents)) {
		const agent = agentMap.get(name);
		if (!agent) continue;
		agentMap.set(name, applyAgentOverride(agent, override));
	}
	const legacyScoutOverride = configuredAgents.scout;
	const explorerAgent = agentMap.get("explorer");
	if (
		legacyScoutOverride &&
		explorerAgent &&
		!hasOwn(configuredAgents, "explorer") &&
		!agentMap.has("scout")
	) {
		agentMap.set("explorer", applyAgentOverride(explorerAgent, legacyScoutOverride));
	}

	const omittedAgentDefinitions =
		userLoaded.omittedAgentDefinitions + projectLoaded.omittedAgentDefinitions;
	const metadataDiscoveryIncomplete =
		userLoaded.metadataDiscoveryIncomplete || projectLoaded.metadataDiscoveryIncomplete;
	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
		...(omittedAgentDefinitions > 0 ? { omittedAgentDefinitions } : {}),
		...(metadataDiscoveryIncomplete ? { metadataDiscoveryIncomplete } : {}),
	};
}
