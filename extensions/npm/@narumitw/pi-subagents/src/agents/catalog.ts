/**
 * Bounded, sanitized model-facing agent catalog formatting.
 */

import { BUILT_IN_AGENTS } from "./built-ins.js";
import {
	type AgentDiscoveryOptions,
	type AgentDiscoveryResult,
	discoverAgents,
} from "./discovery.js";
import { type AgentConfig, resolveAgentToolNames, type SubagentSettings } from "./types.js";

export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

export interface AgentCatalog {
	/** The effective catalog for the default invocation scope. */
	user: AgentDiscoveryResult;
	/** The project-scope catalog; custom project definitions are loaded only after project trust. */
	project?: AgentDiscoveryResult;
}

export interface AgentCatalogFormatOptions {
	maxItems?: number;
	maxDescriptionLength?: number;
	maxCharacters?: number;
}

export interface AgentCatalogFormatResult {
	text: string;
	omitted: number;
}

export const DEFAULT_AGENT_CATALOG_MAX_ITEMS = 32;
export const DEFAULT_AGENT_CATALOG_MAX_DESCRIPTION_LENGTH = 240;
export const DEFAULT_AGENT_CATALOG_MAX_CHARACTERS = 6_000;
export const DEFAULT_AGENT_CATALOG_MAX_FILES_PER_SCOPE = 128;
export const DEFAULT_AGENT_CATALOG_MAX_FILE_BYTES = 64 * 1024;
export const DEFAULT_AGENT_CATALOG_MAX_TOTAL_BYTES_PER_SCOPE = 2 * 1024 * 1024;

const BUILT_IN_AGENT_ORDER = new Map(BUILT_IN_AGENTS.map((agent, index) => [agent.name, index]));

function compareCatalogAgents(left: AgentConfig, right: AgentConfig): number {
	const leftBuiltInOrder = BUILT_IN_AGENT_ORDER.get(left.name);
	const rightBuiltInOrder = BUILT_IN_AGENT_ORDER.get(right.name);
	if (leftBuiltInOrder !== undefined || rightBuiltInOrder !== undefined) {
		if (leftBuiltInOrder === undefined) return 1;
		if (rightBuiltInOrder === undefined) return -1;
		return leftBuiltInOrder - rightBuiltInOrder;
	}
	return left.name.localeCompare(right.name);
}

