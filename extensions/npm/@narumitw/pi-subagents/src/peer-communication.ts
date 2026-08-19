import { randomBytes, randomUUID } from "node:crypto";
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import { redactPrivateText } from "./context.js";
import { truncateUtf8 } from "./limits.js";
import type { AgentMailboxMessage, AgentRegistry, ManagedAgent } from "./registry.js";
import { ROOT_TASK_PATH } from "./task-path.js";

const MAX_BRIDGE_FRAME_BYTES = 64 * 1024;
const MAX_BRIDGE_CONNECTIONS = 32;
const BRIDGE_HANDSHAKE_TIMEOUT_MS = 2_000;
const MAX_ROOT_MESSAGE_BYTES = 16 * 1024;
const MAX_LISTED_PEERS = 20;

export interface PeerDescriptor {
	id: string;
	taskName: string;
	taskPath: string;
	agent: string;
	state: string;
	self: boolean;
}

export interface PeerRootMessage {
	message: AgentMailboxMessage;
	senderPath: string;
}

export interface PeerBridgeCredentials {
	host: string;
	port: number;
	token: string;
	generation: number;
}

export interface PeerCommunicationBrokerOptions {
	getRegistry(): AgentRegistry;
	sendRoot(message: PeerRootMessage): void | Promise<void>;
	dispatch?(recipient: ManagedAgent, message: AgentMailboxMessage): boolean | Promise<boolean>;
	now?: () => number;
}

interface CredentialRecord extends PeerBridgeCredentials {
	agentId: string;
}

/** Session-owned authenticated routing and process-child JSONL bridge. */
export class PeerCommunicationBroker {
	private server?: Server;
	private starting?: Promise<void>;
	private closed = false;
	private readonly sockets = new Set<Socket>();
	private readonly credentialsByToken = new Map<string, CredentialRecord>();
	private readonly tokenByAgent = new Map<string, string>();
	private readonly dispatchedIds = new Set<string>();
	private readonly rootDeduplication = new Map<string, AgentMailboxMessage>();

	constructor(private readonly options: PeerCommunicationBrokerOptions) {}

	async send(
		senderId: string,
		target: string,
		content: string,
		deduplicationKey?: string,
	): Promise<AgentMailboxMessage> {
		if (this.closed) throw new Error("Subagent peer broker is closed");
		const registry = this.options.getRegistry();
		const sender = registry.resolveAgent(senderId);
		if (!sender) throw new Error(`Unknown subagent: ${senderId}`);
		if (sender.state === "closed")
			throw new Error(`Closed agent ${sender.id} cannot send messages`);
		if (target === ROOT_TASK_PATH) {
			return this.sendToRoot(sender, content, deduplicationKey);
		}
		const message = await registry.sendMessage(target, content, sender.id, deduplicationKey);
		if (this.closed) return message;
		const recipient = registry.get(message.recipientId);
		if (recipient?.state === "running" && !this.dispatchedIds.has(message.id)) {
			this.dispatchedIds.add(message.id);
			try {
				await this.options.dispatch?.(recipient, redactedDeliveryCopy(message));
			} catch {
				// Durable mailbox delivery remains available for the recipient's next turn.
			}
		}
		return message;
	}

	list(senderId: string): PeerDescriptor[] {
		const registry = this.options.getRegistry();
		const sender = registry.resolveAgent(senderId);
		if (!sender) throw new Error(`Unknown subagent: ${senderId}`);
		const root: PeerDescriptor = {
			id: "root",
			taskName: "root",
			taskPath: ROOT_TASK_PATH,
			agent: "root",
			state: "active",
			self: false,
		};
		const retained = registry
			.list()
			.map((agent) => ({
				id: truncateUtf8(agent.id, 256).text,
				taskName: truncateUtf8(agent.taskName ?? "unknown", 128).text,
				taskPath: truncateUtf8(agent.taskPath ?? agent.id, 2_048).text,
				agent: truncateUtf8(agent.agent, 128).text,
				state: agent.state,
				self: agent.id === sender.id,
			}))
			.sort((left, right) => left.taskPath.localeCompare(right.taskPath));
		const selected = retained.slice(0, MAX_LISTED_PEERS - 1);
		if (!selected.some((peer) => peer.id === sender.id)) {
			const senderPeer = retained.find((peer) => peer.id === sender.id);
			if (senderPeer) selected.splice(Math.max(0, selected.length - 1), 1, senderPeer);
		}
		return [root, ...selected].sort((left, right) => left.taskPath.localeCompare(right.taskPath));
	}

