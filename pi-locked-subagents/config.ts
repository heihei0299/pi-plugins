import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
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

export interface Config {
  piBinary?: string;
  maxDepth?: number;
  agents: Record<string, AgentConfig>;
}

export const CONFIG_PATH = process.env.PI_LOCKED_SUBAGENTS_CONFIG ||
  join(homedir(), ".pi", "agent", "locked-subagents.json");

export const RUN_DIR = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR ||
  join(homedir(), ".pi", "agent", "subagent-runs");

export const DEFAULT_MAX_DEPTH = 2;
export const ALLOWED_ENV = "PI_LOCKED_SUBAGENT_ALLOWED";
export const DEPTH_ENV = "PI_LOCKED_SUBAGENT_DEPTH";

export function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) as Config;
  if (!parsed?.agents || typeof parsed.agents !== "object") {
    throw new Error(`Invalid config: ${CONFIG_PATH}`);
  }
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

export async function loadConfig(): Promise<Config> {
  return parseConfig(await readFile(CONFIG_PATH, "utf8"));
}

export function loadConfigSnapshot(): Config | null {
  try {
    return parseConfig(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function currentDepth(): number {
  const value = Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function maxDepth(config: Config): number {
  return config.maxDepth ?? DEFAULT_MAX_DEPTH;
}
