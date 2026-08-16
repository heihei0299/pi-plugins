import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents/discovery.js";
import type {
	AgentConfig,
	AgentScope,
	ConsultationCwdPolicy,
	DelegationCwdPolicy,
} from "./agents/types.js";
import { projectCapabilityManifest } from "./capabilities.js";
import { resolveConsultTools } from "./consult-policy.js";
import { buildContextSnapshot, type ContextMode } from "./context.js";
import { INSPECT_ACTIONS } from "./inspect-tool.js";
import { DEFAULT_MAX_CONTEXT_BYTES } from "./limits.js";
import { resolvePiInvocation } from "./pi-invocation.js";
import type { AgentRunInspectionDetail, AgentRunInspectionSummary } from "./registry.js";
import { boundedPrivateText, boundText, safeDisplayPath, safeTerminalLine } from "./safe-text.js";
import { resolveDelegationWorkflow } from "./settings/inspection.js";
import {
	inspectBlockingParallelLimitSettings,
	inspectCompletionDeliverySettings,
	inspectConsultResourceSettings,
	inspectCwdPolicySettings,
	inspectDelegationWorkflowSettings,
	inspectStatefulLimitSettings,
	inspectStatefulTransportSettings,
	inspectSubagentSettings,
} from "./settings.js";
import type { StatefulSubagentRuntimeStatus } from "./stateful.js";
import type { WorkItemLedgerSnapshot } from "./work-item-ledger.js";
import { inspectSessionWorkflows } from "./work-item-persistence.js";

const MAX_DETAILS_LIST_BYTES = 40 * 1024;

export { registerSubagentInspect } from "./inspect-registration.js";
export { SubagentInspectParams } from "./inspect-tool.js";

export interface SubagentInspectRuntime {
	getBlockingEnabled(): boolean;
	getMaxParallelTasks(): number;
	getConsultResourcePolicy(): "project-context" | "none" | "all";
	getConsultationCwdPolicy(): ConsultationCwdPolicy;
	getDelegationCwdPolicy(): DelegationCwdPolicy;
	getRuntimeStatus(): StatefulSubagentRuntimeStatus;
	listRunInspection(includeClosed?: boolean): AgentRunInspectionSummary[];
	getRunInspection(agentId: string): AgentRunInspectionDetail | undefined;
}

interface InspectToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

type ValidatedInspectOperation =
	| { action: "list_agents"; agentScope: AgentScope; limit: number }
	| { action: "get_agent"; agent: string; agentScope: AgentScope }
	| { action: "list_runs"; includeClosed: boolean; limit: number }
	| { action: "get_run"; agentId: string }
	| { action: "list_workflows"; limit: number }
	| { action: "get_workflow"; workflowId: string }
	| { action: "list_models"; limit: number }
	| { action: "preview_context"; context: ContextMode; contextEntryIds?: string[] }
	| { action: "status" }
	| { action: "diagnose" };

