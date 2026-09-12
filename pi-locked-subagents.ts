import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface AgentConfig {
  description?: string;
  allowedAgents?: string[];
  model: string;
  thinking?: Thinking;
  tools?: string[];
  systemPrompt?: string;
  isolate?: {
    noExtensions?: boolean;
    extensions?: string[];
    noSkills?: boolean;
    noContextFiles?: boolean;
    noPromptTemplates?: boolean;
    noThemes?: boolean;
    noApprove?: boolean;
  };
}

interface Config {
  piBinary?: string;
  maxDepth?: number;
  agents: Record<string, AgentConfig>;
}

const CONFIG_PATH = process.env.PI_LOCKED_SUBAGENTS_CONFIG ||
  join(homedir(), ".pi", "agent", "locked-subagents.json");
const RUN_DIR = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR ||
  join(homedir(), ".pi", "agent", "subagent-runs");

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete the assigned task independently. " +
  "Read what you need yourself. Return only the useful final result.";

const MAX_ADVERTISED_AGENTS = 16;
const MAX_AGENT_DESCRIPTION_CHARS = 160;
const DEFAULT_MAX_DEPTH = 2;
const ALLOWED_ENV = "PI_LOCKED_SUBAGENT_ALLOWED";
const DEPTH_ENV = "PI_LOCKED_SUBAGENT_DEPTH";

function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) as Config;
  if (!parsed?.agents || typeof parsed.agents !== "object") throw new Error(`Invalid config: ${CONFIG_PATH}`);
  if (parsed.maxDepth !== undefined && (!Number.isInteger(parsed.maxDepth) || parsed.maxDepth < 0)) {
    throw new Error("maxDepth must be a non-negative integer");
  }

  for (const [name, agent] of Object.entries(parsed.agents)) {
    if (!name.trim() || !agent || typeof agent.model !== "string" || !agent.model) {
      throw new Error(`Agent "${name}" must define a locked model`);
    }
    if (agent.description !== undefined && typeof agent.description !== "string") {
      throw new Error(`Agent "${name}" description must be a string`);
    }
    if (agent.allowedAgents !== undefined) {
      if (!Array.isArray(agent.allowedAgents) || agent.allowedAgents.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error(`Agent "${name}" allowedAgents must be an array of agent names`);
      }
      for (const allowed of agent.allowedAgents) {
        if (allowed === name) throw new Error(`Agent "${name}" cannot allow itself`);
        if (!parsed.agents[allowed]) throw new Error(`Agent "${name}" references unknown allowed agent "${allowed}"`);
      }
    }
  }

  const rawAllowlist = process.env[ALLOWED_ENV];
  if (rawAllowlist === undefined) return parsed;

  const allowed = new Set(rawAllowlist.split(",").map((value) => value.trim()).filter(Boolean));
  return {
    ...parsed,
    agents: Object.fromEntries(Object.entries(parsed.agents).filter(([name]) => allowed.has(name))),
  };
}

async function loadConfig(): Promise<Config> {
  return parseConfig(await readFile(CONFIG_PATH, "utf8"));
}

