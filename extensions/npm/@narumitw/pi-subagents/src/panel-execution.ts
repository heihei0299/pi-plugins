import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentScope, SubagentThinkingLevel } from "./agents/types.js";
import { panelReviewStatus, panelSynthesisStatus, startSubagentStatus } from "./blocking-status.js";
import { issueCapabilityGrant, revokeCapabilityGrant } from "./capability-grant.js";
import type { ResolvedSubagentTarget } from "./cwd-policy.js";
import { targetPolicyAudit } from "./cwd-policy.js";
import type { DelegationContract } from "./delegation-contract.js";
import {
	acknowledgeExecutionPlan,
	createExecutionPlan,
	resolveContractTools,
} from "./execution-plan.js";
import {
	DEFAULT_MAX_OUTPUT_BYTES,
	MAX_BLOCKING_PARALLEL_CONCURRENCY,
	truncateUtf8,
} from "./limits.js";
import { calculateOrchestrationMetrics } from "./orchestration-metrics.js";
import { PanelChildGroup } from "./panel-child-group.js";
import { type PanelReview, parsePanelReview, parsePanelSynthesis } from "./panel-contract.js";
import { PanelEvidenceLedger } from "./panel-evidence.js";
import { classifyPanelFailure, type PanelFailure } from "./panel-failure.js";
import {
	createPanelWorkLedger,
	type PanelPreset,
	planPanelBudgets,
	validatePanelRequest,
} from "./panel-planning.js";
import { buildPanelReviewerPrompt, buildPanelSynthesisPrompt } from "./panel-prompts.js";
import { reconcilePanel } from "./panel-reconciliation.js";
import type { SubagentParams } from "./params.js";
import {
	type ChildLaunchPolicy,
	getResultFinalOutput,
	isResultError,
	mapWithConcurrencyLimit,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
} from "./runner.js";
import { boundedPrivateText, boundText } from "./safe-text.js";
import { createSessionWorkItemPersistence } from "./work-item-persistence.js";
import { assertWorkspaceIsolationReady } from "./workspace.js";

export interface PanelExecutionInput {
	toolCallId: string;
	params: SubagentParams;
	panel: NonNullable<SubagentParams["panel"]>;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
	ctx: ExtensionContext;
	agents: AgentConfig[];
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	maxParallelTasks: number;
	target: ResolvedSubagentTarget;
	resolveThinkingLevel: (
		agentName: string,
		local?: SubagentThinkingLevel,
	) => SubagentThinkingLevel | undefined;
	resolveTimeoutMs: (agentName: string, local?: number) => number;
}

type PanelToolResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

const PANEL_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export async function preflightPanelExecution(
	input: Pick<
		PanelExecutionInput,
		"panel" | "agents" | "target" | "resolveThinkingLevel" | "resolveTimeoutMs" | "signal"
	>,
): Promise<void> {
	assertPanelActive(input.signal);
	let requiresWorktree = false;
	for (const [index, reviewer] of input.panel.reviewers.entries()) {
		assertPanelActive(input.signal);
		const agent = input.agents.find((candidate) => candidate.name === reviewer.agent);
		if (!agent) throw new Error(`Unknown panel agent: ${reviewer.agent}`);
		requiresWorktree ||= !isReadOnlyAgent(agent);
		const policy = launchPolicy(
			input as PanelExecutionInput,
			reviewer.agent,
			input.resolveThinkingLevel(reviewer.agent, reviewer.thinkingLevel),
			input.panel.task,
			input.resolveTimeoutMs(reviewer.agent, reviewer.timeoutMs),
			index + 1,
			isReadOnlyAgent(agent) ? "shared" : "worktree",
			"review",
		);
		if (policy.capabilityGrant) {
			revokeCapabilityGrant(policy.capabilityGrant, "preflight-complete", Date.now());
		}
	}
	if (requiresWorktree) {
		await assertWorkspaceIsolationReady(input.target.cwd);
		assertPanelActive(input.signal);
	}
	const synthesizer = input.panel.synthesizer;
	const policy = launchPolicy(
		input as PanelExecutionInput,
		synthesizer.agent,
		input.resolveThinkingLevel(synthesizer.agent, synthesizer.thinkingLevel),
		"Panel synthesis",
		input.resolveTimeoutMs(synthesizer.agent, synthesizer.timeoutMs),
		input.panel.reviewers.length + 1,
		"shared",
		"tool-less",
	);
	if (policy.capabilityGrant) {
		revokeCapabilityGrant(policy.capabilityGrant, "preflight-complete", Date.now());
	}
}