export function validateInspectParams(params: unknown): ValidatedInspectOperation {
	const values = parameterRecord(params);
	const rawAction = values.action;
	if (
		typeof rawAction !== "string" ||
		!INSPECT_ACTIONS.includes(rawAction as (typeof INSPECT_ACTIONS)[number])
	) {
		throw new Error(`subagent_inspect action must be one of: ${INSPECT_ACTIONS.join(", ")}`);
	}
	const action = rawAction as (typeof INSPECT_ACTIONS)[number];
	const allowed: Record<(typeof INSPECT_ACTIONS)[number], readonly string[]> = {
		list_agents: ["action", "agentScope", "limit"],
		get_agent: ["action", "agent", "agentScope"],
		list_runs: ["action", "includeClosed", "limit"],
		get_run: ["action", "agentId"],
		list_workflows: ["action", "limit"],
		get_workflow: ["action", "workflowId"],
		list_models: ["action", "limit"],
		preview_context: ["action", "context", "contextEntryIds"],
		status: ["action"],
		diagnose: ["action"],
	};
	const unexpected = Object.keys(values).find(
		(key) => values[key] !== undefined && !allowed[action].includes(key),
	);
	if (unexpected)
		throw new Error(`subagent_inspect action "${action}" does not accept ${unexpected}`);

	if (action === "list_agents" || action === "get_agent") {
		const agentScope = optionalAgentScope(values.agentScope);
		if (action === "get_agent") {
			return { action, agent: requiredString(values.agent, action, "agent"), agentScope };
		}
		return { action, agentScope, limit: optionalLimit(values.limit, 32) };
	}
	if (action === "list_runs") {
		if (values.includeClosed !== undefined && typeof values.includeClosed !== "boolean") {
			throw new Error('subagent_inspect action "list_runs" requires includeClosed to be boolean');
		}
		return {
			action,
			includeClosed: values.includeClosed === true,
			limit: optionalLimit(values.limit, 50),
		};
	}
	if (action === "get_run") {
		return { action, agentId: requiredString(values.agentId, action, "agentId") };
	}
	if (action === "list_workflows") {
		return { action, limit: optionalLimit(values.limit, 50) };
	}
	if (action === "get_workflow") {
		return { action, workflowId: requiredString(values.workflowId, action, "workflowId") };
	}
	if (action === "list_models") {
		return { action, limit: optionalLimit(values.limit, 50) };
	}
	if (action === "preview_context") {
		const context = optionalContextMode(values.context);
		const contextEntryIds = optionalStringArray(values.contextEntryIds, "contextEntryIds");
		return {
			action,
			context: values.context === undefined && contextEntryIds ? "all" : context,
			...(contextEntryIds ? { contextEntryIds } : {}),
		};
	}
	return { action };
}

