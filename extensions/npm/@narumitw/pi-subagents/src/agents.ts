/**
 * Compatibility facade for the former mixed agent module.
 *
 * New source modules should import from the cohesive agent boundaries directly.
 * Keep this facade while tests and supported internal entrypoints still depend on the old path.
 */

export { getBuiltInAgent } from "./agents/built-ins.js";
export {
	type AgentCatalog,
	type AgentCatalogFormatOptions,
	type AgentCatalogFormatResult,
	DEFAULT_AGENT_CATALOG_MAX_CHARACTERS,
	DEFAULT_AGENT_CATALOG_MAX_DESCRIPTION_LENGTH,
	DEFAULT_AGENT_CATALOG_MAX_FILE_BYTES,
	DEFAULT_AGENT_CATALOG_MAX_FILES_PER_SCOPE,
	DEFAULT_AGENT_CATALOG_MAX_ITEMS,
	DEFAULT_AGENT_CATALOG_MAX_TOTAL_BYTES_PER_SCOPE,
	discoverAgentCatalog,
	formatAgentCatalog,
	formatAgentList,
} from "./agents/catalog.js";
export {
	type AgentDiscoveryOptions,
	type AgentDiscoveryResult,
	discoverAgents,
} from "./agents/discovery.js";
export {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	CONSULT_RESOURCE_POLICIES,
	CONSULTATION_CWD_POLICIES,
	type CompletionDelivery,
	type ConsultationCwdPolicy,
	type ConsultResourcePolicy,
	DEFAULT_PI_TOOL_NAMES,
	DELEGATION_CWD_POLICIES,
	type DelegationCwdPolicy,
	isThinkingLevel,
	resolveAgentToolNames,
	type SubagentAgentConfig,
	type SubagentBlockingSettings,
	type SubagentConsultSettings,
	type SubagentCwdPolicySettings,
	type SubagentRuntimeSettings,
	type SubagentSettings,
	type SubagentThinkingLevel,
	type SubagentTransportKind,
	THINKING_LEVELS,
} from "./agents/types.js";
