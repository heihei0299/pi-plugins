import type { AgentRegistry, ManagedAgent } from "./registry.js";
import type { WorkspaceManager } from "./workspace.js";

export async function cleanupPersistedWorkspaces(
	agents: readonly ManagedAgent[],
	workspaceManager: WorkspaceManager,
): Promise<number> {
	const cleanup = (
		workspaceManager as WorkspaceManager & {
			cleanupPersisted?: (ownerId: string, cwd: string) => Promise<void>;
		}
	).cleanupPersisted?.bind(workspaceManager);
	if (!cleanup) return 0;
	const results = await Promise.allSettled(
		agents
			.filter((agent) => agent.workspaceMode === "worktree")
			.map((agent) => cleanup(agent.id, agent.cwd)),
	);
	return results.filter((result) => result.status === "rejected").length;
}

export async function disposeStatefulRuntime(
	registry: AgentRegistry | undefined,
	workspaceManager: WorkspaceManager,
): Promise<unknown[]> {
	const errors: unknown[] = [];
	try {
		await registry?.shutdown();
	} catch (error) {
		errors.push(error);
	}
	try {
		await workspaceManager.cleanupAll();
	} catch (error) {
		errors.push(error);
	}
	return errors;
}

export async function waitForOwnedSpawn<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw ownedSpawnAbortError();
	let abortHandler: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				abortHandler = () => reject(ownedSpawnAbortError());
				signal.addEventListener("abort", abortHandler, { once: true });
				if (signal.aborted) abortHandler();
			}),
		]);
	} finally {
		if (abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}

export function assertCurrentSpawn(
	signal: AbortSignal | undefined,
	generation: number,
	currentGeneration: number,
): void {
	if (!signal?.aborted && generation === currentGeneration) return;
	throw ownedSpawnAbortError();
}

function ownedSpawnAbortError(): Error {
	const error = new Error("Subagent spawn owner was replaced or aborted");
	error.name = "AbortError";
	return error;
}