export async function executeSubagentInspect(
	params: unknown,
	ctx: ExtensionContext,
	runtime: SubagentInspectRuntime,
): Promise<InspectToolResult> {
	const operation = validateInspectParams(params);
	if (operation.action === "list_agents" || operation.action === "get_agent") {
		assertTrustedScope(operation.agentScope, ctx);
		const settings = inspectSubagentSettings().settings;
		const discovery = discoverAgents(ctx.cwd, operation.agentScope, settings);
		const agents = [...discovery.agents].sort((left, right) =>
			left.name === right.name
				? left.source.localeCompare(right.source)
				: left.name.localeCompare(right.name),
		);
		if (operation.action === "list_agents") {
			const selected = boundedProjection(agents, operation.limit, (agent) =>
				projectAgent(agent, ctx, false),
			);
			return inspectResult({
				action: operation.action,
				agents: selected.items,
				returned: selected.items.length,
				omitted: selected.omitted + (discovery.omittedAgentDefinitions ?? 0),
				discoveryIncomplete: discovery.metadataDiscoveryIncomplete === true,
			});
		}
		const agent = agents.find((candidate) => candidate.name === operation.agent);
		if (!agent) {
			throw new Error(`Unknown subagent definition: ${boundedPrivateText(operation.agent, 256)}`);
		}
		return inspectResult({ action: operation.action, agent: projectAgent(agent, ctx) });
	}

	if (operation.action === "list_runs") {
		const runs = runtime.listRunInspection(operation.includeClosed);
		const selected = boundedProjection(runs, operation.limit, projectRunSummary);
		return inspectResult({
			action: operation.action,
			runs: selected.items,
			returned: selected.items.length,
			omitted: selected.omitted,
		});
	}
	if (operation.action === "get_run") {
		const run = runtime.getRunInspection(operation.agentId);
		if (!run) {
			throw new Error(`Unknown retained run: ${boundedPrivateText(operation.agentId, 256)}`);
		}
		return inspectResult({ action: operation.action, run: projectRun(run, ctx) });
	}
	if (operation.action === "list_workflows" || operation.action === "get_workflow") {
		const owner =
			ctx.sessionManager.getSessionId?.() ??
			ctx.sessionManager.getSessionFile?.() ??
			`ephemeral:${ctx.cwd}`;
		const inspected = inspectSessionWorkflows(owner, {
			maxStoredWorkflows: operation.action === "list_workflows" ? operation.limit : 64,
		});
		if (operation.action === "list_workflows") {
			const selected = boundedProjection(
				inspected.workflows,
				operation.limit,
				projectWorkflowSummary,
			);
			return inspectResult({
				action: operation.action,
				workflows: selected.items,
				returned: selected.items.length,
				omitted: inspected.omitted + selected.omitted,
				invalid: inspected.invalid,
			});
		}
		const workflow = inspected.workflows.find(
			(candidate) => candidate.workflowId === operation.workflowId,
		);
		if (!workflow) {
			throw new Error(
				`Unknown persisted workflow: ${boundedPrivateText(operation.workflowId, 256)}`,
			);
		}
		return inspectResult({ action: operation.action, workflow: projectWorkflow(workflow) });
	}
	if (operation.action === "list_models") {
		return inspectResult({ action: operation.action, ...projectModels(ctx, operation.limit) });
	}
	if (operation.action === "preview_context") {
		const snapshot = buildContextSnapshot(
			ctx.sessionManager.getBranch(),
			operation.context,
			DEFAULT_MAX_CONTEXT_BYTES,
			operation.contextEntryIds,
		);
		return inspectResult({
			action: operation.action,
			preview: {
				mode: operation.context,
				turns: snapshot.turns,
				sourceCount: snapshot.sourceIds.length,
				bytes: Buffer.byteLength(snapshot.text, "utf8"),
				truncated: snapshot.truncated,
			},
		});
	}
	if (operation.action === "status") {
		return inspectResult({ action: operation.action, status: projectStatus(runtime) });
	}

	const settings = inspectSubagentSettings();
	const userDiscovery = discoverAgents(ctx.cwd, "user", settings.settings);
	const modelCount = availableModelCount(ctx);
	const runtimeStatus = runtime.getRuntimeStatus();
	const rpcCapability = inspectRpcCapability();
	const inProcessCapability = await inspectInProcessCapability();
	const checks = [
		{
			name: "settings",
			status: settings.error ? "fail" : "pass",
			message: settings.error
				? boundedPrivateText(settings.error, 2 * 1024)
				: "Settings are valid or absent.",
		},
		{
			name: "agent-discovery",
			status:
				userDiscovery.metadataDiscoveryIncomplete ||
				(userDiscovery.omittedAgentDefinitions ?? 0) > 0
					? "warning"
					: "pass",
			message: `${userDiscovery.agents.length} user-scope definitions available.`,
		},
		{
			name: "models",
			status: modelCount > 0 ? "pass" : "fail",
			message: `${modelCount} session-usable models available.`,
		},
		{
			name: "runtime",
			status: runtimeStatus.enabled && !runtimeStatus.initialized ? "warning" : "pass",
			message: runtimeStatus.initialized
				? "Stateful runtime initialized."
				: "Stateful runtime not initialized.",
		},
		{
			name: "in-process-sdk",
			status: inProcessCapability.error ? "fail" : "pass",
			message: inProcessCapability.error
				? boundedPrivateText(inProcessCapability.error, 2 * 1024)
				: "Required public Pi in-process session APIs are available.",
		},
		{
			name: "rpc-cli",
			status: rpcCapability.error ? "fail" : "pass",
			message: rpcCapability.error
				? boundedPrivateText(rpcCapability.error, 2 * 1024)
				: "The exact loaded Pi CLI is available for persistent RPC transport.",
		},
		{
			name: "consultation",
			status: runtime.getBlockingEnabled() && modelCount > 0 ? "pass" : "fail",
			message: runtime.getBlockingEnabled()
				? modelCount > 0
					? "Read-only consultation is supported."
					: "Consultation has no available model."
				: "Blocking delegation is disabled, so consultation is not registered.",
		},
	] as const;
	return inspectResult({
		action: operation.action,
		checks,
		ok: checks.every((check) => check.status !== "fail"),
	});
}

