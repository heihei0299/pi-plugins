/**
 * pi-plan-mode
 * Minimal planning-only extension based on Pi's official plan-mode example.
 *
 * Responsibilities stop at: enter read-only planning, produce/refine a plan,
 * then hand the plan back to the main agent. Execution belongs elsewhere.
 * No LLM-callable tools are registered.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

interface PlanState {
  enabled: boolean;
  toolsBeforePlanMode?: string[];
}

const REQUIRED_PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const DISABLED_PLAN_TOOLS = new Set(["edit", "write"]);

const PLAN_PROMPT = `[PLAN MODE ACTIVE]

Explore the codebase and produce an implementation plan. Do not implement it.

Rules:
- Do not edit, write, create, delete, rename, install, commit, or otherwise mutate project/system state.
- Built-in edit/write tools are disabled.
- Bash is restricted to read-only commands.
- Inspect enough surrounding code to understand call paths, data flow, tests, constraints, risks, and verification needs.
- Keep the plan concrete and implementation-ready.

Output the final plan under a "Plan:" header with numbered steps.
Do not execute the plan while Plan Mode is active.`;

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm(dir)?\b/i,
  /\b(mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\$\(/,
  /`[^`]*`/,
  /<\(/,
  />\(/,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|ci|link|publish)\b/i,
  /\bpip3?\s+(install|uninstall)\b/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
  /\b(pacman|yay|paru)\s+-[SRU]/i,
  /\bbrew\s+(install|uninstall|upgrade|update)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean)\b/i,
  /\bgit\s+branch\s+-[dDmM]\b/i,
  /\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
  /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/i,
  /\bservice\s+\S+\s+(start|stop|restart|reload)\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS: RegExp[] = [
  /^\s*(cat|head|tail|less|more|grep|rg|find|fd|ls|eza|tree|pwd|wc|sort|uniq|diff|file|stat|du|df|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|free|jq|bat)\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|rev-parse|describe)\b/i,
  /^\s*git\s+config\s+--get\b/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*pnpm\s+(list|ls|view|why|outdated|audit)\b/i,
  /^\s*yarn\s+(list|info|why|audit)\b/i,
  /^\s*node\s+--version\b/i,
  /^\s*(python|python3)\s+--version\b/i,
  /^\s*(curl|wget)\b/i,
];

function isSafeCommand(command: string): boolean {
  if (!command.trim() || DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
  const segments = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every((segment) => SAFE_PATTERNS.some((p) => p.test(segment)));
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => {
      if (block.type === "text") return [(block as TextContent).text];
      if (block.type === "thinking") return [(block as ThinkingContent).thinking];
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

/** Return the last complete Plan: section without imposing a length limit. */
function extractPlan(message: string): string | null {
  const header = /^\s*\*{0,2}Plan:\*{0,2}\s*$/gim;
  const matches = [...message.matchAll(header)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;

  const body = message.slice(last.index + last[0].length).trim();
  if (!body || !/^\s*\d+[.)]\s+/m.test(body)) return null;
  return `Plan:\n${body}`;
}

export default function planMode(pi: ExtensionAPI): void {
  let enabled = false;
  let toolsBeforePlanMode: string[] | undefined;

  pi.registerFlag("plan", {
    description: "Start in Plan Mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  function persist(): void {
    pi.appendEntry("plan-mode", { enabled, toolsBeforePlanMode } satisfies PlanState);
  }

  function updateUi(ctx: ExtensionContext): void {
    ctx.ui.setStatus("plan-mode", enabled ? ctx.ui.theme.fg("warning", "PLAN") : undefined);
  }

  function applyPlanTools(): void {
    if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
    const active = toolsBeforePlanMode.filter((name) => !DISABLED_PLAN_TOOLS.has(name));
    for (const name of REQUIRED_PLAN_TOOLS) if (!active.includes(name)) active.push(name);
    pi.setActiveTools([...new Set(active)]);
  }

  function enter(ctx: ExtensionContext): void {
    if (!enabled) toolsBeforePlanMode = pi.getActiveTools();
    enabled = true;
    applyPlanTools();
    persist();
    updateUi(ctx);
    ctx.ui.notify("Plan Mode enabled: read-only planning.", "info");
  }

  function restoreTools(): void {
    if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
    toolsBeforePlanMode = undefined;
  }

  function exit(ctx: ExtensionContext): void {
    enabled = false;
    restoreTools();
    persist();
    updateUi(ctx);
    ctx.ui.notify("Plan Mode disabled. Previous tools restored.", "info");
  }

  function handoffPlan(plan: string, ctx: ExtensionContext): void {
    enabled = false;
    restoreTools();
    persist();
    updateUi(ctx);

    // Execution is intentionally not tracked here. The full plan is handed to
    // the normal agent, which can route implementation through skills/subagents.
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
    description: "Toggle Plan Mode. Usage: /plan [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") return void (!enabled && enter(ctx));
      if (action === "off") return void (enabled && exit(ctx));
      if (action === "status") {
        ctx.ui.notify(enabled ? "Plan Mode active" : "Plan Mode inactive", "info");
        return;
      }
      if (enabled) exit(ctx);
      else enter(ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle Plan Mode",
    handler: async (ctx) => (enabled ? exit(ctx) : enter(ctx)),
  });

  pi.on("tool_call", async (event) => {
    if (!enabled || event.toolName !== "bash") return;
    const command = String(event.input.command ?? "");
    if (isSafeCommand(command)) return;
    return {
      block: true,
      reason: `Plan Mode: bash command blocked because it is not read-only.\nCommand: ${command}`,
    };
  });

  // Plan instructions exist in model context only while Plan Mode is active.
  pi.on("context", async (event) => ({
    messages: event.messages.filter((message) => {
      const m = message as AgentMessage & { customType?: string };
      return enabled || m.customType !== "plan-mode-context";
    }),
  }));

  pi.on("before_agent_start", async () => {
    if (!enabled) return;
    return {
      message: {
        customType: "plan-mode-context",
        content: PLAN_PROMPT,
        display: false,
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    const plan = lastAssistant ? extractPlan(assistantText(lastAssistant)) : null;
    if (!plan) return;

    const choice = await ctx.ui.select("Plan Mode - what next?", [
      "Execute the plan",
      "Refine the plan",
      "Stay in Plan Mode",
      "Exit Plan Mode",
    ]);

    if (choice === "Execute the plan") {
      handoffPlan(plan, ctx);
      return;
    }

    if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(
          { customType: "plan-current", content: plan, display: true },
          { deliverAs: "followUp" },
        );
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
      return;
    }

    if (choice === "Exit Plan Mode") exit(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) enabled = true;

    const state = ctx.sessionManager
      .getEntries()
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .at(-1) as { data?: PlanState } | undefined;

    if (state?.data) {
      enabled = state.data.enabled ?? enabled;
      toolsBeforePlanMode = state.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
    }

    if (enabled) applyPlanTools();
    updateUi(ctx);
  });
}