function normalizeCatalogDescription(description: string, maxLength: number): string {
	const normalized = description.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	const suffix = "…";
	return `${normalized.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

type CatalogScope = "user" | "project" | "project-fallback";

function formatDeclaredItems(items: readonly string[] | undefined): string {
	if (items === undefined) return "undeclared";
	return items.length > 0 ? items.join(", ") : "none";
}

function catalogAgentContractMetadata(agent: AgentConfig): string {
	const manifest = agent.capabilityManifest;
	return [
		`capabilities: ${formatDeclaredItems(manifest?.capabilities)}`,
		`tools: ${formatDeclaredItems(resolveAgentToolNames(agent.tools))}`,
		`filesystem: ${manifest?.authority?.filesystem ?? "undeclared"}`,
		`result formats: ${formatDeclaredItems(manifest?.resultFormats)}`,
	].join("; ");
}

function catalogAgentLine(
	agent: AgentConfig,
	scope: CatalogScope,
	userNames: ReadonlySet<string>,
	maxDescriptionLength: number,
): string {
	const scopeLabel =
		scope === "user"
			? 'agentScope: "user"'
			: scope === "project"
				? 'requires agentScope: "project" or "both"'
				: 'requires agentScope: "project" ("both" selects the user definition)';
	const collision =
		scope !== "user" && userNames.has(agent.name)
			? scope === "project"
				? "; overrides the default user definition for project/both"
				: "; scope-specific fallback for the default user override"
			: "";
	return `- ${agent.name} [source: ${agent.source}; ${scopeLabel}${collision}] [${catalogAgentContractMetadata(agent)}] — ${normalizeCatalogDescription(agent.description, maxDescriptionLength)}`;
}

/**
 * Format the effective agent variants that the parent model can invoke.
 *
 * User-authored descriptions are prompt text, so this formatter deliberately normalizes and bounds
 * them. Project definitions are supplied separately by the caller so an untrusted project is never
 * read merely to build model-facing metadata.
 */
export function formatAgentCatalog(
	catalog: AgentCatalog,
	options: AgentCatalogFormatOptions = {},
): AgentCatalogFormatResult {
	const maxItems = Math.max(0, options.maxItems ?? DEFAULT_AGENT_CATALOG_MAX_ITEMS);
	const maxDescriptionLength = Math.max(
		1,
		options.maxDescriptionLength ?? DEFAULT_AGENT_CATALOG_MAX_DESCRIPTION_LENGTH,
	);
	const maxCharacters = Math.max(1, options.maxCharacters ?? DEFAULT_AGENT_CATALOG_MAX_CHARACTERS);
	const userDiscoveryIncomplete =
		(catalog.user.omittedAgentDefinitions ?? 0) > 0 ||
		catalog.user.metadataDiscoveryIncomplete === true;
	const projectDiscoveryIncomplete =
		(catalog.project?.omittedAgentDefinitions ?? 0) > 0 ||
		catalog.project?.metadataDiscoveryIncomplete === true;
	const discoveredUserAgents = [...catalog.user.agents].sort(compareCatalogAgents);
	const discoveredProjectScopeAgents = [...(catalog.project?.agents ?? [])].sort(
		compareCatalogAgents,
	);
	const userAgents = userDiscoveryIncomplete ? [] : discoveredUserAgents;
	const projectScopeAgents = projectDiscoveryIncomplete ? [] : discoveredProjectScopeAgents;
	const projectAgents = projectScopeAgents.filter((agent) => agent.source === "project");
	const discoveredUserByName = new Map(discoveredUserAgents.map((agent) => [agent.name, agent]));
	const userByName = new Map(userAgents.map((agent) => [agent.name, agent]));
	const userNames = new Set(userByName.keys());
	const potentialProjectFallbackAgents = discoveredProjectScopeAgents.filter(
		(agent) =>
			agent.source === "built-in" && discoveredUserByName.get(agent.name)?.source === "user",
	);
	const projectFallbackAgents =
		userDiscoveryIncomplete || projectDiscoveryIncomplete ? [] : potentialProjectFallbackAgents;
	const allEntries = [
		...userAgents.map((agent) => ({ agent, scope: "user" as const })),
		...projectAgents.map((agent) => ({ agent, scope: "project" as const })),
		...projectFallbackAgents.map((agent) => ({ agent, scope: "project-fallback" as const })),
	];
	const boundedEntries = allEntries.slice(0, maxItems);
	const suppressedMetadataEntries =
		(userDiscoveryIncomplete ? discoveredUserAgents.length : 0) +
		(projectDiscoveryIncomplete
			? discoveredProjectScopeAgents.filter((agent) => agent.source === "project").length +
				potentialProjectFallbackAgents.length
			: 0);
	const discoveryOmissions =
		(catalog.user.omittedAgentDefinitions ?? 0) +
		(catalog.project?.omittedAgentDefinitions ?? 0) +
		suppressedMetadataEntries;
	const discoveryIncomplete =
		catalog.user.metadataDiscoveryIncomplete === true ||
		catalog.project?.metadataDiscoveryIncomplete === true;

	const render = (entries: typeof allEntries, omitted: number): string => {
		const lines = [
			"Available agent definitions (metadata only; runtime validation and trust remain authoritative).",
			"Use capability and tool identifiers exactly as shown when authoring enforced contracts.",
			"Enforced contract readPaths, writePaths, network, and secrets guarantees are unsupported.",
		];
		const userLines = entries
			.filter((entry) => entry.scope === "user")
			.map((entry) => catalogAgentLine(entry.agent, entry.scope, userNames, maxDescriptionLength));
		if (userLines.length > 0) {
			lines.push('Default scope (agentScope: "user"):');
			lines.push(...userLines);
		}
		const projectLines = entries
			.filter((entry) => entry.scope !== "user")
			.map((entry) => catalogAgentLine(entry.agent, entry.scope, userNames, maxDescriptionLength));
		if (projectLines.length > 0) {
			lines.push("Trusted project/scope variants (use the required agentScope shown):");
			lines.push(...projectLines);
		}
		const collisionNames = entries
			.filter((entry) => entry.scope !== "user" && userNames.has(entry.agent.name))
			.map((entry) => entry.agent.name);
		if (collisionNames.length > 0 && projectLines.length > 0) {
			const precedence = entries
				.filter((entry) => entry.scope !== "user" && userNames.has(entry.agent.name))
				.map((entry) =>
					entry.scope === "project"
						? `${entry.agent.name}: user with "user", project with "project"/"both"`
						: `${entry.agent.name}: user with "user"/"both", built-in with "project"`,
				);
			lines.push(`Same-name precedence: ${precedence.join("; ")}.`);
		}
		if (omitted > 0) {
			lines.push(
				`[${omitted} additional agent definition${omitted === 1 ? "" : "s"} omitted due to metadata bounds or incomplete discovery.]`,
			);
		}
		if (discoveryIncomplete) {
			lines.push("[Agent metadata discovery was incomplete; some definitions may be unavailable.]");
		}
		return lines.join("\n");
	};

	let listedCount = boundedEntries.length;
	let text = render(
		boundedEntries.slice(0, listedCount),
		allEntries.length - listedCount + discoveryOmissions,
	);
	while (text.length > maxCharacters && listedCount > 0) {
		listedCount -= 1;
		text = render(
			boundedEntries.slice(0, listedCount),
			allEntries.length - listedCount + discoveryOmissions,
		);
	}
	return { text, omitted: allEntries.length - listedCount + discoveryOmissions };
}

export function discoverAgentCatalog(
	cwd: string,
	projectTrusted: boolean,
	config?: SubagentSettings,
): AgentCatalog {
	const options: AgentDiscoveryOptions = {
		maxFiles: DEFAULT_AGENT_CATALOG_MAX_FILES_PER_SCOPE,
		maxFileBytes: DEFAULT_AGENT_CATALOG_MAX_FILE_BYTES,
		maxTotalBytes: DEFAULT_AGENT_CATALOG_MAX_TOTAL_BYTES_PER_SCOPE,
	};
	return {
		user: discoverAgents(cwd, "user", config, options),
		project: projectTrusted ? discoverAgents(cwd, "project", config, options) : undefined,
	};
}
