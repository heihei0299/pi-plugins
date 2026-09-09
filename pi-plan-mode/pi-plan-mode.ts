/**
 * pi-plan-mode
 * Compact Plan Mode extension based on Pi's official plan-mode example.
 * No LLM-callable tools are registered.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

interface PlanState {
  enabled: boolean;
  executing: boolean;
  todos: TodoItem[];
  toolsBeforePlanMode?: string[];
}

const REQUIRED_PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const DISABLED_PLAN_TOOLS = new Set(["edit", "write"]);

const PLAN_PROMPT = `[PLAN MODE ACTIVE]

You are in planning mode. Explore the codebase and produce an implementation plan, but do not modify files.

Rules:
- Do not edit, write, create, delete, rename, install, commit, or otherwise mutate project/system state.
- Built-in edit/write tools are disabled.
- Bash is restricted to read-only commands.
- Inspect enough surrounding code to understand call paths, data flow, tests, and constraints.
- Identify risks, edge cases, dependencies, and verification steps.

Output a concrete numbered plan under a "Plan:" header.

Plan:
1. First implementation step
2. Second implementation step
3. Verification / tests

Do not implement the plan while Plan Mode is active.`;

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
  if (!command.trim()) return false;
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;

  const segments = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

  return segments.length > 0 && segments.every((segment) => SAFE_PATTERNS.some((p) => p.test(segment)));
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

/** Read BOTH final text and reasoning/thinking blocks. */
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