function projectAgent(
	agent: AgentConfig,
	ctx: ExtensionContext,
	includeTools = true,
): Record<string, unknown> {
	const tools = agent.tools === undefined ? undefined : projectToolNames(agent.tools);
	return {
		name: boundedPrivateText(agent.name, 256),
		description: boundedPrivateText(agent.description, 256),
		source: agent.source,
		scope: agent.source === "project" ? "project" : "user",
		path:
			agent.source === "project"
				? safeTerminalLine(
						path.posix.join(CONFIG_DIR_NAME, "agents", path.basename(agent.filePath)),
					)
				: safeDisplayPath(agent.filePath, ctx.cwd),
		model: agent.model ? boundedPrivateText(agent.model, 256) : undefined,
		thinkingLevel: agent.thinkingLevel,
		capabilityManifest: projectCapabilityManifest(agent.capabilityManifest),
		...(includeTools
			? { tools, toolCount: agent.tools?.length }
			: { toolCount: agent.tools?.length }),
		consultTools: resolveConsultTools(agent.tools),
	};
}

function projectRunSummary(run: AgentRunInspectionSummary): Record<string, unknown> {
	return {
		id: boundedPrivateText(run.id, 256),
		agent: boundedPrivateText(run.agent, 256),
		state: run.state,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		historyCount: run.historyCount,
		unreadMessages: run.unreadMessages,
		turnGeneration: run.turnGeneration,
		pendingCompletionCount: run.pendingCompletionCount,
	};
}

function projectRun(run: AgentRunInspectionDetail, ctx: ExtensionContext): Record<string, unknown> {
	return {
		...projectRunSummary(run),
		cwd: safeDisplayPath(run.cwd, ctx.cwd),
		workspaceMode: run.workspaceMode ?? "shared",
		thinkingLevel: run.thinkingLevel,
		timeoutMs: run.timeoutMs,
		currentTimeoutMs: run.currentTimeoutMs,
		idleTimeoutMs: run.idleTimeoutMs,
		currentIdleTimeoutMs: run.currentIdleTimeoutMs,
		maxTurns: run.maxTurns,
		currentMaxTurns: run.currentMaxTurns,
		maxToolCalls: run.maxToolCalls,
		currentMaxToolCalls: run.currentMaxToolCalls,
		context: {
			turns: run.contextTurns ?? 0,
			sources: run.contextSources ?? 0,
			bytes: run.contextBytes ?? 0,
			truncated: run.contextTruncated === true,
		},
		contract: run.contract
			? {
					version: run.contract.version,
					level: run.contract.level,
					taskId: boundedPrivateText(run.contract.taskId, 256),
					enforcement: run.contract.enforcement,
					dependencies: run.contract.dependencies.length,
					acceptanceCriteria: run.contract.acceptanceCriteria.length,
					requiredEvidence: run.contract.requiredEvidence.length,
				}
			: undefined,
		resultFormat: run.resultFormat ?? "text",
		structuredResult: run.structuredResult,
		termination: run.termination,
		outcome: run.outcome,
		capabilityGrant: run.capabilityGrant
			? {
					version: run.capabilityGrant.version,
					id: run.capabilityGrant.id,
					executionPlanId: run.capabilityGrant.executionPlanId,
					taskGeneration: run.capabilityGrant.taskGeneration,
					issuedAt: run.capabilityGrant.issuedAt,
					expiresAt: run.capabilityGrant.expiresAt,
					state: run.capabilityGrant.state,
					revokedAt: run.capabilityGrant.revokedAt,
					revocationReason: run.capabilityGrant.revocationReason,
				}
			: undefined,
		executionPlan: run.executionPlan
			? {
					...run.executionPlan,
					target: {
						...run.executionPlan.target,
						cwd: safeDisplayPath(run.executionPlan.target.cwd, ctx.cwd),
						trust: { ...run.executionPlan.target.trust, sourcePath: undefined },
					},
				}
			: undefined,
		semanticSnapshot: run.semanticSnapshot
			? {
					version: run.semanticSnapshot.version,
					digest: run.semanticSnapshot.digest,
					components: { ...run.semanticSnapshot.components },
				}
			: undefined,
		semanticCompatibility: run.semanticCompatibility,
		telemetry: run.telemetry,
		currentRunId: run.currentRunId,
		currentTurnGeneration: run.currentTurnGeneration,
		currentTask: run.currentTask ? boundedPrivateText(run.currentTask, 2 * 1024) : undefined,
		error: run.error ? boundedPrivateText(run.error, 2 * 1024) : undefined,
		target: run.target
			? {
					cwd: safeDisplayPath(run.target.cwd, ctx.cwd),
					boundary: run.target.boundary,
					trust: {
						kind: run.target.trust.kind,
						projectTrusted: run.target.trust.projectTrusted,
						sourcePath: run.target.trust.sourcePath
							? safeDisplayPath(run.target.trust.sourcePath, ctx.cwd)
							: undefined,
						warning: run.target.trust.warning
							? boundedPrivateText(run.target.trust.warning, 512)
							: undefined,
					},
				}
			: undefined,
		policy: run.policy
			? {
					inherited: projectToolNames(run.policy.inherited),
					overridden: projectToolNames(run.policy.overridden),
					unsupported: projectToolNames(run.policy.unsupported),
				}
			: undefined,
	};
}

