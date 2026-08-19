import type { ManagedAgent, PersistedAgentCompletion } from "./registry-types.js";
import { ROOT_TASK_PATH } from "./task-path.js";

export type CompletionRecipient = Pick<PersistedAgentCompletion, "recipientId" | "recipientPath">;

export function resolveCompletionRecipient(
	agent: Pick<ManagedAgent, "id" | "parentId">,
	getAgent: (
		id: string,
	) => Pick<ManagedAgent, "id" | "parentId" | "state" | "taskPath"> | undefined,
): CompletionRecipient {
	const visited = new Set([agent.id]);
	let parentId = agent.parentId;
	while (parentId && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = getAgent(parentId);
		if (!parent) break;
		if (parent.state !== "closed") {
			return { recipientId: parent.id, recipientPath: parent.taskPath ?? parent.id };
		}
		parentId = parent.parentId;
	}
	return { recipientId: "root", recipientPath: ROOT_TASK_PATH };
}