	async acknowledge(
		agentId: string,
		messageIds: readonly string[],
		completionIds: readonly string[] = [],
	): Promise<void> {
		if (this.closed) return;
		await this.options
			.getRegistry()
			.acknowledgeVisibleMessages(
				agentId,
				messageIds,
				completionIds,
				(this.options.now ?? Date.now)(),
			);
	}

	async issueCredentials(agentId: string, generation: number): Promise<PeerBridgeCredentials> {
		if (this.closed) throw new Error("Subagent peer broker is closed");
		if (!Number.isSafeInteger(generation) || generation < 1) {
			throw new Error("Subagent peer bridge generation must be a positive safe integer");
		}
		const agent = this.options.getRegistry().resolveAgent(agentId);
		if (!agent || agent.state === "closed") throw new Error(`Unknown subagent: ${agentId}`);
		await this.ensureServer();
		this.revoke(agent.id);
		const address = this.server?.address();
		if (!address || typeof address === "string") {
			throw new Error("Subagent peer bridge did not expose a loopback address");
		}
		const token = randomBytes(32).toString("hex");
		const credentials: CredentialRecord = {
			agentId: agent.id,
			host: "127.0.0.1",
			port: address.port,
			token,
			generation,
		};
		this.credentialsByToken.set(token, credentials);
		this.tokenByAgent.set(agent.id, token);
		return { host: credentials.host, port: credentials.port, token, generation };
	}