function projectWorkflowSummary(workflow: WorkItemLedgerSnapshot): Record<string, unknown> {
	return {
		workflowId: boundedPrivateText(workflow.workflowId, 256),
		generation: workflow.generation,
		itemCount: workflow.items.length,
		states: Object.fromEntries(
			[...new Set(workflow.items.map((item) => item.state))]
				.sort()
				.map((state) => [state, workflow.items.filter((item) => item.state === state).length]),
		),
	};
}

function projectWorkflow(workflow: WorkItemLedgerSnapshot): Record<string, unknown> {
	const projected = boundedProjection(workflow.items, 64, (item) => ({
		id: boundedPrivateText(item.id, 256),
		state: item.state,
		generation: item.generation,
		taskGeneration: item.taskGeneration,
		dependencies: item.dependencies.map((value) => boundedPrivateText(value, 256)),
		assignedAgentId: item.assignedAgentId
			? boundedPrivateText(item.assignedAgentId, 256)
			: undefined,
		acceptedExecutionPlanId: item.acceptedExecutionPlanId,
		artifacts: item.artifacts.map((artifact) => ({
			id: boundedPrivateText(artifact.id, 256),
			kind: boundedPrivateText(artifact.kind, 256),
			version: boundedPrivateText(artifact.version, 256),
			producerTaskId: artifact.producerTaskId
				? boundedPrivateText(artifact.producerTaskId, 256)
				: undefined,
			generation: artifact.generation,
			verified: artifact.verified,
		})),
		verificationAccepted: item.verificationAccepted,
		acceptanceStateVersion: item.acceptanceStateVersion,
		acceptanceRequired: item.acceptanceRequired,
		acceptanceState: item.acceptanceState,
		reworkCount: item.reworkCount,
		maxReworkCycles: item.maxReworkCycles,
		acceptanceReceipt: item.acceptanceReceipt
			? {
					version: item.acceptanceReceipt.version,
					decision: item.acceptanceReceipt.decision,
					targetTaskId: boundedPrivateText(item.acceptanceReceipt.targetTaskId, 256),
					targetTaskGeneration: item.acceptanceReceipt.targetTaskGeneration,
					targetExecutionPlanId: item.acceptanceReceipt.targetExecutionPlanId,
					verifierTaskId: boundedPrivateText(item.acceptanceReceipt.verifierTaskId, 256),
					verifierTaskGeneration: item.acceptanceReceipt.verifierTaskGeneration,
					verifierExecutionPlanId: item.acceptanceReceipt.verifierExecutionPlanId,
					verifierAgent: boundedPrivateText(item.acceptanceReceipt.verifierAgent, 256),
					beforeTreeIdentity: item.acceptanceReceipt.beforeTreeIdentity,
					afterTreeIdentity: item.acceptanceReceipt.afterTreeIdentity,
					patchDigest: item.acceptanceReceipt.patchDigest,
					changedPathCount: item.acceptanceReceipt.changedPaths.length,
					checkCount: item.acceptanceReceipt.checks.length,
					requiredEvidenceCount: item.acceptanceReceipt.requiredEvidenceIds.length,
					createdAt: item.acceptanceReceipt.createdAt,
					sourceTruncated: item.acceptanceReceipt.sourceTruncated,
				}
			: undefined,
		acceptanceReceiptHistoryCount: item.acceptanceReceiptHistory.length,
		stagedTreeIdentity: item.stagedTreeIdentity
			? {
					version: item.stagedTreeIdentity.version,
					kind: item.stagedTreeIdentity.kind,
					digest: item.stagedTreeIdentity.digest,
				}
			: undefined,
		verificationReceipt: item.verificationReceipt
			? {
					version: item.verificationReceipt.version,
					decision: item.verificationReceipt.decision,
					targetTaskId: boundedPrivateText(item.verificationReceipt.targetTaskId, 256),
					targetTaskGeneration: item.verificationReceipt.targetTaskGeneration,
					targetExecutionPlanId: item.verificationReceipt.targetExecutionPlanId,
					verifierTaskId: boundedPrivateText(item.verificationReceipt.verifierTaskId, 256),
					verifierTaskGeneration: item.verificationReceipt.verifierTaskGeneration,
					verifierExecutionPlanId: item.verificationReceipt.verifierExecutionPlanId,
					treeIdentity: item.verificationReceipt.treeIdentity,
					summary: boundedPrivateText(item.verificationReceipt.summary, 8 * 1024),
					evidenceCount: item.verificationReceipt.evidence.length,
					limitationCount: item.verificationReceipt.limitations.length,
					createdAt: item.verificationReceipt.createdAt,
					truncated: item.verificationReceipt.truncated,
				}
			: undefined,
		outcomeReason: item.outcomeReason
			? boundedPrivateText(item.outcomeReason, 2 * 1024)
			: undefined,
	}));
	return {
		...projectWorkflowSummary(workflow),
		items: projected.items,
		omittedItems: projected.omitted,
	};
}

