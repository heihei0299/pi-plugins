/**
 * Foundational agent and settings types with dependency-light validation helpers.
 */

import type { AgentCapabilityManifest } from "../capabilities.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is SubagentThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as SubagentThinkingLevel);
}

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "built-in" | "user" | "project";

export const DEFAULT_PI_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export function resolveAgentToolNames(tools: readonly string[] | undefined): string[] {
	return [...new Set(tools ?? DEFAULT_PI_TOOL_NAMES)];
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	capabilityManifest?: AgentCapabilityManifest;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface SubagentAgentConfig {
	tools?: string[];
	model?: string | null;
	thinkingLevel?: SubagentThinkingLevel | null;
	timeoutMs?: number | null;
}

export type SubagentTransportKind = "subprocess" | "in-process" | "rpc" | "auto";

export type CompletionDelivery = "next-turn" | "auto-resume";

export const CONSULT_RESOURCE_POLICIES = ["project-context", "none", "all"] as const;

export type ConsultResourcePolicy = (typeof CONSULT_RESOURCE_POLICIES)[number];

export interface SubagentConsultSettings {
	resources?: ConsultResourcePolicy;
}

export const CONSULTATION_CWD_POLICIES = ["anywhere", "current-workspace"] as const;
export type ConsultationCwdPolicy = (typeof CONSULTATION_CWD_POLICIES)[number];

export const DELEGATION_CWD_POLICIES = [
	"trusted-targets",
	"current-workspace",
	"anywhere",
] as const;
export type DelegationCwdPolicy = (typeof DELEGATION_CWD_POLICIES)[number];

export interface SubagentCwdPolicySettings {
	consultation?: ConsultationCwdPolicy;
	delegation?: DelegationCwdPolicy;
}

export interface SubagentBlockingSettings {
	enabled?: boolean;
	maxParallelTasks?: number;
}

export interface SubagentRuntimeSettings {
	enabled?: boolean;
	transport?: SubagentTransportKind;
	completionDelivery?: CompletionDelivery;
	maxAgents?: number;
	maxActiveTurns?: number;
	maxDepth?: number;
	maxChildrenPerAgent?: number;
	maxMailboxMessages?: number;
	maxMailboxMessageBytes?: number;
	idleTtlMs?: number;
	retentionDays?: number;
	maxStoredAgents?: number;
}

export interface SubagentSettings {
	agents?: Record<string, SubagentAgentConfig>;
	blocking?: SubagentBlockingSettings;
	stateful?: SubagentRuntimeSettings;
	consult?: SubagentConsultSettings;
	cwdPolicy?: SubagentCwdPolicySettings;
}