	revoke(agentId: string): void {
		const token = this.tokenByAgent.get(agentId);
		if (!token) return;
		this.tokenByAgent.delete(agentId);
		this.credentialsByToken.delete(token);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.credentialsByToken.clear();
		this.tokenByAgent.clear();
		this.rootDeduplication.clear();
		this.dispatchedIds.clear();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async sendToRoot(
		sender: ManagedAgent,
		content: string,
		deduplicationKey?: string,
	): Promise<AgentMailboxMessage> {
		if (!content.trim()) throw new Error("Subagent peer messages cannot be empty");
		if (deduplicationKey && deduplicationKey.length > 256) {
			throw new Error("Subagent peer deduplication keys cannot exceed 256 characters");
		}
		const deduplicationId = deduplicationKey ? `${sender.id}\0${deduplicationKey}` : undefined;
		const duplicate = deduplicationId ? this.rootDeduplication.get(deduplicationId) : undefined;
		if (duplicate) return { ...duplicate };
		const message: AgentMailboxMessage = {
			id: `msg_${randomUUID()}`,
			senderId: sender.id,
			recipientId: "root",
			content: truncateUtf8(content, MAX_ROOT_MESSAGE_BYTES).text,
			createdAt: (this.options.now ?? Date.now)(),
			deduplicationKey,
		};
		await this.options.sendRoot({
			message: redactedDeliveryCopy(message),
			senderPath: sender.taskPath ?? sender.id,
		});
		if (deduplicationId) {
			this.rootDeduplication.set(deduplicationId, message);
			while (this.rootDeduplication.size > 100) {
				const oldest = this.rootDeduplication.keys().next().value;
				if (typeof oldest !== "string") break;
				this.rootDeduplication.delete(oldest);
			}
		}
		return { ...message };
	}

	private async ensureServer(): Promise<void> {
		if (this.server) return;
		if (!this.starting) {
			this.starting = new Promise<void>((resolve, reject) => {
				const server = net.createServer((socket) => this.accept(socket));
				server.maxConnections = MAX_BRIDGE_CONNECTIONS;
				server.once("error", reject);
				server.listen({ host: "127.0.0.1", port: 0 }, () => {
					server.off("error", reject);
					this.server = server;
					resolve();
				});
			}).finally(() => {
				this.starting = undefined;
			});
		}
		await this.starting;
		if (this.closed) {
			const server = this.server as Server | undefined;
			this.server = undefined;
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
			throw new Error("Subagent peer broker closed while starting");
		}
	}

	private accept(socket: Socket): void {
		if (this.closed || this.sockets.size >= MAX_BRIDGE_CONNECTIONS) {
			socket.destroy();
			return;
		}
		this.sockets.add(socket);
		let frame = Buffer.alloc(0);
		let handled = false;
		const timer = setTimeout(() => {
			handled = true;
			this.respond(socket, { ok: false, error: "bridge handshake timed out" });
		}, BRIDGE_HANDSHAKE_TIMEOUT_MS);
		timer.unref();
		const cleanup = () => {
			clearTimeout(timer);
			this.sockets.delete(socket);
		};
		socket.on("data", (chunk: Buffer) => {
			if (handled) return;
			frame = Buffer.concat([frame, chunk]);
			if (frame.byteLength > MAX_BRIDGE_FRAME_BYTES) {
				handled = true;
				clearTimeout(timer);
				this.respond(socket, { ok: false, error: "bridge frame exceeds size limit" });
				return;
			}
			const newline = frame.indexOf(0x0a);
			if (newline < 0) return;
			handled = true;
			clearTimeout(timer);
			void this.handleFrame(frame.subarray(0, newline).toString("utf8")).then((response) =>
				this.respond(socket, response),
			);
		});
		socket.once("close", cleanup);
		socket.once("error", cleanup);
	}

	private async handleFrame(frame: string): Promise<Record<string, unknown>> {
		let request: Record<string, unknown>;
		try {
			const parsed = JSON.parse(frame) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			request = parsed as Record<string, unknown>;
		} catch {
			return { ok: false, error: "malformed bridge request" };
		}
		const credential =
			typeof request.token === "string" ? this.credentialsByToken.get(request.token) : undefined;
		if (!credential) return { ok: false, error: "unauthenticated bridge request" };
		try {
			switch (request.action) {
				case "send": {
					if (typeof request.target !== "string" || typeof request.message !== "string") {
						throw new Error("send requires target and message strings");
					}
					const message = await this.send(
						credential.agentId,
						request.target,
						request.message,
						typeof request.deduplicationKey === "string" ? request.deduplicationKey : undefined,
					);
					return { ok: true, message };
				}
				case "list":
					return { ok: true, peers: this.list(credential.agentId) };
				case "acknowledge": {
					const messageIds = stringArray(request.messageIds);
					const completionIds = stringArray(request.completionIds);
					await this.acknowledge(credential.agentId, messageIds, completionIds);
					return { ok: true };
				}
				default:
					return { ok: false, error: "unsupported bridge action" };
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private respond(socket: Socket, value: Record<string, unknown>): void {
		if (socket.destroyed) return;
		const content = `${JSON.stringify(value)}\n`;
		socket.end(content);
	}
}

function redactedDeliveryCopy(message: AgentMailboxMessage): AgentMailboxMessage {
	return { ...message, content: redactPrivateText(message.content) };
}

function stringArray(value: unknown): string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length > 100 ||
		value.some((item) => typeof item !== "string")
	) {
		throw new Error("acknowledgement IDs must be a bounded string array");
	}
	return value;
}

export function peerBridgeAddress(credentials: PeerBridgeCredentials): string {
	return `${credentials.host}:${credentials.port}`;
}

export function isLoopbackAddress(address: AddressInfo | string | null): address is AddressInfo {
	return Boolean(address && typeof address !== "string" && address.address === "127.0.0.1");
}
