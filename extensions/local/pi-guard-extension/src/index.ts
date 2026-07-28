import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createStateMachine,
  DEFAULT_TARGET_SKILLS,
  type GuardMachineOptions,
} from "./guard.ts";

// ── Exports ────────────────────────────────────────────────────────────

export type { GuardState, GuardMachine, GuardMachineOptions } from "./guard.ts";

export interface GuardExtensionOptions {
  /** List of skill names that trigger the guard. */
  targetSkills?: readonly string[];
}

/** Tools that are blocked in guarded mode. */
const BLOCKED_TOOLS = new Set(["write", "replace", "bash"]);

/** Bilingual block message shown when an action is intercepted. */
const BLOCK_REASON = [
  "🔒 技能讨论已完成，禁止擅自操作。",
  "Guard mode: skill conversation completed, unauthorized actions blocked.",
  "请使用 /guard:allow 临时关闭守卫。",
  "Use /guard:allow to temporarily disable guard mode.",
].join("\n");

// ── Extension factory ──────────────────────────────────────────────────

/**
 * Create a guard extension instance with the given options.
 *
 * Usage:
 * ```typescript
 * // With defaults
 * export default createGuard();
 *
 * // With custom target skills
 * export default createGuard({ targetSkills: ["to-tickets", "grill-me"] });
 * ```
 */
export function createGuard(options?: GuardExtensionOptions) {
  const targetSkills = options?.targetSkills ?? DEFAULT_TARGET_SKILLS;

  return function guardExtension(pi: ExtensionAPI): void {
    const guard = createStateMachine({ targetSkills } satisfies GuardMachineOptions);

    // ── Session start: rebuild guard state from history ──────────────
    pi.on("session_start", async (event, ctx) => {
      if (event.reason === "startup") {
        guard.reset();
      }
      // Scan existing entries to rebuild state
      const entries = ctx.sessionManager.getEntries();
      guard.rebuildFromHistory(entries);
    });

    // ── Input detection: target skill commands → skill_active ────────
    pi.on("input", async (event, _ctx) => {
      guard.handleInput(event.text);
      return { action: "continue" };
    });

    // ── Agent settled: skill_active → guarded ────────────────────────
    pi.on("agent_settled", async (_event, _ctx) => {
      guard.handleAgentSettled();
    });

    // ── Tool call interception: block write/edit/bash in guarded mode ──
    pi.on("tool_call", async (event, ctx) => {
      if (!guard.isBlocking()) return undefined;

      // Only block specific tools
      if (!BLOCKED_TOOLS.has(event.toolName)) return undefined;

      // Show notification in UI mode
      if (ctx.hasUI) {
        ctx.ui.notify(BLOCK_REASON, "warning");
      }

      // Abort the agent turn
      ctx.abort();

      return { block: true, reason: BLOCK_REASON };
    });

    // ── /guard:allow command ─────────────────────────────────────────
    pi.registerCommand("guard:allow", {
      description:
        "Temporarily disable guard mode, allowing write/replace/bash operations",
      handler: async (_args, ctx) => {
        if (guard.getState() === "normal") {
          ctx.ui.notify("🔓 守卫当前未激活 / Guard mode is not active", "info");
          return;
        }

        guard.handleAllow();
        ctx.ui.notify(
          "🔓 守卫已关闭，操作已放行 / Guard mode disabled, operations allowed",
          "info",
        );
      },
    });
  };
}

/** Default export: guard extension with default target skills. */
export default createGuard();
