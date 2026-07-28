import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGuard, type GuardExtensionOptions } from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────

type EventHandler = (...args: any[]) => any;
type EventHandlers = Record<string, EventHandler>;

function createMockPi(): {
  pi: ExtensionAPI;
  handlers: EventHandlers;
} {
  const handlers: EventHandlers = {};
  const pi = {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers[event] = handler;
    }),
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

/**
 * Create a mock ExtensionContext with the minimal fields needed for tests.
 */
function createMockCtx(overrides?: Record<string, any>): any {
  return {
    hasUI: false,
    ui: { notify: vi.fn() },
    abort: vi.fn(),
    sessionManager: {
      getEntries: vi.fn(() => []),
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("createGuard", () => {
  beforeEach(() => {});

  it("registers event handlers on init", () => {
    const { pi } = createMockPi();
    const guard = createGuard();
    guard(pi);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("agent_settled", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "guard:allow",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers event handlers in correct order", () => {
    const { pi } = createMockPi();
    const guard = createGuard();
    guard(pi);

    const events = (pi.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any[]) => c[0],
    );
    // session_start should be first for state rebuild
    expect(events[0]).toBe("session_start");
  });

  describe("session_start handler", () => {
    it("resets state on startup reason", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const handler = handlers["session_start"];
      const ctx = createMockCtx();

      await handler({ type: "session_start", reason: "startup" }, ctx);

      // The guard was just created, but calling reset() should keep it normal
      // We can verify indirectly by checking the state via tool_call
    });

    it("scans entries on resume to rebuild guarded state", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const ctx = createMockCtx({
        sessionManager: {
          getEntries: vi.fn(() => [
            {
              type: "message",
              role: "user",
              content: "/skill:to-spec",
            },
          ]),
        },
      });

      await handlers["session_start"](
        { type: "session_start", reason: "resume" },
        ctx,
      );

      // Now tool_call should block because state is guarded
      const toolHandler = handlers["tool_call"];
      const result = await toolHandler(
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("🔒"),
      });
    });

    it("does not block on resume without target skills", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const ctx = createMockCtx({
        sessionManager: {
          getEntries: vi.fn(() => [
            { type: "message", role: "user", content: "hello world" },
          ]),
        },
      });

      await handlers["session_start"](
        { type: "session_start", reason: "resume" },
        ctx,
      );

      const toolHandler = handlers["tool_call"];
      const result = await toolHandler(
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });
  });

  describe("input handler", () => {
    it("transitions to skill_active on target skill command", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const inputHandler = handlers["input"];
      await inputHandler(
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );

      // After input, state is skill_active (not blocking yet)
      const toolHandler = handlers["tool_call"];
      const result = await toolHandler(
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("returns continue action", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const result = await handlers["input"](
        { type: "input", text: "hello" },
        createMockCtx(),
      );
      expect(result).toEqual({ action: "continue" });
    });
  });

  describe("agent_settled handler", () => {
    it("transitions to guarded when skill was active", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      // First, activate via input
      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );

      // Then settle
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      // Now tool_call should block
      const toolHandler = handlers["tool_call"];
      const result = await toolHandler(
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("🔒"),
      });
    });

    it("does not transition to guarded if skill was not active", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const toolHandler = handlers["tool_call"];
      const result = await toolHandler(
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });
  });

  describe("tool_call handler", () => {
    it("blocks write in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const ctx = createMockCtx();
      await handlers["session_start"](
        {
          type: "session_start",
          reason: "startup",
        },
        createMockCtx({
          sessionManager: {
            getEntries: vi.fn(() => [
              { role: "user", content: "/skill:to-spec" },
            ]),
          },
        }),
      );

      // Manually set guarded state via the state machine path
      // Instead, use the normal flow: input + agent_settled
      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "write", args: {} },
        ctx,
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("🔒"),
      });
    });

    it("blocks replace in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "replace", args: {} },
        createMockCtx(),
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("🔒"),
      });
    });

    it("blocks bash in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "bash", args: {} },
        createMockCtx(),
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("🔒"),
      });
    });

    it("allows edit tool (not blocked)", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "edit", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("allows read tool in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      // Set up guarded state
      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "read", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("allows grep tool in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "grep", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("allows find tool in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "find", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("allows ls tool in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "ls", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("does not block when not in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const result = await handlers["tool_call"](
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });

    it("calls abort and shows notification in UI mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const ctx = createMockCtx({
        hasUI: true,
        ui: { notify: vi.fn() },
        abort: vi.fn(),
      });

      // Set up guarded state via session_start rebuild
      await handlers["session_start"](
        { type: "session_start", reason: "resume" },
        createMockCtx({
          sessionManager: {
            getEntries: vi.fn(() => [
              { type: "message", role: "user", content: "/skill:to-spec" },
            ]),
          },
        }),
      );

      // The session_start handler above created a new guard instance (separate from our ctx)
      // Let's do it properly: use input + agent_settled flow with our ctx
      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      await handlers["tool_call"]({ toolName: "write", args: {} }, ctx);

      expect(ctx.abort).toHaveBeenCalledTimes(1);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("🔒"),
        "warning",
      );
    });
  });

  describe("/guard:allow command", () => {
    it("registers guard:allow command", () => {
      const { pi } = createMockPi();
      createGuard()(pi);

      expect(pi.registerCommand).toHaveBeenCalledWith(
        "guard:allow",
        expect.objectContaining({
          description: expect.any(String),
          handler: expect.any(Function),
        }),
      );
    });

    it("transitions to normal when in guarded mode", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      // Set up guarded state
      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      // Execute /guard:allow
      const cmd = (pi.registerCommand as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const cmdHandler = cmd[1].handler;
      const ctx = createMockCtx({ ui: { notify: vi.fn() } });
      await cmdHandler({}, ctx);

      // Now tool_call should not block
      const toolHandler = handlers["tool_call"];
      const result = await toolHandler(
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("🔓"),
        "info",
      );
    });

    it("shows not-active info when already in normal state", async () => {
      const { pi, handlers } = createMockPi();
      createGuard()(pi);

      const cmd = (pi.registerCommand as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const cmdHandler = cmd[1].handler;
      const ctx = createMockCtx({ ui: { notify: vi.fn() } });

      await cmdHandler({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("未激活"),
        "info",
      );
    });
  });

  describe("custom target skills", () => {
    it("accepts custom target skills via options", async () => {
      const { pi, handlers } = createMockPi();
      createGuard({ targetSkills: ["my-custom-skill"] })(pi);

      // Use custom skill
      await handlers["input"](
        { type: "input", text: "/skill:my-custom-skill" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      // Should now be blocking
      const result = await handlers["tool_call"](
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("🔒"),
      });
    });

    it("does not trigger guard for non-custom skills", async () => {
      const { pi, handlers } = createMockPi();
      createGuard({ targetSkills: ["my-custom-skill"] })(pi);

      // Default skill should NOT trigger guard
      await handlers["input"](
        { type: "input", text: "/skill:to-spec" },
        createMockCtx(),
      );
      await handlers["agent_settled"](
        { type: "agent_settled" },
        createMockCtx(),
      );

      const result = await handlers["tool_call"](
        { toolName: "write", args: {} },
        createMockCtx(),
      );
      expect(result).toBeUndefined();
    });
  });
});
