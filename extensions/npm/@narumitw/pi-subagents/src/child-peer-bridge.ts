import net from "node:net";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ChildPeerClient, createChildPeerExtension } from "./child-peer-tools.js";
import type { AgentMailboxMessage } from "./registry.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;

const captured = captureBridgeEnvironment();

const childPeerBridge: ExtensionFactory = captured
	? createChildPeerExtension(createProcessPeerClient(captured))
	: () => undefined;

export default childPeerBridge;

interface CapturedBridgeEnvironment {
	host: "127.0.0.1";
	port: number;
	token: string;
}

export function captureBridgeEnvironment(): CapturedBridgeEnvironment | undefined {
	const host = process.env.PI_SUBAGENT_PEER_HOST;
	const rawPort = process.env.PI_SUBAGENT_PEER_PORT;
	const token = process.env.PI_SUBAGENT_PEER_TOKEN;
	delete process.env.PI_SUBAGENT_PEER_HOST;
	delete process.env.PI_SUBAGENT_PEER_PORT;
	delete process.env.PI_SUBAGENT_PEER_TOKEN;
	if (!host && !rawPort && !token) return undefined;
	const port = Number(rawPort);
	if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || !token) {
		throw new Error("Invalid pi-subagents peer bridge environment");
	}
	return { host, port, token };
}

function createProcessPeerClient(environment: CapturedBridgeEnvironment): ChildPeerClient {
	const request = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const response = await requestBridge(environment, { ...input, token: environment.token });
		if (response.ok !== true) {
			throw new Error(
				typeof response.error === "string"
					? response.error
					: "Subagent peer bridge rejected the request",
			);
		}
		return response;
	};
	return {
		async send(target, message, deduplicationKey) {
			const response = await request({
				action: "send",
				target,
				message,
				...(deduplicationKey ? { deduplicationKey } : {}),
			});
			if (!isMailboxMessage(response.message)) {
				throw new Error("Subagent peer bridge returned an invalid message receipt");
			}
			return response.message;
		},
		async list() {
			return (await request({ action: "list" })).peers ?? [];
		},
		async acknowledge(messageIds, completionIds) {
			await request({ action: "acknowledge", messageIds, completionIds });
		},
	};
}

function requestBridge(
	environment: CapturedBridgeEnvironment,
	request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: environment.host, port: environment.port });
		let response = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: Error, value?: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value ?? {});
		};
		const timer = setTimeout(
			() => finish(new Error("Subagent peer bridge request timed out")),
			REQUEST_TIMEOUT_MS,
		);
		timer.unref();
		socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: Buffer) => {
			response = Buffer.concat([response, chunk]);
			if (response.byteLength > MAX_RESPONSE_BYTES) {
				finish(new Error("Subagent peer bridge response exceeded its size limit"));
			}
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", () => {
			if (settled) return;
			try {
				const parsed = JSON.parse(response.toString("utf8")) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
				finish(undefined, parsed as Record<string, unknown>);
			} catch {
				finish(new Error("Subagent peer bridge returned malformed JSON"));
			}
		});
	});
}

function isMailboxMessage(value: unknown): value is AgentMailboxMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "string" &&
		typeof message.senderId === "string" &&
		typeof message.recipientId === "string" &&
		typeof message.content === "string" &&
		typeof message.createdAt === "number"
	);
}