function projectModels(ctx: ExtensionContext, limit: number): Record<string, unknown> {
	const scoped = ctx.scopedModels ?? [];
	const candidates =
		scoped.length > 0
			? scoped
			: ctx.modelRegistry.getAvailable().map((model) => ({ model, thinkingLevel: undefined }));
	const selected = boundedProjection(candidates, limit, ({ model, thinkingLevel }) => ({
		provider: boundedPrivateText(model.provider, 256),
		id: boundedPrivateText(model.id, 256),
		name: boundedPrivateText(model.name, 256),
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		thinkingLevel,
		current: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
	}));
	return {
		models: selected.items,
		returned: selected.items.length,
		omitted: selected.omitted,
		source: scoped.length > 0 ? "session scope" : "available snapshot",
	};
}

function projectStatus(runtime: SubagentInspectRuntime): Record<string, unknown> {
	const stateful = runtime.getRuntimeStatus();
	const workflow = resolveDelegationWorkflow(runtime.getBlockingEnabled(), stateful.enabled);
	const configured = inspectDelegationWorkflowSettings();
	const resources = inspectConsultResourceSettings();
	const cwdPolicy = inspectCwdPolicySettings();
	const completion = inspectCompletionDeliverySettings();
	const parallelLimit = inspectBlockingParallelLimitSettings();
	const detachedLimits = inspectStatefulLimitSettings();
	const transport = inspectStatefulTransportSettings();
	const configuredDetachedLimits = detachedLimits.values
		? Object.fromEntries(
				Object.entries(detachedLimits.values).map(([field, snapshot]) => [field, snapshot.value]),
			)
		: undefined;
	const configuredDetachedLimitSources = detachedLimits.values
		? Object.fromEntries(
				Object.entries(detachedLimits.values).map(([field, snapshot]) => [field, snapshot.source]),
			)
		: undefined;
	return {
		workflow,
		configuredWorkflow: configured.value,
		configuredWorkflowSource: configured.source,
		stateful,
		statefulLimits: stateful.limits,
		configuredTransport: transport.value,
		configuredTransportSource: transport.source,
		configuredStatefulLimits: configuredDetachedLimits,
		configuredStatefulLimitSources: configuredDetachedLimitSources,
		configuredCompletionDelivery: completion.value,
		configuredCompletionDeliverySource: completion.source,
		maxParallelTasks: runtime.getMaxParallelTasks(),
		configuredMaxParallelTasks: parallelLimit.value,
		configuredMaxParallelTasksSource: parallelLimit.source,
		consultResources: runtime.getConsultResourcePolicy(),
		consultationCwdPolicy: runtime.getConsultationCwdPolicy(),
		configuredConsultationCwdPolicy: cwdPolicy.consultation.value,
		consultationCwdPolicySource: cwdPolicy.consultation.source,
		delegationCwdPolicy: runtime.getDelegationCwdPolicy(),
		configuredDelegationCwdPolicy: cwdPolicy.delegation.value,
		delegationCwdPolicySource: cwdPolicy.delegation.source,
		configuredConsultResources: resources.value,
		consultResourcesSource: resources.source,
		settingsPath: safeDisplayPath(resources.path, process.cwd()),
		settingsError:
			configured.error ||
			resources.error ||
			cwdPolicy.error ||
			completion.error ||
			parallelLimit.error ||
			detachedLimits.error ||
			transport.error
				? boundedPrivateText(
						configured.error ??
							resources.error ??
							cwdPolicy.error ??
							completion.error ??
							parallelLimit.error ??
							detachedLimits.error ??
							transport.error ??
							"",
						2 * 1024,
					)
				: undefined,
	};
}

