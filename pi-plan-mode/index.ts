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
 * - todo extraction / [DONE:n]
 * - execution state machine
 * - execution progress widget
 *
 * Execution is handed back to the normal agent.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isSafeCommand } from "./utils.ts";

interface PlanState {
  enabled: boolean;
  toolsBeforePlanMode?: string[];
}

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

const PLAN_PROMPT = `[PLAN MODE ACTIVE]
You are in Plan Mode: read-only exploration for implementation planning.

Restrictions:
- Built-in edit and write tools are disabled.
- Other active tools remain available.
- Bash is restricted to an allowlist of read-only commands.
- Do not mutate project or system state.
- Do not execute the implementation.
- Only create a Plan when the user explicitly asks for a plan, outline, steps, implementation approach, or to refine an existing plan.
- For ordinary questions, respond directly without a "Plan:" header.

Explore enough code to understand call paths, data flow, tests, constraints, risks, and verification needs.
Ask clarifying questions with the questionnaire tool when necessary.

When explicitly asked, create an implementation-ready numbered plan under a "Plan:" header:

Plan:
1. First step
2. Second step
...`;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function extractPlan(message: string): string | null {
  const header = /^\s*\*{0,2}Plan:\*{0,2}\s*$/gim;
  const matches = [...message.matchAll(header)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;

  const body = message.slice(last.index + last[0].length).trim();
  if (!body || !/^\s*\d+[.)]\s+/m.test(body)) return null;
  return `Plan:\n${body}`;
}

function uniqueToolNames(names: string[]): string[] {
  return [...new Set(names)];
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let planRequestPending = false;
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

  function getPlanModeTools(activeToolNames: string[]): string[] {
    return uniqueToolNames([
      ...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
      ...PLAN_MODE_TOOLS,
    ]);
  }

  function enablePlanModeTools(): void {
    if (toolsBeforePlanMode === undefined) {
      toolsBeforePlanMode = pi.getActiveTools();
    }
    pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
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
    planRequestPending = false;
    enablePlanModeTools();
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.", "info");
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    planModeEnabled = false;
    planRequestPending = false;
    restoreNormalModeTools();
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    if (planModeEnabled) exitPlanMode(ctx);
    else enterPlanMode(ctx);
  }

  function handoffPlan(plan: string, ctx: ExtensionContext): void {
    planModeEnabled = false;
    planRequestPending = false;
    restoreNormalModeTools();
    updateStatus(ctx);
    persistState();

    pi.sendMessage(
      {
        customType: "plan-handoff",
        content: `${plan}\n\nPlan Mode is finished. Execute this plan using the normal project workflow and active tools.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
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

  pi.on("input", async (event) => {
    if (!planModeEnabled || event.source === "extension") return;

    // ponytail: keyword intent heuristic; add an explicit plan command if natural-language detection becomes unreliable.
    planRequestPending = /\b(plan|outline|steps|approach|refine|revise)\b|计划|规划|方案|步骤|大纲/i.test(event.text);
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

  pi.on("agent_end", async (event, ctx) => {
    if (!planModeEnabled || !ctx.hasUI || !planRequestPending) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    const plan = lastAssistant ? extractPlan(getTextContent(lastAssistant)) : null;
    if (!plan) return;
    planRequestPending = false;

    const choice = await ctx.ui.select("Plan mode - what next?", [
      "Execute the plan",
      "Stay in plan mode",
      "Refine the plan",
      "Exit plan mode",
    ]);

    if (choice === "Execute the plan") {
      handoffPlan(plan, ctx);
      return;
    }

    if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        planRequestPending = true;
        pi.sendMessage(
          { customType: "plan-current", content: plan, display: true },
          { deliverAs: "followUp" },
        );
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
      return;
    }

    if (choice === "Exit plan mode") {
      exitPlanMode(ctx);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();
    const state = entries
      .filter((entry: { type: string; customType?: string }) =>
        entry.type === "custom" && entry.customType === "plan-mode")
      .at(-1) as { data?: PlanState } | undefined;

    if (state?.data) {
      planModeEnabled = state.data.enabled ?? planModeEnabled;
      toolsBeforePlanMode = state.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
    }

    if (planModeEnabled) {
      enablePlanModeTools();
    }
    updateStatus(ctx);
  });
}
