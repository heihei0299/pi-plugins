const STATUS_KEY = "subagents";
const activeStatuses = new Map<string, string>();

interface StatusContext {
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

export function startSubagentStatus(
	ctx: StatusContext,
	toolCallId: string,
	status: string,
): { update(status: string): void; clear(): void } {
	let cleared = false;
	const update = (nextStatus: string) => {
		if (cleared) return;
		activeStatuses.set(toolCallId, nextStatus);
		publishSubagentStatus(ctx);
	};
	update(status);
	return {
		update,
		clear() {
			if (cleared) return;
			cleared = true;
			activeStatuses.delete(toolCallId);
			publishSubagentStatus(ctx);
		},
	};
}

function publishSubagentStatus(ctx: StatusContext): void {
	const statuses = [...activeStatuses.values()];
	if (statuses.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const suffix = statuses.length > 1 ? ` +${statuses.length - 1}` : "";
	ctx.ui.setStatus(STATUS_KEY, `${statuses[0]}${suffix}`);
}

export function singleStatus(agent: string): string {
	return `${agent}`;
}

export function chainStatus(step: number, total: number, agent?: string): string {
	return `chain ${step}/${total}${agent ? ` ${agent}` : ""}`;
}

export function parallelStatus(done: number, total: number, running: number): string {
	return `parallel ${done}/${total} done${running > 0 ? ` ${running} running` : ""}`;
}

export function fanInStatus(agent: string): string {
	return `fan-in ${agent}`;
}

export function panelReviewStatus(done: number, total: number, running: number): string {
	return `panel review ${done}/${total}${running > 0 ? ` ${running} running` : ""}`;
}

export function panelSynthesisStatus(agent: string): string {
	return `panel synthesis ${agent}`;
}
