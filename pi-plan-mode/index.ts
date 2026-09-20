/**
 * pi-plan-mode
 * Planning-only variant of Pi's official plan-mode extension.
 *
 * Official mechanics retained:
 * - active-tool snapshot + exact restore
 * - read-only plan tool set
 * - bash allowlist guard
 * - hidden plan context only while active
 * - stale plan-context filtering
 * - --plan flag, /plan command, Ctrl+Alt+P
 * - persisted plan-mode state
 *
 * Intentionally omitted:
 * - post-plan execution/refinement workflow
 * - todo extraction / [DONE:n]
 * - execution state machine
 * - execution progress widget
 *
 * Plan output is the end of this extension's responsibility.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isSafeCommand } from "./utils.ts";

interface PlanState {
  enabled: boolean;
  toolsBeforePlanMode?: string[];
}

const PLAN_MODE_CONFIG_PATH = join(homedir(), ".pi", "agent", "plan-mode.json");
const DEFAULT_PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

const PLAN_PROMPT = `[PLAN MODE ACTIVE]
You are in Plan Mode: read-only exploration for professional implementation planning.

Restrictions:
- Only tools in the configured Plan Mode tool list are active.
- Built-in edit and write tools are always disabled.
- Bash is restricted to an allowlist of read-only commands.
- Do not mutate project or system state.
- Do not execute the implementation.
- Only create a Plan when the user explicitly asks for a plan, outline, steps, implementation approach, or to refine an existing plan.
- For ordinary questions, respond directly without a "Plan:" header.

Before planning, restate the user's goal, scope, and success criteria so the plan solves the right problem. Then explore enough of the repository to understand the current implementation, direct callers, call paths, data flow, relevant tests, project instructions, and applicable ADRs.

For a non-trivial task, explain why the current implementation is insufficient and the root cause. Distinguish repository evidence from proposed decisions, assumptions, and open questions. Do not invent files, symbols, APIs, behavior, test results, or constraints. Ask clarifying questions with the questionnaire tool when a missing fact would change the interface, data, security, scope, or acceptance criteria; otherwise record the assumption.

When explicitly asked, create an implementation-ready numbered plan under a "Plan:" header. A professional plan should cover:
- Goal, scope, and success criteria.
- Current state and repository evidence, including relevant paths, symbols, call paths, and affected boundaries.
- Why the current implementation is insufficient and the root cause.
- Proposed design and the decisions or invariants that must remain true.
- Scope and non-goals.
- Ordered implementation steps with their behavior, dependencies, change boundaries, and tests.
- Tests and verification, including the highest useful test seam, commands, and expected observations.
- Compatibility and migration impact when interfaces, state, configuration, or data formats change.
- Risks, edge cases, assumptions, alternatives when material, and unresolved questions.
- Acceptance criteria that describe observable outcomes.

Keep the plan as small as the task allows. Prefer existing abstractions and the smallest correct change over speculative generality. Do not claim that any check passed unless it was actually run.

Plan:
1. First step
2. Second step
...`;

function uniqueToolNames(names: string[]): string[] {
  return [...new Set(names)];
}

function defaultPlanModeTools(): string[] {
  return [...DEFAULT_PLAN_MODE_TOOLS];
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function loadConfiguredPlanModeTools(warn: (message: string) => void): string[] {
  let content: string;
  try {
    content = readFileSync(PLAN_MODE_CONFIG_PATH, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return defaultPlanModeTools();
    warn(`Could not read ${PLAN_MODE_CONFIG_PATH}; using the default Plan Mode tools.`);
    return defaultPlanModeTools();
  }

  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch {
    warn(`Invalid JSON in ${PLAN_MODE_CONFIG_PATH}; using the default Plan Mode tools.`);
    return defaultPlanModeTools();
  }

  const configuredTools =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as { tools?: unknown }).tools
      : undefined;
  if (
    !Array.isArray(configuredTools) ||
    configuredTools.length === 0 ||
    !configuredTools.every(isToolName)
  ) {
    warn(`Invalid tools in ${PLAN_MODE_CONFIG_PATH}; using the default Plan Mode tools.`);
    return defaultPlanModeTools();
  }

  const disabledTools = configuredTools.filter((name) => PLAN_MODE_DISABLED_TOOLS.has(name));
  if (disabledTools.length > 0) {
    warn(`Ignoring disabled Plan Mode tools: ${uniqueToolNames(disabledTools).join(", ")}.`);
  }

  const tools = uniqueToolNames(
    configuredTools.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
  );
  if (tools.length === 0) {
    warn(`No usable tools configured in ${PLAN_MODE_CONFIG_PATH}; using the default Plan Mode tools.`);
    return defaultPlanModeTools();
  }
  return tools;
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let toolsBeforePlanMode: string[] | undefined;

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "plan-mode",
      planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
    );
  }

  function enablePlanModeTools(ctx: ExtensionContext): void {
    if (toolsBeforePlanMode === undefined) {
      toolsBeforePlanMode = pi.getActiveTools();
    }
    pi.setActiveTools(loadConfiguredPlanModeTools((message) => ctx.ui.notify(message, "warning")));
  }

  function restoreNormalModeTools(): void {
    if (toolsBeforePlanMode !== undefined) {
      pi.setActiveTools(toolsBeforePlanMode);
    }
    toolsBeforePlanMode = undefined;
  }

  function persistState(): void {
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      toolsBeforePlanMode,
    } satisfies PlanState);
  }

  function enterPlanMode(ctx: ExtensionContext): void {
    planModeEnabled = true;
    enablePlanModeTools(ctx);
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.", "info");
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    planModeEnabled = false;
    restoreNormalModeTools();
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled) exitPlanMode(ctx);
    else enterPlanMode(ctx);
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode. Usage: /plan [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "on") {
        if (!planModeEnabled) enterPlanMode(ctx);
        return;
      }
      if (action === "off") {
        if (planModeEnabled) exitPlanMode(ctx);
        return;
      }
      if (action === "status") {
        ctx.ui.notify(planModeEnabled ? "Plan mode active" : "Plan mode inactive", "info");
        return;
      }

      togglePlanMode(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `Plan mode: command blocked (not allowlisted). Use /plan off first.\nCommand: ${command}`,
      };
    }
  });

  // Match the official extension's stale-context cleanup so hidden Plan Mode
  // instructions do not survive after the mode has been disabled.
  pi.on("context", async (event) => {
    if (planModeEnabled) return;

    return {
      messages: event.messages.filter((message) => {
        const msg = message as AgentMessage & { customType?: string };
        if (msg.customType === "plan-mode-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (block) => block.type === "text" && (block as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });

  pi.on("before_agent_start", async () => {
    if (!planModeEnabled) return;

    return {
      message: {
        customType: "plan-mode-context",
        content: PLAN_PROMPT,
        display: false,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const state = entries
      .filter((entry: { type: string; customType?: string }) =>
        entry.type === "custom" && entry.customType === "plan-mode")
      .at(-1) as { data?: PlanState } | undefined;

    if (state?.data) {
      planModeEnabled = state.data.enabled ?? planModeEnabled;
      toolsBeforePlanMode = state.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
    }

    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    if (planModeEnabled) {
      enablePlanModeTools(ctx);
    }
    updateStatus(ctx);
  });
}
