import type { IsolatedWorkspace } from "./workspace.js";
import { WorkspaceManager } from "./workspace.js";

export class PanelChildGroup {
	private readonly controller = new AbortController();
	private readonly workspaces = new WorkspaceManager();
	private closingStarted = false;
	private cleanupComplete = false;
	private readonly onParentAbort = () => this.controller.abort(this.parentSignal?.reason);

	constructor(private readonly parentSignal?: AbortSignal) {
		if (parentSignal?.aborted) this.controller.abort(parentSignal.reason);
		else parentSignal?.addEventListener("abort", this.onParentAbort, { once: true });
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	async createWorkspace(ownerId: string, cwd: string): Promise<IsolatedWorkspace> {
		if (this.closingStarted) throw new Error("Panel child group is closing or closed");
		return this.workspaces.create(ownerId, cwd);
	}

	async close(): Promise<void> {
		if (this.cleanupComplete) return;
		if (!this.closingStarted) {
			this.closingStarted = true;
			this.parentSignal?.removeEventListener("abort", this.onParentAbort);
			if (!this.controller.signal.aborted) this.controller.abort("panel-settled");
		}
		await this.workspaces.cleanupAll();
		this.cleanupComplete = true;
	}
}
