import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MANAGE_ACTIONS = ["interrupt", "close"] as const;
const MAILBOX_ACTIONS = ["send", "read"] as const;
const MAX_MAILBOX_MESSAGE_LENGTH = 16 * 1024;

export const ManageParamsSchema = Type.Object(
	{
		action: StringEnum(MANAGE_ACTIONS, {
			description: "Interrupt active work or close an agent and release its resources.",
		}),
		agentId: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Required agent ID or canonical task path for interrupt and close.",
			}),
		),
		subtree: Type.Optional(
			Type.Boolean({
				default: false,
				description: "Interrupt or close the target and all descendants child-first.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const MailboxParamsSchema = Type.Object(
	{
		action: StringEnum(MAILBOX_ACTIONS, {
			description: "Use send for queue-only delivery or read to inspect unread mailbox messages.",
		}),
		agentId: Type.String({
			minLength: 1,
			description: "Mailbox owner or recipient agent ID or canonical task path.",
		}),
		message: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_MAILBOX_MESSAGE_LENGTH,
				description: "Message content required by send; sending does not start a turn.",
			}),
		),
		senderId: Type.Optional(
			Type.String({ description: "Optional sender agent ID or canonical task path." }),
		),
		deduplicationKey: Type.Optional(
			Type.String({ maxLength: 256, description: "Optional idempotency key for send." }),
		),
		acknowledge: Type.Optional(
			Type.Boolean({ default: true, description: "Mark returned read messages as acknowledged." }),
		),
		limit: Type.Optional(
			Type.Number({ minimum: 1, maximum: 20, default: 20, description: "Maximum messages." }),
		),
	},
	{ additionalProperties: false },
);

export type ValidatedManageParams = {
	action: "interrupt" | "close";
	agentId: string;
	subtree?: boolean;
};

export type ValidatedMailboxParams =
	| {
			action: "send";
			agentId: string;
			message: string;
			senderId?: string;
			deduplicationKey?: string;
	  }
	| { action: "read"; agentId: string; acknowledge?: boolean; limit?: number };

export function validateManageParams(params: unknown): ValidatedManageParams {
	const values = parameterRecord(params, "subagent_manage");
	assertKnownKeys("subagent_manage", values, ["action", "agentId", "subtree"]);
	const action = values.action;
	if (action === "list") {
		throw new Error(
			'subagent_manage no longer supports "list"; use subagent_inspect action "list_runs"',
		);
	}
	if (
		typeof action !== "string" ||
		!MANAGE_ACTIONS.includes(action as (typeof MANAGE_ACTIONS)[number])
	) {
		throw new Error(`subagent_manage action must be one of: ${MANAGE_ACTIONS.join(", ")}`);
	}
	assertRequiredString("subagent_manage", action, values, "agentId");
	assertOptionalBoolean("subagent_manage", action, values, "subtree");
	return {
		action,
		agentId: values.agentId,
		...(values.subtree === undefined ? {} : { subtree: values.subtree }),
	} as ValidatedManageParams;
}

export function validateMailboxParams(params: unknown): ValidatedMailboxParams {
	const values = parameterRecord(params, "subagent_mailbox");
	assertKnownKeys("subagent_mailbox", values, [
		"action",
		"agentId",
		"message",
		"senderId",
		"deduplicationKey",
		"acknowledge",
		"limit",
	]);
	const action = values.action;
	if (
		typeof action !== "string" ||
		!MAILBOX_ACTIONS.includes(action as (typeof MAILBOX_ACTIONS)[number])
	) {
		throw new Error(`subagent_mailbox action must be one of: ${MAILBOX_ACTIONS.join(", ")}`);
	}
	if (action === "send") {
		assertRequiredString("subagent_mailbox", action, values, "agentId");
		assertRequiredString("subagent_mailbox", action, values, "message");
		const message = values.message as string;
		if (message.length > MAX_MAILBOX_MESSAGE_LENGTH) {
			throw new Error(
				`subagent_mailbox action "send" requires message at most ${MAX_MAILBOX_MESSAGE_LENGTH} characters`,
			);
		}
		assertOptionalString("subagent_mailbox", action, values, "senderId");
		assertOptionalString("subagent_mailbox", action, values, "deduplicationKey");
		if (typeof values.deduplicationKey === "string" && values.deduplicationKey.length > 256) {
			throw new Error(
				'subagent_mailbox action "send" requires deduplicationKey at most 256 characters',
			);
		}
		return {
			action,
			agentId: values.agentId,
			message,
			...(values.senderId === undefined ? {} : { senderId: values.senderId }),
			...(values.deduplicationKey === undefined
				? {}
				: { deduplicationKey: values.deduplicationKey }),
		} as ValidatedMailboxParams;
	}
	assertRequiredString("subagent_mailbox", action, values, "agentId");
	assertOptionalBoolean("subagent_mailbox", action, values, "acknowledge");
	if (
		values.limit !== undefined &&
		(typeof values.limit !== "number" ||
			!Number.isFinite(values.limit) ||
			values.limit < 1 ||
			values.limit > 20)
	) {
		throw new Error('subagent_mailbox action "read" requires limit between 1 and 20');
	}
	return {
		action,
		agentId: values.agentId,
		...(values.acknowledge === undefined ? {} : { acknowledge: values.acknowledge }),
		...(values.limit === undefined ? {} : { limit: values.limit }),
	} as ValidatedMailboxParams;
}

function parameterRecord(params: unknown, toolName: string): Record<string, unknown> {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error(`${toolName} parameters must be an object`);
	}
	return params as Record<string, unknown>;
}

function assertKnownKeys(
	toolName: string,
	values: Record<string, unknown>,
	allowed: readonly string[],
): void {
	const unexpected = Object.keys(values).find(
		(key) => values[key] !== undefined && !allowed.includes(key),
	);
	if (unexpected) throw new Error(`${toolName} does not accept ${unexpected}`);
}

function assertRequiredString(
	toolName: string,
	action: string,
	values: Record<string, unknown>,
	key: string,
): void {
	const value = values[key];
	if (value === undefined) throw new Error(`${toolName} action "${action}" requires ${key}`);
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${toolName} action "${action}" requires ${key} to be a non-empty string`);
	}
}

function assertOptionalString(
	toolName: string,
	action: string,
	values: Record<string, unknown>,
	key: string,
): void {
	if (values[key] !== undefined && typeof values[key] !== "string") {
		throw new Error(`${toolName} action "${action}" requires ${key} to be a string`);
	}
}

function assertOptionalBoolean(
	toolName: string,
	action: string,
	values: Record<string, unknown>,
	key: string,
): void {
	if (values[key] !== undefined && typeof values[key] !== "boolean") {
		throw new Error(`${toolName} action "${action}" requires ${key} to be a boolean`);
	}
}