export async function executePanel(input: PanelExecutionInput): Promise<PanelToolResult> {
	validatePanelRequest(input.panel, input.maxParallelTasks);
	const panelId = input.panel.id ?? `panel-${input.toolCallId}`;
	const preset: PanelPreset = input.panel.preset ?? "custom";
	const minValidReviews = input.panel.minValidReviews ?? 2;
	const requestedReviewTimeout = Math.max(
		...input.panel.reviewers.map((reviewer) =>
			input.resolveTimeoutMs(reviewer.agent, reviewer.timeoutMs),
		),
	);
	const requestedSynthesisTimeout = input.resolveTimeoutMs(
		input.panel.synthesizer.agent,
		input.panel.synthesizer.timeoutMs,
	);
	const totalMs =
		input.params.totalTimeoutMs ?? requestedReviewTimeout + requestedSynthesisTimeout + 60_000;
	const budgets = planPanelBudgets(totalMs, input.panel.reviewers.length);
	const panelStartedAt = Date.now();
	const failureMessageLimit = Math.max(128, Math.floor((8 * 1024) / input.panel.reviewers.length));
	const requiredAgents = [
		...input.panel.reviewers.map((reviewer) => reviewer.agent),
		input.panel.synthesizer.agent,
	];
	for (const agentName of requiredAgents) {
		if (!input.agents.some((agent) => agent.name === agentName)) {
			throw new Error(`Unknown panel agent: ${agentName}`);
		}
	}

	const group = new PanelChildGroup(input.signal);
	const ledger = new PanelEvidenceLedger(panelId, input.panel.reviewers.length);
	const workLedger = createPanelWorkLedger(panelId, input.panel, input.agents);
	const persistenceOwner =
		input.ctx.sessionManager.getSessionId?.() ??
		input.ctx.sessionManager.getSessionFile?.() ??
		`ephemeral:${input.ctx.cwd}`;
	const workPersistence = createSessionWorkItemPersistence(persistenceOwner, panelId);
	const persistWork = () => workPersistence.save(workLedger.snapshot());
	const workspaceByReviewer = new Map<string, string>();
	let output: PanelToolResult | undefined;
	const results: SingleResult[] = [];
	const failures: PanelFailure[] = [];
	let panelDetails = createPanelDetails({
		panelId,
		preset,
		reviewerIds: input.panel.reviewers.map((reviewer) => reviewer.id),
		sharedTask: input.panel.task,
		budgets,
	});
	const makeDetails = (currentResults: SingleResult[] = results): SubagentDetails => ({
		mode: "panel",
		agentScope: input.agentScope,
		projectAgentsDir: input.projectAgentsDir,
		results: [...currentResults],
		workflow: workLedger.snapshot(),
		metrics: calculateOrchestrationMetrics(workLedger.snapshot(), currentResults, panelDetails),
		panel: panelDetails,
	});
	const status = startSubagentStatus(
		input.ctx,
		input.toolCallId,
		panelReviewStatus(0, input.panel.reviewers.length, input.panel.reviewers.length),
	);

	try {
		await persistWork();
		assertPanelActive(group.signal);
		for (const reviewer of input.panel.reviewers) {
			assertPanelActive(group.signal);
			const agent = input.agents.find(
				(candidate) => candidate.name === reviewer.agent,
			) as AgentConfig;
			if (isReadOnlyAgent(agent)) continue;
			const workspace = await group.createWorkspace(`${panelId}:${reviewer.id}`, input.target.cwd);
			assertPanelActive(group.signal);
			workspaceByReviewer.set(reviewer.id, workspace.path);
		}

		let completed = 0;
		const reviewPhaseStartedAt = panelStartedAt;
		const reviewResults = await mapWithConcurrencyLimit(
			input.panel.reviewers,
			Math.min(MAX_BLOCKING_PARALLEL_CONCURRENCY, input.maxParallelTasks),
			async (reviewer, index) => {
				const workItemId = `review:${reviewer.id}`;
				const startedWork = workLedger.start(workItemId, `agent:${reviewer.agent}`);
				const taskGeneration = startedWork.taskGeneration;
				const prompt = buildPanelReviewerPrompt({
					panelId,
					preset,
					task: input.panel.task,
					context: input.panel.context,
					reviewerId: reviewer.id,
					focus: reviewer.focus,
				});
				const phaseRemaining = budgets.reviewMs - (Date.now() - reviewPhaseStartedAt);
				const reviewBudgetAvailable = phaseRemaining >= 1;
				const timeoutMs = Math.min(
					input.resolveTimeoutMs(reviewer.agent, reviewer.timeoutMs),
					phaseRemaining,
				);
				const thinkingLevel = input.resolveThinkingLevel(reviewer.agent, reviewer.thinkingLevel);
				let artifactRevision = 0;
				let latestFingerprint = "";
				let repeatedEvidenceUpdates = 0;
				const reviewerController = new AbortController();
				const reviewerSignal = AbortSignal.any([group.signal, reviewerController.signal]);
				const publishOutput = (candidate: SingleResult): PanelReview | undefined => {
					const parsed = parsePanelReview(getResultFinalOutput(candidate), reviewer.id, {
						agent: reviewer.agent,
						model: candidate.actualModel ?? candidate.model,
						taskGeneration,
					});
					if (!parsed) return undefined;
					const fingerprint = JSON.stringify(parsed);
					if (fingerprint === latestFingerprint) {
						repeatedEvidenceUpdates += 1;
						if (repeatedEvidenceUpdates >= 8 && !reviewerController.signal.aborted) {
							reviewerController.abort("semantic-stall");
						}
						return parsed;
					}
					artifactRevision += 1;
					if (!ledger.publish(parsed, artifactRevision)) {
						artifactRevision -= 1;
						return undefined;
					}
					latestFingerprint = fingerprint;
					repeatedEvidenceUpdates = 0;
					return parsed;
				};
				const runAttempt = async (attempt: number): Promise<SingleResult> => {
					if (!reviewBudgetAvailable) {
						return panelReviewerBudgetExhaustedResult(
							input.agents,
							reviewer.agent,
							input.panel.task,
							thinkingLevel,
						);
					}
					const result = await runSingleAgent(
						input.ctx.cwd,
						input.agents,
						reviewer.agent,
						prompt,
						workspaceByReviewer.get(reviewer.id) ?? input.target.cwd,
						index + 1,
						reviewerSignal,
						thinkingLevel,
						timeoutMs,
						(partial) => {
							const partialResult = partial.details?.results[0];
							if (partialResult) publishOutput(partialResult);
							input.onUpdate?.({
								content: partial.content,
								details: makeDetails(),
							});
						},
						makeDetails,
						undefined,
						launchPolicy(
							input,
							reviewer.agent,
							thinkingLevel,
							`Panel review ${reviewer.id}`,
							timeoutMs,
							taskGeneration,
							workspaceByReviewer.has(reviewer.id) ? "worktree" : "shared",
							"review",
							{
								idleTimeoutMs: reviewer.idleTimeoutMs ?? input.params.idleTimeoutMs,
								maxTurns: reviewer.maxTurns ?? input.params.maxTurns,
								maxToolCalls: reviewer.maxToolCalls ?? input.params.maxToolCalls,
							},
							reviewPhaseStartedAt + budgets.reviewMs + budgets.finalizationMs,
						),
					);
					result.target = targetPolicyAudit(input.target);
					result.attemptCount = attempt;
					if (
						reviewerController.signal.reason === "semantic-stall" &&
						result.aborted &&
						!group.signal.aborted
					) {
						result.aborted = false;
						result.stopReason = "semantic-stall";
						result.errorMessage =
							"Panel reviewer stopped after repeated updates without new valid evidence";
					}
					return result;
				};

				let result = await runAttempt(1);
				let parsed = publishOutput(result) ?? ledger.latest(reviewer.id)?.review;
				let classification = classifyPanelFailure(result);
				if (!parsed && classification.retryable && !group.signal.aborted) {
					result = await runAttempt(2);
					parsed = publishOutput(result) ?? ledger.latest(reviewer.id)?.review;
					classification = classifyPanelFailure(result);
				}
				if (!parsed && result.timedOut && reviewBudgetAvailable && !group.signal.aborted) {
					const finalizationPrompt = `${prompt}\n\nYour prior attempt stopped before a valid artifact. Use this bounded checkpoint and return the required panel-review JSON now:\n${boundText(getResultFinalOutput(result), 8 * 1024, 200).text}`;
					const finalized = await runSingleAgent(
						input.ctx.cwd,
						input.agents,
						reviewer.agent,
						finalizationPrompt,
						workspaceByReviewer.get(reviewer.id) ?? input.target.cwd,
						index + 1,
						group.signal,
						thinkingLevel,
						budgets.finalizationMs,
						undefined,
						makeDetails,
						undefined,
						{
							...launchPolicy(
								input,
								reviewer.agent,
								thinkingLevel,
								`Panel review finalization ${reviewer.id}`,
								budgets.finalizationMs,
								taskGeneration,
								workspaceByReviewer.has(reviewer.id) ? "worktree" : "shared",
								"tool-less",
							),
							finalizeOnTimeout: false,
						},
					);
					finalized.attemptCount = (result.attemptCount ?? 1) + 1;
					result = finalized;
					parsed = publishOutput(result) ?? ledger.latest(reviewer.id)?.review;
					classification = classifyPanelFailure(result);
				}
				if (parsed && isResultError(result)) {
					failures.push({
						reviewerId: reviewer.id,
						...classification,
						message: boundedPrivateText(
							result.errorMessage ??
								(result.stderr.trim() || "Reviewer failed after publishing valid evidence"),
							failureMessageLimit,
						),
					});
				}
				if (!parsed) {
					if (!isResultError(result)) result.resultContractInvalid = true;
					classification = classifyPanelFailure(result);
					failures.push({
						reviewerId: reviewer.id,
						...classification,
						message: boundedPrivateText(
							result.errorMessage ?? (result.stderr.trim() || "No valid panel review artifact"),
							failureMessageLimit,
						),
					});
					workLedger.settle(
						workItemId,
						result.aborted ? "interrupted" : "failed",
						classification.kind,
					);
				} else {
					const artifact = ledger.latest(reviewer.id);
					workLedger.complete(workItemId, {
						taskGeneration,
						executionPlanId: result.executionPlan?.id,
						artifacts: artifact
							? [
									{
										id: `panel-review:${reviewer.id}`,
										kind: "panel-review",
										version: String(artifact.revision),
										verified: false,
									},
								]
							: [],
					});
				}
				completed += 1;
				status.update(
					panelReviewStatus(
						completed,
						input.panel.reviewers.length,
						input.panel.reviewers.length - completed,
					),
				);
				return compactPanelResult(result);
			},
			group.signal,
			(reviewer) => {
				const workItemId = `review:${reviewer.id}`;
				workLedger.settle(workItemId, "interrupted", "parent-aborted-before-launch");
				failures.push({
					reviewerId: reviewer.id,
					kind: "cancelled",
					retryable: false,
					message: "Panel reviewer was not launched because the parent call was cancelled",
				});
				completed += 1;
				return cancelledPanelResult(
					input.agents,
					reviewer.agent,
					input.panel.task,
					input.resolveThinkingLevel(reviewer.agent, reviewer.thinkingLevel),
				);
			},
		);
		results.push(...reviewResults);
		await persistWork();
		const reviews = ledger.snapshot().map((artifact) => artifact.review);
		const reconciliation = reconcilePanel({ reviews, failures, minValidReviews });
		panelDetails = {
			...panelDetails,
			validReviewCount: reviews.length,
			failedReviewCount: failures.length,
			blockingObjectionCount: reconciliation.blockingObjections.length,
			evidence: ledger.snapshot(),
			failures: [...reconciliation.failures],
		};
		if (reconciliation.kind === "insufficient-panel") {
			workLedger.settle(
				"synthesis",
				group.signal.aborted ? "interrupted" : "blocked",
				"insufficient-valid-reviews",
			);
			await persistWork();
			panelDetails.state = group.signal.aborted ? "cancelled" : "insufficient-panel";
			output = {
				content: [
					{
						type: "text",
						text: boundText(
							`Insufficient panel: ${reviews.length}/${minValidReviews} valid reviews. Partial evidence was preserved; synthesis was not run.`,
							DEFAULT_MAX_OUTPUT_BYTES,
						).text,
					},
				],
				details: { ...makeDetails(), isError: true },
				isError: true,
			};
		} else {
			const synthesisWork = workLedger.start("synthesis", `agent:${input.panel.synthesizer.agent}`);
			await persistWork();
			status.update(panelSynthesisStatus(input.panel.synthesizer.agent));
			const synthesisPrompt = buildPanelSynthesisPrompt({
				panelId,
				task: input.panel.task,
				reviews: reconciliation.reviews,
				failures: reconciliation.failures,
			});
			const synthesisTimeout = Math.min(
				input.resolveTimeoutMs(input.panel.synthesizer.agent, input.panel.synthesizer.timeoutMs),
				budgets.synthesisMs,
				Math.max(0, panelStartedAt + budgets.totalMs - budgets.cleanupMs - Date.now()),
			);
			const synthesisThinkingLevel = input.resolveThinkingLevel(
				input.panel.synthesizer.agent,
				input.panel.synthesizer.thinkingLevel,
			);
			const synthesisResult =
				synthesisTimeout < 1
					? panelBudgetExhaustedResult(
							input.agents,
							input.panel.synthesizer.agent,
							synthesisPrompt,
							synthesisThinkingLevel,
						)
					: await runSingleAgent(
							input.ctx.cwd,
							input.agents,
							input.panel.synthesizer.agent,
							synthesisPrompt,
							input.target.cwd,
							undefined,
							group.signal,
							synthesisThinkingLevel,
							synthesisTimeout,
							undefined,
							makeDetails,
							undefined,
							{
								...launchPolicy(
									input,
									input.panel.synthesizer.agent,
									synthesisThinkingLevel,
									"Panel synthesis",
									synthesisTimeout,
									input.panel.reviewers.length + 1,
									"shared",
									"tool-less",
									{
										idleTimeoutMs:
											input.panel.synthesizer.idleTimeoutMs ?? input.params.idleTimeoutMs,
										maxTurns: input.panel.synthesizer.maxTurns ?? input.params.maxTurns,
										maxToolCalls: input.panel.synthesizer.maxToolCalls ?? input.params.maxToolCalls,
									},
								),
							},
						);
			synthesisResult.target = targetPolicyAudit(input.target);
			const synthesis = parsePanelSynthesis(
				getResultFinalOutput(synthesisResult),
				reconciliation.reviews,
				reconciliation.failures
					.map((failure) => failure.reviewerId)
					.filter((id): id is string => Boolean(id)),
			);
			compactPanelResult(synthesisResult);
			const synthesisErrored = isResultError(synthesisResult);
			panelDetails = {
				...panelDetails,
				synthesizerResult: synthesisResult,
				synthesis,
				dissentCount: synthesis?.disagreements.length ?? 0,
				state: synthesisErrored
					? group.signal.aborted
						? "cancelled"
						: "failed"
					: synthesis
						? failures.length > 0
							? "degraded"
							: "completed"
						: group.signal.aborted
							? "cancelled"
							: "failed",
			};
			const synthesisInvalid = !synthesis || synthesisErrored;
			if (!synthesis && !isResultError(synthesisResult)) {
				synthesisResult.resultContractInvalid = true;
			}
			if (synthesisInvalid) {
				workLedger.settle(
					"synthesis",
					synthesisResult.aborted ? "interrupted" : "failed",
					"invalid-panel-synthesis",
				);
			} else {
				workLedger.complete("synthesis", {
					taskGeneration: synthesisWork.taskGeneration,
					executionPlanId: synthesisResult.executionPlan?.id,
				});
			}
			await persistWork();
			output = {
				content: [
					{
						type: "text",
						text: synthesis
							? boundText(synthesis.summary, DEFAULT_MAX_OUTPUT_BYTES).text
							: "Panel synthesis failed or returned an invalid panel-synthesis contract.",
					},
				],
				details: { ...makeDetails(), isError: synthesisInvalid || undefined },
				isError: synthesisInvalid || undefined,
			};
		}
	} finally {
		status.clear();
		await group.close();
		panelDetails.cleanupComplete = true;
		if (output?.details.panel) output.details.panel.cleanupComplete = true;
	}
	return output as PanelToolResult;
}

