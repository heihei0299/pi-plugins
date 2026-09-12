import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface AgentConfig {
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
  agents: Record<string, AgentConfig>;
}

const CONFIG_PATH = process.env.PI_LOCKED_SUBAGENTS_CONFIG ||
  join(homedir(), ".pi", "agent", "locked-subagents.json");
const RUN_DIR = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR ||
  join(homedir(), ".pi", "agent", "subagent-runs");

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete the assigned task independently. " +
  "Read what you need yourself. Return only the useful final result.";

async function loadConfig(): Promise<Config> {
  const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
  if (!parsed?.agents || typeof parsed.agents !== "object") throw new Error(`Invalid config: ${CONFIG_PATH}`);
  for (const [name, agent] of Object.entries(parsed.agents)) {
    if (!name.trim() || !agent || typeof agent.model !== "string" || !agent.model) {
      throw new Error(`Agent "${name}" must define a locked model`);
    }
  }
  return parsed;
}

function childArgs(agent: AgentConfig, task: string): string[] {
  const iso = agent.isolate ?? {};
  const args = ["-p", "--mode", "json", "--no-session", "--model", agent.model];

  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
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

async function runChild(binary: string, args: string[], cwd: string, signal?: AbortSignal) {
  await mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const transcriptPath = join(RUN_DIR, `${Date.now()}-${randomUUID()}.jsonl`);

  return new Promise<{ code: number | null; finalOutput: string; stderr: string; transcriptPath: string }>((resolve, reject) => {
    const transcript = createWriteStream(transcriptPath, { encoding: "utf8", mode: 0o600 });
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
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
  // Parent context sees one tiny tool schema: subagent(agent, task).
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run a locally configured isolated subagent. Model and policy are locked locally.",
    parameters: Type.Object({
      agent: Type.String({ description: "Configured subagent name" }),
      task: Type.String({ description: "Self-contained task" }),
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

      try {
        const result = await runChild(config.piBinary || process.env.PI_BINARY || "pi", childArgs(agent, params.task), ctx.cwd, signal);
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
        ctx.ui.notify(Object.entries(config.agents).map(([name, a]) => `${name} -> ${a.model}${a.thinking ? `:${a.thinking}` : ""}`).join("\n") || "No subagents configured", "info");
      } catch (err) { ctx.ui.notify(err instanceof Error ? err.message : String(err), "error"); }
    },
  });
}
