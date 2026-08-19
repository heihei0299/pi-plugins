import { createHash } from "node:crypto";

export const ROOT_TASK_PATH = "/root";
export const MAX_TASK_NAME_LENGTH = 128;
export const MAX_TASK_PATH_LENGTH = 2_048;

const TASK_NAME_PATTERN = /^[a-z0-9_]+$/u;

export function validateTaskName(value: string): string {
	if (!value) throw new Error("Subagent taskName must not be empty");
	if (value === "root" || value === "." || value === "..") {
		throw new Error(`Subagent taskName ${JSON.stringify(value)} is reserved`);
	}
	if (value.length > MAX_TASK_NAME_LENGTH) {
		throw new Error(`Subagent taskName cannot exceed ${MAX_TASK_NAME_LENGTH} characters`);
	}
	if (value.includes("/")) throw new Error("Subagent taskName must not contain `/`");
	if (!TASK_NAME_PATTERN.test(value)) {
		throw new Error(
			"Subagent taskName must use only lowercase ASCII letters, digits, and underscores",
		);
	}
	return value;
}

export function validateTaskPath(value: string): string {
	if (!value.startsWith(`${ROOT_TASK_PATH}/`) && value !== ROOT_TASK_PATH) {
		throw new Error("Canonical subagent task paths must start with `/root`");
	}
	if (value.length > MAX_TASK_PATH_LENGTH) {
		throw new Error(
			`Canonical subagent task paths cannot exceed ${MAX_TASK_PATH_LENGTH} characters`,
		);
	}
	if (value.endsWith("/") || value.includes("//")) {
		throw new Error("Canonical subagent task paths must not contain empty segments");
	}
	for (const segment of value.slice(ROOT_TASK_PATH.length + 1).split("/")) {
		if (segment) validateTaskName(segment);
	}
	return value;
}

export function joinTaskPath(parentPath: string, taskName: string): string {
	const parent = validateTaskPath(parentPath);
	const name = validateTaskName(taskName);
	return validateTaskPath(`${parent}/${name}`);
}

export function resolveTaskPath(senderPath: string, reference: string): string {
	if (!reference) throw new Error("Subagent task path reference must not be empty");
	if (reference.startsWith("/")) return validateTaskPath(reference);
	const sender = validateTaskPath(senderPath);
	if (reference.endsWith("/")) {
		throw new Error("Relative subagent task paths must not end with `/`");
	}
	let path = sender;
	for (const segment of reference.split("/")) path = joinTaskPath(path, segment);
	return path;
}

export function deriveTaskName(agentId: string): string {
	const digest = createHash("sha256").update(agentId).digest("hex").slice(0, 32);
	return `agent_${digest}`;
}
