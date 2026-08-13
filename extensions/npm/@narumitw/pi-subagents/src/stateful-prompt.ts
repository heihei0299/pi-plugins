import type { AgentConfig } from "./agents/types.js";
import { redactPrivateText } from "./context.js";
import { appendDelegationContract } from "./delegation-contract.js";
import { resolveDefaultSubagentTimeoutMs } from "./execution/runtime-policy.js";
import { DEFAULT_MAX_CONTEXT_BYTES, truncateUtf8 } from "./limits.js";
import type { ManagedAgent } from "./registry.js";
import { appendResultInstruction } from "./result-contract.js";

export function buildStatefulTurnPrompt(
	record: Pick<
		ManagedAgent,
		"context" | "history" | "mailbox" | "currentMailboxMessageIds" | "contract" | "resultFormat"
	>,
	task: string,
	maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
): { text: string; truncated: boolean } {
	const previous = record.history
		.map((turn) => {
			const redactedTask = redactPrivateText(turn.task);
			const redactedOutput = redactPrivateText(turn.output);
			return `Task: ${redactedTask}\nOutput: ${redactedOutput}`;
		})
		.join("\n\n");
	const currentMessageIds = new Set(record.currentMailboxMessageIds ?? []);
	const messages = record.mailbox
		.filter((message) => currentMessageIds.has(message.id))
		.slice(-20)
		.map((message) => `From ${message.senderId}: ${redactPrivateText(message.content)}`)
		.join("\n");
	const context = [
		`Current task:\n${redactPrivateText(task)}`,
		messages ? `Mailbox messages:\n${messages}` : "",
		previous ? `Prior subagent turns:\n${previous}` : "",
		record.context ? `Parent context:\n${redactPrivateText(record.context)}` : "",
	]
		.filter(Boolean)
		.join("\n\n---\n\n");
	const contracted = appendDelegationContract(context, record.contract, maxBytes);
	return truncateUtf8(
		appendResultInstruction(contracted.text, record.resultFormat, maxBytes),
		maxBytes,
	);
}

export function resolveStatefulTurnTimeout(
	agent: Pick<AgentConfig, "timeoutMs"> | undefined,
): number {
	return agent?.timeoutMs ?? resolveDefaultSubagentTimeoutMs();
}
