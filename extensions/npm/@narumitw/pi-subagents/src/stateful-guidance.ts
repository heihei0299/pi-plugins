import type { CompletionDelivery } from "./agents/types.js";

export function createSpawnPromptGuidelines(
	completionDelivery: CompletionDelivery,
	blockingEnabled = true,
): string[] {
	const deliveryGuidance =
		completionDelivery === "auto-resume"
			? blockingEnabled
				? "With subagent_spawn completion delivery set to auto-resume, prefer one subagent_spawn for broad asynchronous research or consequential independent review that covers related branches even when the final answer depends on its result; do not choose blocking parallel fan-out merely to keep delegation in the same turn."
				: "With subagent_spawn completion delivery set to auto-resume, prefer one subagent_spawn for broad asynchronous research or consequential independent review that covers related branches even when the final answer depends on its result."
			: blockingEnabled
				? "With subagent_spawn completion delivery set to next-turn (the default), prefer one subagent_spawn for broad asynchronous research or consequential independent review only when the current response does not depend on its result; use the blocking subagent when the final answer depends on the detached result."
				: "With subagent_spawn completion delivery set to next-turn (the default), use subagent_spawn only when the current response does not depend on its result; complete final-answer-dependent work directly because an idle root is not awakened.";
	return [
		"Do not use subagent_spawn for simple or critical-path work that the main agent can perform directly. The main agent retains overall planning, immediate critical-path work, integration, final verification, and the final answer.",
		"Before one ordinary subagent_spawn, identify concrete useful non-overlapping main-agent work you can start immediately and a supported completion integration path. If none exists, perform the task directly instead of calling subagent_spawn.",
		"Give subagent_spawn a concise unique taskName using lowercase letters, digits, and underscores so the retained agent has a stable canonical task path.",
		"Set subagent_spawn thinkingLevel to the lowest sufficient thinking level for the delegated task: use off or minimal for extraction, formatting, or mechanical work; low for straightforward bounded work; medium for ordinary multi-step research or implementation; high for complex debugging, design, review, or cross-file analysis; xhigh for highly ambiguous, cross-system, or high-risk analysis; and max only for the hardest tasks when quality clearly outweighs latency and cost. Omit subagent_spawn thinkingLevel only to preserve the agent or child default.",
		"Set subagent_spawn timeoutMs to the shortest realistic work deadline for the task difficulty; use idleTimeoutMs for stalled work and maxTurns or maxToolCalls to stop repeated work without progress. Split oversized tasks instead of extending budgets merely to compensate for broad scope. Omit these fields only to preserve the retained agent or configured defaults.",
		deliveryGuidance,
		"Keep ordinary review in the main agent with a review skill and deterministic checks; use subagent_spawn for detached review only when consequential independent verification has concrete parallel value.",
		"Use a single subagent_spawn for a bounded implementation slice with clear ownership only when it can run beside the identified main-agent work.",
		"Use a single subagent_spawn without concurrent main-agent work only for an explicit user-requested specialist model, tool profile, or isolation boundary.",
		...(blockingEnabled
			? [
					"Use the blocking subagent instead of subagent_spawn when synchronous output is required before the main agent can continue and waiting is intentional; queued steering cannot be processed until that blocking call returns.",
					"When subagent_spawn fits the completion-delivery policy, do not choose a blocking parallel subagent merely to keep delegation in the same turn.",
				]
			: []),
		"Add another subagent_spawn only for truly independent work with safe workspace concurrency and disjoint write ownership; shared workspaces permit concurrent writes by default, so use workspaceMode worktree when repository isolation is required. The main agent still owns integration.",
		"After subagent_spawn returns, immediately continue the identified local task; do not merely announce the spawn, wait, poll, or end the response while useful local work remains.",
		'Consume and synthesize available subagent_spawn completion messages; use subagent_manage with action "interrupt" or "close" for agents that are no longer needed.',
		'Completion from subagent_spawn is delivered automatically. Do not poll with subagent_inspect or subagent_mailbox action "read", repeatedly check progress, or duplicate the delegated work.',
	];
}