function cleanStep(text: string): string {
  return text
    .trim()
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse the LAST Plan: section and do not truncate step descriptions. */
function extractPlan(message: string): TodoItem[] {
  const header = /^\s*\*{0,2}Plan:\*{0,2}\s*$/gim;
  const matches = [...message.matchAll(header)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return [];

  const lines = message.slice(last.index + last[0].length).split(/\r?\n/);
  const items: TodoItem[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (items.length > 0 && /^\s*#{1,6}\s+/.test(line)) break;

    const m = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);
    if (!m) continue;

    const step = Number(m[1]);
    const text = cleanStep(m[2]);
    if (Number.isFinite(step) && text) items.push({ step, text, completed: false });
  }

  return items;
}

function doneSteps(message: string): number[] {
  const found = new Set<number>();
  const patterns = [
    /\[\s*DONE\s*:\s*(\d+)\s*\]/gi,
    /\bDONE\s*:\s*(\d+)\b/gi,
    /\bSTEP\s+(\d+)\s+(?:IS\s+)?(?:DONE|COMPLETE|COMPLETED|FINISHED)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const m of message.matchAll(pattern)) {
      const step = Number(m[1]);
      if (!Number.isFinite(step)) continue;
      const prefix = message.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
      if (/\bnot\s*$/i.test(prefix)) continue;
      found.add(step);
    }
  }

  return [...found];
}

function markDone(text: string, items: TodoItem[]): number {
  let changed = 0;
  for (const step of doneSteps(text)) {
    const item = items.find((x) => x.step === step);
    if (item && !item.completed) {
      item.completed = true;
      changed++;
    }
  }
  return changed;
}

function executionPrompt(items: TodoItem[]): string {
  const remaining = items
    .filter((x) => !x.completed)
    .map((x) => `${x.step}. ${x.text}`)
    .join("\n");

  return `[EXECUTING PLAN - FULL TOOL ACCESS]

Remaining steps:
${remaining}

Execute the remaining steps in order.
After completing a step, include [DONE:n] somewhere in your response.
Do not mark a step done until its work and relevant verification are actually complete.`;
}

export default function planMode(pi: ExtensionAPI): void {
  let enabled = false;
  let executing = false;
  let todos: TodoItem[] = [];
  let toolsBeforePlanMode: string[] | undefined;

  pi.registerFlag("plan", {
    description: "Start in Plan Mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  function persist(): void {
    pi.appendEntry("plan-mode", {
      enabled,
      executing,
      todos,
      toolsBeforePlanMode,
    } satisfies PlanState);
  }

  function updateUi(ctx: ExtensionContext): void {
    if (executing && todos.length) {
      const done = todos.filter((x) => x.completed).length;
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `plan ${done}/${todos.length}`));
      ctx.ui.setWidget(
        "plan-todos",
        todos.map((x) =>
          x.completed
            ? `${ctx.ui.theme.fg("success", "✓")} ${ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(x.text))}`
            : `${ctx.ui.theme.fg("muted", "○")} ${x.text}`,
        ),
      );
      return;
    }

    ctx.ui.setWidget("plan-todos", undefined);
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
    executing = false;
    todos = [];
    applyPlanTools();
    persist();
    updateUi(ctx);
    ctx.ui.notify("Plan Mode enabled: edit/write disabled; bash is read-only.", "info");
  }

  function restoreTools(): void {
    if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
    toolsBeforePlanMode = undefined;
  }

  function exit(ctx: ExtensionContext): void {
    enabled = false;
    executing = false;
    todos = [];
    restoreTools();
    persist();
    updateUi(ctx);
    ctx.ui.notify("Plan Mode disabled. Previous tools restored.", "info");
  }

  function beginExecution(ctx: ExtensionContext): void {
    enabled = false;
    executing = true;
    restoreTools();
    persist();
    updateUi(ctx);
  }

  pi.registerCommand("plan", {
    description: "Toggle Plan Mode. Usage: /plan [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") return void (!enabled && enter(ctx));
      if (action === "off") return void ((enabled || executing) && exit(ctx));
      if (action === "status") {
        const done = todos.filter((x) => x.completed).length;
        ctx.ui.notify(executing ? `Plan execution ${done}/${todos.length}` : enabled ? "Plan Mode active" : "Plan Mode inactive", "info");
        return;
      }
      if (enabled || executing) exit(ctx);
      else enter(ctx);
    },
  });

  pi.registerCommand("todos", {
    description: "Show current plan progress",
    handler: async (_args, ctx) => {
      if (!todos.length) return void ctx.ui.notify("No active plan steps.", "info");
      ctx.ui.notify(
        `Plan Progress:\n${todos.map((x) => `${x.step}. ${x.completed ? "✓" : "○"} ${x.text}`).join("\n")}`,
        "info",
      );
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle Plan Mode",
    handler: async (ctx) => (enabled || executing ? exit(ctx) : enter(ctx)),
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

  // Remove stale hidden mode instructions once the corresponding mode is over.
  pi.on("context", async (event) => ({
    messages: event.messages.filter((message) => {
      const m = message as AgentMessage & { customType?: string };
      if (!enabled && m.customType === "plan-mode-context") return false;
      if (!executing && m.customType === "plan-execution-context") return false;
      return true;
    }),
  }));

  // Like Pi's official example: inject hidden instructions only while active.
  pi.on("before_agent_start", async () => {
    if (enabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: PLAN_PROMPT,
          display: false,
        },
      };
    }

    if (executing && todos.length) {
      return {
        message: {
          customType: "plan-execution-context",
          content: executionPrompt(todos),
          display: false,
        },
      };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!executing || !todos.length || !isAssistantMessage(event.message)) return;
    if (markDone(assistantText(event.message), todos) > 0) updateUi(ctx);
    persist();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (executing && todos.length) {
      if (todos.every((x) => x.completed)) {
        const summary = todos.map((x) => `✓ ${x.text}`).join("\n");
        pi.sendMessage(
          { customType: "plan-complete", content: `**Plan Complete**\n\n${summary}`, display: true },
          { triggerTurn: false },
        );
        executing = false;
        todos = [];
        persist();
        updateUi(ctx);
      }
      return;
    }

    if (!enabled || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const parsed = extractPlan(assistantText(lastAssistant));
      if (parsed.length) todos = parsed;
    }
    if (!todos.length) return;

    persist();
    const list = todos.map((x) => `${x.step}. ☐ ${x.text}`).join("\n");
    const choice = await ctx.ui.select("Plan Mode - what next?", [
      "Execute the plan",
      "Stay in Plan Mode",
      "Refine the plan",
      "Exit Plan Mode",
    ]);

    if (choice === "Execute the plan") {
      const first = todos.find((x) => !x.completed);
      if (!first) return;
      beginExecution(ctx);
      pi.sendMessage(
        { customType: "plan-todo-list", content: `**Plan Steps (${todos.length})**\n\n${list}`, display: true },
        { deliverAs: "followUp" },
      );
      pi.sendMessage(
        {
          customType: "plan-mode-execute",
          content: `Execute the plan.\n\n${todos.map((x) => `${x.step}. ${x.text}`).join("\n")}\n\nStart with step ${first.step}. After each completed step include [DONE:n].`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }

    if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(
          { customType: "plan-todo-list", content: `**Current Plan (${todos.length})**\n\n${list}`, display: true },
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

    const entries = ctx.sessionManager.getEntries();
    const state = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
      .at(-1) as { data?: PlanState } | undefined;

    if (state?.data) {
      enabled = state.data.enabled ?? enabled;
      executing = state.data.executing ?? executing;
      todos = state.data.todos ?? todos;
      toolsBeforePlanMode = state.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
    }

    // Rebuild completion state only from messages after the latest execution marker.
    if (state && executing && todos.length) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i] as { customType?: string };
        if (e.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const e = entries[i];
        if (e.type === "message" && "message" in e && isAssistantMessage(e.message as AgentMessage)) {
          messages.push(e.message as AssistantMessage);
        }
      }
      markDone(messages.map(assistantText).join("\n"), todos);
    }

    if (enabled) applyPlanTools();
    else if (executing && toolsBeforePlanMode) restoreTools();

    updateUi(ctx);
  });
}