function loadConfigSnapshot(): Config | null {
  try {
    return parseConfig(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function compactDescription(value: string | undefined): string {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const firstSentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  return firstSentence.length <= MAX_AGENT_DESCRIPTION_CHARS
    ? firstSentence
    : `${firstSentence.slice(0, MAX_AGENT_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function agentCatalog(config: Config): string {
  const entries = Object.entries(config.agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ADVERTISED_AGENTS)
    .map(([name, agent]) => {
      const description = compactDescription(agent.description);
      return description ? `- ${name}: ${description}` : `- ${name}`;
    });

  const omitted = Math.max(0, Object.keys(config.agents).length - entries.length);
  if (omitted > 0) entries.push(`- … ${omitted} more configured role(s)`);
  return entries.join("\n");
}

function currentDepth(): number {
  const value = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function maxDepth(config: Config): number {
  return config.maxDepth ?? DEFAULT_MAX_DEPTH;
}

function childArgs(agent: AgentConfig, task: string, canDelegate: boolean): string[] {
  const iso = agent.isolate ?? {};
  const args = ["-p", "--mode", "json", "--no-session", "--model", agent.model];

  if (agent.thinking) args.push("--thinking", agent.thinking);
  const tools = canDelegate ? agent.tools : agent.tools?.filter((tool) => tool !== "subagent");
  if (tools?.length) args.push("--tools", tools.join(","));
  if (iso.noSkills ?? true) args.push("--no-skills");
  if (iso.noContextFiles ?? true) args.push("--no-context-files");
  if (iso.noPromptTemplates ?? true) args.push("--no-prompt-templates");
  if (iso.noThemes ?? true) args.push("--no-themes");
  if (iso.noApprove ?? true) args.push("--no-approve");

  // Extensions remain discoverable by default because CPA/provider shims may live there.
  if (iso.noExtensions) {
    args.push("--no-extensions");
    for (const ext of iso.extensions ?? []) args.push("-e", ext);
  }

  args.push("--system-prompt", agent.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT, "--", task);
  return args;
}

function assistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { role?: string; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return null;
  const text = m.content
    .filter((p): p is { type: string; text: string } =>
      !!p && typeof p === "object" && (p as { type?: string }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
  return text || null;
}

async function runChild(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  await mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const transcriptPath = join(RUN_DIR, `${Date.now()}-${randomUUID()}.jsonl`);

  return new Promise<{ code: number | null; finalOutput: string; stderr: string; transcriptPath: string }>((resolve, reject) => {
    const transcript = createWriteStream(transcriptPath, { encoding: "utf8", mode: 0o600 });
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let pending = "";
    let finalOutput = "";
    let stderr = "";

    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown };
        if (event.type === "message_end") {
          const text = assistantText(event.message);
          if (text !== null) finalOutput = text;
        }
      } catch { /* full raw line is already preserved in transcript */ }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      transcript.write(chunk);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const abort = () => {
      if (child.killed) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { child.kill("SIGTERM"); }
    };
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (err) => {
      signal?.removeEventListener("abort", abort);
      transcript.end();
      reject(err);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (pending.trim()) parseLine(pending);
      transcript.end(() => resolve({ code, finalOutput, stderr, transcriptPath }));
    });
  });
}

export default function lockedSubagents(pi: ExtensionAPI) {
  // Mature subagent plugins advertise only a bounded name + purpose catalog.
  // Full model/thinking/tools/systemPrompt configuration remains local.
  const startupConfig = loadConfigSnapshot();
  const depth = currentDepth();
  const depthLimit = startupConfig ? maxDepth(startupConfig) : DEFAULT_MAX_DEPTH;
  const startupAgentNames = startupConfig
    ? Object.keys(startupConfig.agents).sort((left, right) => left.localeCompare(right))
    : [];
  const catalog = startupConfig ? agentCatalog(startupConfig) : "";
  const description = [
    "Delegate a self-contained task to a configured isolated subagent.",
    "Use the matching role directly; do not inspect the filesystem to discover subagents.",
    "Model, thinking, tools, system prompt, and policy are locked locally.",
    catalog ? `Available subagents:\n${catalog}` : "",
  ].filter(Boolean).join("\n\n");

  // A restricted child with no advertised agents, or a process already at the
  // depth limit, should not expose delegation at all.
  const delegationAvailable = startupAgentNames.length > 0 && depth < depthLimit;

  // Parent context still sees exactly one tool with two arguments. Agent names
  // become an enum when the config is readable at extension load time.
  if (delegationAvailable) pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description,
    promptSnippet: "Delegate independent work to the matching configured subagent.",
    promptGuidelines: [
      "Use subagent for self-contained exploration, review, research, or implementation when a listed role matches; choose the role by its advertised description instead of searching for agent configuration.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Configured subagent role.",
        ...(startupAgentNames.length > 0 ? { enum: startupAgentNames } : {}),
      }),
      task: Type.String({ description: "Complete self-contained task with enough context for independent execution." }),
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config: Config;
      try { config = await loadConfig(); }
      catch (err) {
        return { isError: true, content: [{ type: "text", text: `Cannot load ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
      }

      const agent = config.agents[params.agent];
      if (!agent) {
        return { isError: true, content: [{ type: "text", text: `Unknown subagent "${params.agent}". Available: ${Object.keys(config.agents).join(", ")}` }], details: {} };
      }

      const depthNow = currentDepth();
      const limit = maxDepth(config);
      if (depthNow >= limit) {
        return { isError: true, content: [{ type: "text", text: `Subagent depth limit reached (${depthNow}/${limit}).` }], details: {} };
      }

      const childDepth = depthNow + 1;
      const allowedAgents = agent.allowedAgents ?? [];
      const canDelegate = childDepth < limit && allowedAgents.length > 0 && (agent.tools?.includes("subagent") ?? false);
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        [ALLOWED_ENV]: allowedAgents.join(","),
        [DEPTH_ENV]: String(childDepth),
      };

      try {
        const result = await runChild(
          config.piBinary || process.env.PI_BINARY || "pi",
          childArgs(agent, params.task, canDelegate),
          ctx.cwd,
          childEnv,
          signal,
        );
        const details = { agent: params.agent, lockedModel: agent.model, thinking: agent.thinking ?? null, transcriptPath: result.transcriptPath, exitCode: result.code };

        if (result.code !== 0) {
          return { isError: true, content: [{ type: "text", text: `Subagent "${params.agent}" failed (${result.code}).\n${result.stderr.trim() || result.finalOutput || "(no output)"}\nTranscript: ${result.transcriptPath}` }], details };
        }

        // Only the final assistant answer enters the parent context. The complete
        // child event stream is on disk. This plugin applies no byte/line/token cap
        // to either stream; model/provider/Pi limits still naturally apply.
        return { content: [{ type: "text", text: result.finalOutput || "(subagent completed with no final text)" }], details };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Failed to start subagent "${params.agent}": ${err instanceof Error ? err.message : String(err)}` }], details: { agent: params.agent, lockedModel: agent.model } };
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "Show locally configured locked subagents",
    handler: async (_args, ctx) => {
      try {
        const config = await loadConfig();
        ctx.ui.notify(Object.entries(config.agents).map(([name, a]) => {
          const purpose = compactDescription(a.description);
          const delegates = a.allowedAgents?.length ? ` -> [${a.allowedAgents.join(", ")}]` : "";
          return `${name}${purpose ? ` — ${purpose}` : ""} -> ${a.model}${a.thinking ? `:${a.thinking}` : ""}${delegates}`;
        }).join("\n") || "No subagents configured", "info");
      } catch (err) { ctx.ui.notify(err instanceof Error ? err.message : String(err), "error"); }
    },
  });
}
