import { expect, test } from "bun:test";
import contextAuditExtension from "./index.ts";
import { createContextSnapshot } from "./collector.ts";

type Handler = (event: any, ctx: any) => unknown;

test("context audit observes context and exposes a user command without replacing messages", async () => {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: string[] = [];
  let registeredTool = false;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    registerTool() {
      registeredTool = true;
    },
  };

  contextAuditExtension(pi as any);

  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };
  const result = await handlers.get("context")?.({
    type: "context",
    messages: [
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        timestamp: 3,
      },
      { role: "custom", customType: "audit-note", content: "custom", timestamp: 4 },
    ],
  }, ctx);

  expect(result).toBeUndefined();
  expect(registeredTool).toBe(false);
  expect([...commands.keys()]).toEqual(["context-audit"]);

  await commands.get("context-audit")?.("", ctx);
  expect(notifications[0]).toContain("Context Audit");
  expect(notifications[0]).toContain("Estimated message context:");
  expect(notifications[0]).not.toContain("Estimated input:");
  expect(notifications[0]).toContain("user");
  expect(notifications[0]).toContain("tool");
  expect(notifications[0]).toContain("custom");
});

test("context audit reports deltas, recent snapshots, and reset", async () => {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: string[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  };
  contextAuditExtension(pi as any);

  const ctx = { ui: { notify(message: string) { notifications.push(message); } } };
  await handlers.get("context")?.({ type: "context", messages: [{ role: "user", content: "a", timestamp: 1 }] }, ctx);
  await handlers.get("context")?.({ type: "context", messages: [{ role: "user", content: "abcd", timestamp: 2 }] }, ctx);

  await commands.get("context-audit")?.("recent", ctx);
  expect(notifications.at(-1)).toContain("Recent Context Audits");
  expect(notifications.at(-1)).toContain("Delta:");

  await commands.get("context-audit")?.("reset", ctx);
  expect(notifications.at(-1)).toContain("reset");
  await commands.get("context-audit")?.("", ctx);
  expect(notifications.at(-1)).toContain("No context snapshot");
});

test("context audit records tool sizes without retaining tool output", async () => {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: string[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  };
  contextAuditExtension(pi as any);

  const ctx = { ui: { notify(message: string) { notifications.push(message); } } };
  await handlers.get("context")?.({ type: "context", messages: [{ role: "user", content: "prompt", timestamp: 1 }] }, ctx);
  await handlers.get("tool_call")?.({
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "README.md" },
  }, ctx);
  await handlers.get("tool_result")?.({
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "read",
    input: { path: "README.md" },
    content: [{ type: "text", text: "x".repeat(3000) }],
    isError: false,
  }, ctx);

  await commands.get("context-audit")?.("", ctx);
  expect(notifications[0]).toContain("Recent large tool results");
  expect(notifications[0]).toContain("read");
  expect(notifications[0]).toContain("after #1");
  expect(notifications[0]).not.toContain("snapshot #1");
  expect(notifications[0]).not.toContain("x".repeat(100));
});

test("snapshot does not retain customTypes mapping", () => {
  const snapshot = createContextSnapshot([
    { role: "custom", customType: "my-type", content: "hello" },
  ], 0, undefined);
  expect((snapshot as any).customTypes).toBeUndefined();
  expect(snapshot.custom.chars).toBe(5);
});

