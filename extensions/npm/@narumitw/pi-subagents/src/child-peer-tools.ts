import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redactPrivateText } from "./context.js";
import { MAX_TOOL_MESSAGE_BYTES, truncateUtf8 } from "./limits.js";
import type { AgentMailboxMessage } from "./registry.js";

const MAX_PEER_MESSAGE_BYTES = 16 * 1024;
const MAX_DEDUPLICATION_KEY_LENGTH = 256;
const PEER_ENVELOPE_HEADER =
	/^Message Type: SUBAGENT_(?:COMPLETION|PEER_MESSAGE)\nProtocol: pi-subagents:v1\nMessage ID: (msg_[^\s]+)\n(?:Completion ID: (completion:[^\s]+)\n)?Sender ID: [^\n]+\n(?:Sender Path: [^\n]+\n)?Payload:\n/u;

export interface ChildPeerClient {
	send(target: string, message: string, deduplicationKey?: string): Promise<AgentMailboxMessage>;
	list(): Promise<unknown>;
	acknowledge(messageIds: readonly string[], completionIds: readonly string[]): Promise<void>;
}

export function createChildPeerExtension(client: ChildPeerClient): ExtensionFactory {
	return (pi) => {
		pi.registerTool(
			defineTool({
				name: "subagent_peer_send",
				label: "Send Peer Message",
				description:
					"Send a bounded queue-only message to /root or another retained agent by canonical task path. The runtime binds your sender identity; this tool never starts an idle turn.",
				promptSnippet: "Send a queue-only message to another retained agent",
				parameters: Type.Object(
					{
						target: Type.String({ minLength: 1, maxLength: 2_048 }),
						message: Type.String({ minLength: 1, maxLength: MAX_PEER_MESSAGE_BYTES }),
						deduplicationKey: Type.Optional(
							Type.String({ minLength: 1, maxLength: MAX_DEDUPLICATION_KEY_LENGTH }),
						),
					},
					{ additionalProperties: false },
				),
				async execute(_id, params) {
					const message = await client.send(params.target, params.message, params.deduplicationKey);
					return {
						content: [
							{
								type: "text" as const,
								text: `Queued ${message.id} for ${message.recipientId}; delivery does not start an idle turn.`,
							},
						],
						details: {
							messageId: message.id,
							recipientId: message.recipientId,
							createdAt: message.createdAt,
						},
					};
				},
			}),
		);
		pi.registerTool(
			defineTool({
				name: "subagent_peer_list",
				label: "List Peers",
				description:
					"List bounded identity and lifecycle metadata for /root and retained agents in this session.",
				promptSnippet: "List retained peer task paths",
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute() {
					const peers = await client.list();
					const text = truncateUtf8(JSON.stringify(peers, null, 2), MAX_TOOL_MESSAGE_BYTES).text;
					return { content: [{ type: "text" as const, text }], details: { peers } };
				},
			}),
		);

		const acknowledgedMessageIds = new Set<string>();
		const acknowledgedCompletionIds = new Set<string>();
		pi.on("context", async (event) => {
			const visible = visibleDeliveryIds(event.messages);
			const messageIds = [...visible.messageIds].filter((id) => !acknowledgedMessageIds.has(id));
			const completionIds = [...visible.completionIds].filter(
				(id) => !acknowledgedCompletionIds.has(id),
			);
			if (messageIds.length === 0 && completionIds.length === 0) return;
			await client.acknowledge(messageIds, completionIds);
			for (const id of messageIds) acknowledgedMessageIds.add(id);
			for (const id of completionIds) acknowledgedCompletionIds.add(id);
		});
	};
}

export function formatPeerMessage(message: AgentMailboxMessage, senderPath?: string): string {
	return truncateUtf8(
		[
			`Message Type: ${message.completionId ? "SUBAGENT_COMPLETION" : "SUBAGENT_PEER_MESSAGE"}`,
			"Protocol: pi-subagents:v1",
			`Message ID: ${message.id}`,
			...(message.completionId ? [`Completion ID: ${message.completionId}`] : []),
			`Sender ID: ${message.senderId}`,
			...(senderPath ? [`Sender Path: ${senderPath}`] : []),
			"Payload:",
			redactPrivateText(message.content),
		].join("\n"),
		MAX_TOOL_MESSAGE_BYTES,
	).text;
}

export function visibleDeliveryIds(messages: readonly unknown[]): {
	messageIds: Set<string>;
	completionIds: Set<string>;
} {
	const messageIds = new Set<string>();
	const completionIds = new Set<string>();
	for (const message of messages) {
		for (const text of messageText(message)) {
			const match = PEER_ENVELOPE_HEADER.exec(text);
			if (!match) continue;
			messageIds.add(match[1]);
			if (match[2]) completionIds.add(match[2]);
		}
	}
	return { messageIds, completionIds };
}

function messageText(message: unknown): string[] {
	if (!message || typeof message !== "object" || Array.isArray(message)) return [];
	const candidate = message as Record<string, unknown>;
	if (candidate.role !== "user") return [];
	const content = candidate.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return [];
		const text = (part as Record<string, unknown>).text;
		return typeof text === "string" ? [text] : [];
	});
}
