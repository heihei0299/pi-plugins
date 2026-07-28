import { describe, it, expect } from "vitest";
import { extractTextContent, createStateMachine, DEFAULT_TARGET_SKILLS } from "./guard.ts";

// ── Slice 1: helpers + skeleton ───────────────────────────────────────

describe("extractTextContent", () => {
  it("returns a plain string as-is", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("extracts first text from an array of content parts", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractTextContent(content)).toBe("first");
  });

  it("returns undefined for empty array", () => {
    expect(extractTextContent([])).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractTextContent(null)).toBeUndefined();
  });

  it("returns undefined for non-text content", () => {
    const content = [{ type: "image", source: { data: "abc" } }];
    expect(extractTextContent(content)).toBeUndefined();
  });
});

describe("createStateMachine", () => {
  it("starts in normal state and is not blocking", () => {
    const g = createStateMachine();
    expect(g.getState()).toBe("normal");
    expect(g.isBlocking()).toBe(false);
  });

  it("detects target skill commands with isTargetSkill", () => {
    const g = createStateMachine();
    expect(g.isTargetSkill("/skill:to-spec")).toBe(true);
    expect(g.isTargetSkill("/skill:grill-me")).toBe(true);
    expect(g.isTargetSkill("hello world")).toBe(false);
    expect(g.isTargetSkill("/skill:unknown")).toBe(false);
  });

  it("transitions to skill_active on target skill input", () => {
    const g = createStateMachine();
    g.handleInput("/skill:to-spec");
    expect(g.getState()).toBe("skill_active");
  });

  it("stays normal on non-target input", () => {
    const g = createStateMachine();
    g.handleInput("hello world");
    expect(g.getState()).toBe("normal");
  });

  it("transitions from skill_active to guarded on agent_settled", () => {
    const g = createStateMachine();
    g.handleInput("/skill:to-spec");
    expect(g.getState()).toBe("skill_active");
    g.handleAgentSettled();
    expect(g.getState()).toBe("guarded");
    expect(g.isBlocking()).toBe(true);
  });

  it("does nothing on agent_settled from normal state", () => {
    const g = createStateMachine();
    g.handleAgentSettled();
    expect(g.getState()).toBe("normal");
  });

  it("does nothing on agent_settled from guarded state", () => {
    const g = createStateMachine();
    g.handleInput("/skill:to-spec");
    g.handleAgentSettled();
    expect(g.getState()).toBe("guarded");
    g.handleAgentSettled();
    expect(g.getState()).toBe("guarded");
  });

  it("transitions from guarded to skill_active on another target skill", () => {
    const g = createStateMachine();
    g.handleInput("/skill:to-spec");
    g.handleAgentSettled();
    expect(g.getState()).toBe("guarded");
    g.handleInput("/skill:grill-me");
    expect(g.getState()).toBe("skill_active");
  });

  it("handleAllow transitions to normal from any state", () => {
    const g = createStateMachine();
    g.handleInput("/skill:to-spec");
    g.handleAgentSettled();
    expect(g.getState()).toBe("guarded");
    g.handleAllow();
    expect(g.getState()).toBe("normal");
    expect(g.isBlocking()).toBe(false);
  });

  it("reset returns to normal and stops blocking", () => {
    const g = createStateMachine();
    g.handleInput("/skill:to-spec");
    g.handleAgentSettled();
    expect(g.getState()).toBe("guarded");
    g.reset();
    expect(g.getState()).toBe("normal");
    expect(g.isBlocking()).toBe(false);
  });

  // ── Session history rebuild ─────────────────────────────────────────────

  it("rebuildFromHistory sets guarded when user entry contains target skill", () => {
    const g = createStateMachine();
    const entries = [
      { role: "user" as const, content: "/skill:to-spec" },
    ];
    g.rebuildFromHistory(entries);
    expect(g.getState()).toBe("guarded");
  });

  it("rebuildFromHistory stays normal when no target skill found", () => {
    const g = createStateMachine();
    const entries = [
      { role: "user" as const, content: "hello world" },
      { role: "assistant" as const, content: "hi" },
    ];
    g.rebuildFromHistory(entries);
    expect(g.getState()).toBe("normal");
  });

  it("rebuildFromHistory ignores assistant entries", () => {
    const g = createStateMachine();
    const entries = [
      { role: "assistant" as const, content: "/skill:to-spec" },
    ];
    g.rebuildFromHistory(entries);
    expect(g.getState()).toBe("normal");
  });

  it("rebuildFromHistory parses content array parts", () => {
    const g = createStateMachine();
    const entries = [
      {
        role: "user" as const,
        content: [{ type: "text", text: "/skill:grill-me" }],
      },
    ];
    g.rebuildFromHistory(entries);
    expect(g.getState()).toBe("guarded");
  });

  it("rebuildFromHistory handles SessionMessageEntry shape", () => {
    const g = createStateMachine();
    const entries = [
      {
        type: "message",
        id: "123",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: "/skill:to-spec",
        },
      },
    ];
    g.rebuildFromHistory(entries);
    expect(g.getState()).toBe("guarded");
  });

  it("rebuildFromHistory handles SessionMessageEntry with content array", () => {
    const g = createStateMachine();
    const entries = [
      {
        type: "message",
        id: "456",
        parentId: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "/skill:grill-me" }],
        },
      },
    ];
    g.rebuildFromHistory(entries);
    expect(g.getState()).toBe("guarded");
  });

  // ── Custom target skills ────────────────────────────────────────────────

  it("accepts custom target skills", () => {
    const g = createStateMachine({ targetSkills: ["my-skill", "other"] });
    expect(g.isTargetSkill("/skill:my-skill")).toBe(true);
    expect(g.isTargetSkill("/skill:other")).toBe(true);
    expect(g.isTargetSkill("/skill:to-spec")).toBe(false);
  });

  it("DEFAULT_TARGET_SKILLS contains the 5 expected skills", () => {
    expect(DEFAULT_TARGET_SKILLS).toEqual([
      "to-spec",
      "to-tickets",
      "grill-me",
      "grill-with-docs",
      "wayfinder",
    ]);
  });
});