function assertPanelActive(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new DOMException("Panel execution was cancelled during setup", "AbortError");
}

function isReadOnlyAgent(agent: AgentConfig): boolean {
	return agent.capabilityManifest?.authority?.filesystem === "read";
}

function launchPolicy(
	input: PanelExecutionInput,
	agentName: string,
	thinkingLevel: SubagentThinkingLevel | undefined,
	displayTask: string,
	timeoutMs: number,
	taskGeneration: number,
	workspaceMode: "shared" | "worktree",
	toolMode: "review" | "tool-less",
	turnLimits?: ChildLaunchPolicy["turnLimits"],
	orchestrationDeadlineAt?: number,
): ChildLaunchPolicy {
	const agent = input.agents.find((candidate) => candidate.name === agentName);
	if (!agent) throw new Error(`Unknown panel agent: ${agentName}`);
	const resolvedTools = resolveContractTools(agent.tools, undefined);
	const tools =
		toolMode === "tool-less"
			? []
			: workspaceMode === "shared"
				? (resolvedTools?.filter((tool) => PANEL_READ_ONLY_TOOLS.has(tool)) ?? [])
				: resolvedTools;
	const contract: DelegationContract = {
		version: "pi-subagents:delegation:v2",
		level: "minimal",
		taskId: `panel-${taskGeneration}`,
		objective: truncateUtf8(displayTask, 16 * 1024).text,
		nonGoals: [],
		dependencies: [],
		requiredInputs: [],
		acceptanceCriteria: ["Return one valid bounded panel contract"],
		requiredEvidence: [],
		sideEffectPolicy:
			toolMode === "tool-less" || workspaceMode === "shared" ? "read-only" : "mutating",
		enforcement: "audit",
	};
	const executionPlan = createExecutionPlan({
		contract,
		agent,
		effectiveTools: tools,
		target: targetPolicyAudit(input.target),
		workspaceMode,
		transport: "subprocess",
		resultFormat: "text",
		model: agent.model,
		thinkingLevel,
		timeoutMs,
		taskGeneration,
	});
	const acknowledgement = acknowledgeExecutionPlan(executionPlan);
	if (acknowledgement.status === "rejected") {
		throw new Error(`Panel execution plan rejected: ${JSON.stringify(acknowledgement)}`);
	}
	return {
		projectTrust: input.target.trust.projectTrusted,
		tools,
		contract,
		displayTask,
		turnLimits,
		orchestrationDeadlineAt,
		finalizeOnTimeout: false,
		executionPlan,
		capabilityGrant: issueCapabilityGrant(executionPlan, Date.now(), timeoutMs + 60_000),
	};
}

function cancelledPanelResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	thinkingLevel: SubagentThinkingLevel | undefined,
): SingleResult {
	const message = "Panel reviewer was not launched because the parent call was cancelled";
	return {
		agent: agentName,
		agentSource: agents.find((agent) => agent.name === agentName)?.source ?? "unknown",
		task,
		exitCode: 130,
		messages: [],
		stderr: message,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		thinkingLevel,
		finalOutput: "",
		errorMessage: message,
		aborted: true,
		stopReason: "aborted",
	};
}

function panelReviewerBudgetExhaustedResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	thinkingLevel: SubagentThinkingLevel | undefined,
): SingleResult {
	const result = panelBudgetExhaustedResult(agents, agentName, task, thinkingLevel);
	result.errorMessage = "Panel review budget was exhausted before launch";
	result.stderr = result.errorMessage;
	return result;
}

function panelBudgetExhaustedResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	thinkingLevel: SubagentThinkingLevel | undefined,
): SingleResult {
	const message = "Panel synthesis budget was exhausted before launch";
	return {
		agent: agentName,
		agentSource: agents.find((agent) => agent.name === agentName)?.source ?? "unknown",
		task,
		exitCode: 124,
		messages: [],
		stderr: message,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		thinkingLevel,
		finalOutput: "",
		errorMessage: message,
		timedOut: true,
		stopReason: "timeout",
	};
}

