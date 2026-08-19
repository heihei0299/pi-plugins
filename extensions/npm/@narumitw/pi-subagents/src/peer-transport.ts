import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createChildPeerExtension } from "./child-peer-tools.js";
import type { PeerBridgeCredentials, PeerDescriptor } from "./peer-communication.js";
import type { AgentMailboxMessage } from "./registry.js";

export const CHILD_PEER_TOOL_NAMES = ["subagent_peer_send", "subagent_peer_list"] as const;

export interface PeerTransportRuntime {
	send(
		senderId: string,
		target: string,
		message: string,
		deduplicationKey?: string,
	): Promise<AgentMailboxMessage>;
	list(senderId: string): PeerDescriptor[];
	acknowledge(
		agentId: string,
		messageIds: readonly string[],
		completionIds?: readonly string[],
	): Promise<void>;
	issueCredentials(agentId: string, generation: number): Promise<PeerBridgeCredentials>;
	revoke(agentId: string): void;
}

export function createInProcessPeerExtension(
	runtime: PeerTransportRuntime,
	agentId: string,
): ExtensionFactory {
	return createChildPeerExtension({
		send: (target, message, deduplicationKey) =>
			runtime.send(agentId, target, message, deduplicationKey),
		list: async () => runtime.list(agentId),
		acknowledge: (messageIds, completionIds) =>
			runtime.acknowledge(agentId, messageIds, completionIds),
	});
}

export function childPeerBridgePath(): string {
	return fileURLToPath(new URL("./child-peer-bridge.ts", import.meta.url));
}

export function peerBridgeEnvironment(credentials: PeerBridgeCredentials): NodeJS.ProcessEnv {
	return {
		PI_SUBAGENT_PEER_HOST: credentials.host,
		PI_SUBAGENT_PEER_PORT: String(credentials.port),
		PI_SUBAGENT_PEER_TOKEN: credentials.token,
	};
}
