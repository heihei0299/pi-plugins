import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Thinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface AgentConfig {
  /** Locked model. The parent LLM never gets an API parameter that can override this. */
  model: string;
  thinking?: Thinking;

  /** Child built-in/extension tool allowlist. Omit for Pi defaults. */
  tools?: string[];

  /** Complete child system prompt. */
  systemPrompt?: string;

  /**
   * Resource isolation for the CHILD only.
   * noExtensions defaults to false because custom providers may be registered by extensions.
   */
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

const CONFIG_PATH =
  process.env.PI_LOCKED_SUBAGENTS_CONFIG ||
  join(homedir(), ".pi", "agent", "locked-subagents.json");

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete the assigned task independently. " +
  "Read the files you need yourself. Return only the useful result to the parent agent.";

async function loadConfig(): Promise<Config> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Config;

  if (!parsed || typeof parsed !== "object" || !parsed.agents || typeof parsed.agents !== "object") {
    throw new Error(`Invalid config: ${CONFIG_PATH}`);
  }

  for (const [name, agent] of Object.entries(parsed.agents)) {
    if (!name.trim()) throw new Error("Agent name cannot be empty");
    if (!agent || typeof agent !== "object" || !agent.model || typeof agent.model !== "string") {
      throw new Error(`Agent "${name}" must define a locked "model"`);
    }
  }

  return parsed;
}

function childArgs(agent: AgentConfig, task: string): string[] {
  const iso = agent.isolate ?? {};

  // Important: model/thinking are injected ONLY from trusted local config.
  // There is intentionally no caller-controlled "extraArgs" escape hatch.
  const args: string[] = [
    "-p",
    "--no-session",
    "--model",
    agent.model,
  ];

  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

  // These reduce CHILD context, independently of parent-context overhead.
  if (iso.noSkills ?? true) args.push("--no-skills");
  if (iso.noContextFiles ?? true) args.push("--no-context-files");
  if (iso.noPromptTemplates ?? true) args.push("--no-prompt-templates");
  if (iso.noThemes ?? true) args.push("--no-themes");
  if (iso.noApprove ?? true) args.push("--no-approve");

  // Keep extension discovery ON by default so provider shims such as "cpa"
  // continue to exist. If noExtensions=true, explicit -e entries still load.
  if (iso.noExtensions) {
    args.push("--no-extensions");
    for (const ext of iso.extensions ?? []) {
      args.push("-e", ext);
    }
  }

  args.push("--system-prompt", agent.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT);

  // "--" prevents task text beginning with "-" from becoming a CLI option.
  args.push("--", task);
  return args;
}

function runChild(
  binary: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const abort = () => {
      if (child.killed) return;
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    };

    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (err) => {
      signal?.removeEventListener("abort", abort);
      reject(err);
    });

    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr });
    });
  });
}

export default function lockedSubagents(pi: ExtensionAPI) {
  /*
   * PARENT CONTEXT COST:
   * Exactly one LLM-callable tool is registered.
   * Its input schema has exactly TWO fields: agent + task.
   * No model/thinking/tools/session/timeout parameters are exposed to the LLM.
   */
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run a locally configured subagent. Its model and policy are locked by local config and cannot be overridden.",
    parameters: Type.Object(
      {
        agent: Type.String({ description: "Configured subagent name" }),
        task: Type.String({ description: "Self-contained task for the subagent" }),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config: Config;
      try {
        config = await loadConfig();
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Cannot load locked-subagents config at ${CONFIG_PATH}: ` +
                (err instanceof Error ? err.message : String(err)),
            },
          ],
          details: {},
        };
      }

      const agent = config.agents[params.agent];
      if (!agent) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown subagent "${params.agent}". Available: ${Object.keys(config.agents).join(", ")}`,
            },
          ],
          details: {},
        };
      }

      const binary = config.piBinary || process.env.PI_BINARY || "pi";
      const args = childArgs(agent, params.task);

      try {
        const result = await runChild(binary, args, ctx.cwd, signal);

        if (result.code !== 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Subagent "${params.agent}" failed with exit code ${result.code}.\n` +
                  (result.stderr.trim() || result.stdout.trim() || "(no output)"),
              },
            ],
            details: {
              agent: params.agent,
              lockedModel: agent.model,
              thinking: agent.thinking ?? null,
              exitCode: result.code,
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: result.stdout.trim() || "(subagent completed with no stdout)",
            },
          ],
          details: {
            agent: params.agent,
            lockedModel: agent.model,
            thinking: agent.thinking ?? null,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Failed to start subagent "${params.agent}": ` +
                (err instanceof Error ? err.message : String(err)),
            },
          ],
          details: {
            agent: params.agent,
            lockedModel: agent.model,
          },
        };
      }
    },
  });

  // Commands do not add another LLM-callable tool schema.
  pi.registerCommand("subagents", {
    description: "Show locally configured locked subagents",
    handler: async (_args, ctx) => {
      try {
        const config = await loadConfig();
        const lines = Object.entries(config.agents).map(
          ([name, agent]) =>
            `${name} -> ${agent.model}${agent.thinking ? `:${agent.thinking}` : ""}`,
        );
        ctx.ui.notify(lines.join("\n") || "No subagents configured", "info");
      } catch (err) {
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
      }
    },
  });
}
