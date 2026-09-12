import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({
  Key: { ctrlAlt: () => "ctrl-alt-p" },
}));

const { default: planModeExtension } = await import("./index.ts");

type Handler = (...args: any[]) => unknown;

function createPi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerFlag() {},
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools: () => ["read", "write", "edit"],
    setActiveTools() {},
    appendEntry() {},
    sendMessage() {},
    sendUserMessage() {},
    getFlag: () => false,
    command(name: string) {
      return commands.get(name);
    },
    async emit(event: string, ...args: unknown[]) {
      return handlers.get(event)?.(...args);
    },
  };

  return pi;
}

function createContext(select: Handler = async () => "Stay in plan mode") {
  return {
    hasUI: true,
    ui: {
      select: mock(select),
      editor: mock(async () => ""),
      notify: mock(),
      setStatus: mock(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: { getEntries: () => [] },
  };
}

function assistantPlan(text = "Plan:\n1. Inspect the relevant code") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

test("does not show the plan menu for an ordinary message", async () => {
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);
  await pi.emit("input", {
    text: "Explain what this extension does.",
    source: "interactive",
  }, ctx);
  await pi.emit("agent_end", { messages: [assistantPlan()] }, ctx);

  expect(ctx.ui.select).not.toHaveBeenCalled();
});

test("shows the plan menu for an explicit plan request", async () => {
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);
  await pi.emit("input", {
    text: "Create an implementation plan for this extension.",
    source: "interactive",
  }, ctx);
  await pi.emit("agent_end", { messages: [assistantPlan()] }, ctx);

  expect(ctx.ui.select).toHaveBeenCalledTimes(1);
});
