import { createHash } from "node:crypto";
import type { AgentScope, SubagentThinkingLevel } from "./agents/types.js";
import type { DelegationContract } from "./delegation-contract.js";
import type { SubagentResultFormat } from "./result-contract.js";

export const MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH = 256;

export interface CanonicalSpawnRequest {
	agent: string;
	task: string;
	cwd: string;
	agentScope: AgentScope;
	thinkingLevel?: SubagentThinkingLevel;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	maxTurns?: number;
	maxToolCalls?: number;
	parentId?: string;
	context?: string;
	contextSourceIds: readonly string[];
	workspaceMode: "shared" | "worktree";
	allowConcurrentWrites: boolean;
	contract?: DelegationContract;
	resultFormat: SubagentResultFormat;
}

export function hashSpawnRequest(request: CanonicalSpawnRequest): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				agent: request.agent,
				task: request.task,
				cwd: request.cwd,
				agentScope: request.agentScope,
				thinkingLevel: request.thinkingLevel ?? null,
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
				...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
				...(request.maxToolCalls === undefined ? {} : { maxToolCalls: request.maxToolCalls }),
				parentId: request.parentId ?? null,
				contextHash: request.context
					? createHash("sha256").update(request.context).digest("hex")
					: null,
				contextSourceIds: [...request.contextSourceIds],
				workspaceMode: request.workspaceMode,
				allowConcurrentWrites: request.allowConcurrentWrites,
				...(request.contract === undefined ? {} : { contract: request.contract }),
				resultFormat: request.resultFormat,
			}),
		)
		.digest("hex");
}

export function assertSpawnIdempotencyKey(value: string | undefined): void {
	if (value === undefined) return;
	if (!value || value.length > MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH) {
		throw new Error(
			`subagent_spawn idempotencyKey must contain 1-${MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH} characters`,
		);
	}
}
