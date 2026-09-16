import { afterEach, expect, mock, test } from "bun:test";

let planModeConfig: string | undefined;
let planModeReadError: Error | undefined;

mock.module("node:fs", () => ({
  readFileSync: () => {
    if (planModeReadError !== undefined) throw planModeReadError;
    if (planModeConfig !== undefined) return planModeConfig;
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  },
}));

mock.module("@earendil-works/pi-tui", () => ({
  Key: { ctrlAlt: () => "ctrl-alt-p" },
}));

const { default: planModeExtension } = await import("./index.ts");

type Handler = (...args: any[]) => unknown;

function createPi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  let activeTools = ["read", "write", "edit"];

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerFlag() {},
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
    registerShortcut() {},
    getActiveTools: () => activeTools,
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
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

function createContext(select: Handler = async () => "Stay in plan mode", entries: unknown[] = []) {
  return {
    hasUI: true,
    ui: {
      select: mock(select),
      editor: mock(async () => ""),
      notify: mock(),
      setStatus: mock(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: { getEntries: () => entries },
  };
}

afterEach(() => {
  planModeConfig = undefined;
  planModeReadError = undefined;
});

function assistantPlan(text = "Plan:\n1. Inspect the relevant code") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

test("asks for a professional implementation plan grounded in repository evidence", async () => {
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);
  const result = await pi.emit("before_agent_start", {}, ctx) as any;
  const prompt = result.message.content as string;

  expect(prompt).toMatch(/restate .*goal, scope, and success criteria/i);
  expect(prompt).toMatch(/repository evidence/i);
  expect(prompt).toMatch(/call paths/i);
  expect(prompt).toMatch(/current implementation.*insufficient.*root cause/i);
  expect(prompt).toMatch(/scope and non-goals/i);
  expect(prompt).toMatch(/implementation steps/i);
  expect(prompt).toMatch(/tests and verification/i);
  expect(prompt).toMatch(/compatibility.*migration impact/i);
  expect(prompt).toMatch(/risks/i);
  expect(prompt).toMatch(/acceptance criteria/i);
  expect(prompt).toContain("Do not invent");
});

test("uses the configured tools on every plan-mode entry", async () => {
  planModeConfig = JSON.stringify({ tools: ["grep", "read", "grep"] });
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);
  expect(pi.getActiveTools()).toEqual(["grep", "read"]);

  await pi.command("plan")?.handler("off", ctx);
  planModeConfig = JSON.stringify({ tools: ["read", "bash"] });
  await pi.command("plan")?.handler("on", ctx);
  expect(pi.getActiveTools()).toEqual(["read", "bash"]);
});

test("uses the default tools when the configuration file is missing", async () => {
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await expect(pi.command("plan")?.handler("on", ctx)).resolves.toBeUndefined();
  expect(pi.getActiveTools()).toEqual([
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
  ]);
});

test("uses defaults and warns when the configuration JSON is invalid", async () => {
  planModeConfig = "{";
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await expect(pi.command("plan")?.handler("on", ctx)).resolves.toBeUndefined();
  expect(pi.getActiveTools()).toEqual([
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
  ]);
  expect(ctx.ui.notify.mock.calls).toContainEqual([
    expect.stringContaining("Invalid JSON"),
    "warning",
  ]);
});

test("uses defaults and warns when tools is not a non-empty string list", async () => {
  planModeConfig = JSON.stringify({ tools: [] });
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);

  expect(pi.getActiveTools()).toEqual([
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
  ]);
  expect(ctx.ui.notify.mock.calls).toContainEqual([
    expect.stringContaining("Invalid tools"),
    "warning",
  ]);
});

test("filters disabled tools from the configured plan-mode list", async () => {
  planModeConfig = JSON.stringify({ tools: ["read", "edit", "write", "bash", "edit"] });
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);

  expect(pi.getActiveTools()).toEqual(["read", "bash"]);
  expect(ctx.ui.notify.mock.calls).toContainEqual([
    expect.stringContaining("edit, write"),
    "warning",
  ]);
});

test("uses current configuration after session restore and restores previous tools on exit", async () => {
  planModeConfig = JSON.stringify({ tools: ["grep"] });
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext(async () => "Stay in plan mode", [
    {
      type: "custom",
      customType: "plan-mode",
      data: { enabled: true, toolsBeforePlanMode: ["read", "write"] },
    },
  ]);

  await pi.emit("session_start", {}, ctx);
  expect(pi.getActiveTools()).toEqual(["grep"]);

  await pi.command("plan")?.handler("off", ctx);
  expect(pi.getActiveTools()).toEqual(["read", "write"]);
});

test("uses defaults and warns when the configuration cannot be read", async () => {
  planModeReadError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await expect(pi.command("plan")?.handler("on", ctx)).resolves.toBeUndefined();
  expect(pi.getActiveTools()).toEqual([
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "questionnaire",
  ]);
  expect(ctx.ui.notify.mock.calls).toContainEqual([
    expect.stringContaining("Could not read"),
    "warning",
  ]);
});

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

test("does not start a follow-up workflow after producing a plan", async () => {
  const pi = createPi();
  planModeExtension(pi as any);
  const ctx = createContext();

  await pi.command("plan")?.handler("on", ctx);
  await pi.emit("input", {
    text: "Create an implementation plan for this extension.",
    source: "interactive",
  }, ctx);
  await pi.emit("agent_end", { messages: [assistantPlan()] }, ctx);

  expect(ctx.ui.select).not.toHaveBeenCalled();
});