async function inspectInProcessCapability(): Promise<{ error?: string }> {
	try {
		const moduleSpecifier = "@earendil-works/pi-coding-agent";
		const core = await import(moduleSpecifier);
		for (const name of [
			"createAgentSessionServices",
			"createAgentSessionFromServices",
			"resolveCliModel",
		] as const) {
			if (typeof core[name] !== "function") return { error: `Pi core does not export ${name}()` };
		}
		return {};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function inspectRpcCapability(): { error?: string } {
	try {
		resolvePiInvocation(["--mode", "rpc", "--no-session"]);
		return {};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function availableModelCount(ctx: ExtensionContext): number {
	return (ctx.scopedModels?.length ?? 0) > 0
		? ctx.scopedModels.length
		: ctx.modelRegistry.getAvailable().length;
}

function projectToolNames(tools: readonly string[]): string[] {
	return tools.slice(0, 100).map((tool) => boundedPrivateText(tool, 256));
}

function boundedProjection<T, TProjected>(
	values: readonly T[],
	limit: number,
	project: (value: T) => TProjected,
): { items: TProjected[]; omitted: number } {
	const items: TProjected[] = [];
	for (const value of values.slice(0, limit)) {
		const next = project(value);
		if (Buffer.byteLength(JSON.stringify([...items, next]), "utf8") > MAX_DETAILS_LIST_BYTES) break;
		items.push(next);
	}
	return { items, omitted: Math.max(0, values.length - items.length) };
}

function inspectResult(details: Record<string, unknown>): InspectToolResult {
	const rendered = boundText(JSON.stringify(details, null, 2));
	return {
		content: [{ type: "text", text: rendered.text }],
		details: { ...details, ...(rendered.truncated ? { truncated: true } : {}) },
	};
}

function assertTrustedScope(scope: AgentScope, ctx: ExtensionContext): void {
	if ((scope === "project" || scope === "both") && !ctx.isProjectTrusted()) {
		throw new Error("Project-local subagent definitions require a trusted project");
	}
}

function parameterRecord(params: unknown): Record<string, unknown> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("subagent_inspect parameters must be an object");
	}
	return params as Record<string, unknown>;
}

function optionalAgentScope(value: unknown): AgentScope {
	if (value === undefined) return "user";
	if (value === "user" || value === "project" || value === "both") return value;
	throw new Error("subagent_inspect agentScope must be user, project, or both");
}

function requiredString(value: unknown, action: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`subagent_inspect action "${action}" requires ${field}`);
	}
	return value;
}

function optionalContextMode(value: unknown): ContextMode {
	if (value === undefined) return "none";
	if (value === "none" || value === "all" || value === "summary") return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
	throw new Error("subagent_inspect context must be none, all, summary, or a positive integer");
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string" && item.length > 0)
	) {
		throw new Error(`subagent_inspect ${field} must be an array of non-empty strings`);
	}
	return [...value];
}

function optionalLimit(value: unknown, defaultValue: number): number {
	if (value === undefined) return defaultValue;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
		throw new Error("subagent_inspect limit must be an integer between 1 and 100");
	}
	return value as number;
}