function compactPanelResult(result: SingleResult): SingleResult {
	result.messages = [];
	result.recentActivity = undefined;
	result.recentActivityTotal = undefined;
	result.task = boundText(result.task, 512, 20).text;
	result.finalOutput = result.finalOutput
		? boundText(result.finalOutput, 512, 20).text
		: result.finalOutput;
	result.partialOutput = result.partialOutput
		? boundText(result.partialOutput, 512, 20).text
		: result.partialOutput;
	result.stderr = boundText(result.stderr, 512, 20).text;
	result.errorMessage = result.errorMessage
		? boundedPrivateText(result.errorMessage, 512)
		: result.errorMessage;
	return result;
}

function createPanelDetails(input: {
	panelId: string;
	preset: PanelPreset;
	reviewerIds: string[];
	sharedTask: string;
	budgets: ReturnType<typeof planPanelBudgets>;
}): NonNullable<SubagentDetails["panel"]> {
	return {
		id: input.panelId,
		preset: input.preset,
		sharedTaskPreview: boundedPrivateText(input.sharedTask, 2 * 1024),
		state: "running",
		reviewerIds: input.reviewerIds,
		validReviewCount: 0,
		failedReviewCount: 0,
		blockingObjectionCount: 0,
		dissentCount: 0,
		budgets: input.budgets,
		evidence: [],
		failures: [],
		cleanupComplete: false,
	};
}
