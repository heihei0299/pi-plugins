import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ALLOWED_ENV,
  CONFIG_PATH,
  DEFAULT_MAX_DEPTH,
  DEPTH_ENV,
  currentDepth,
  loadConfig,
  loadConfigSnapshot,
  maxDepth,
} from "./config.ts";
import { agentCatalog, agentNames, compactDescription } from "./registry.ts";
import { childArgs, runChild } from "./runner.ts";

export default function lockedSubagents(pi: ExtensionAPI) {
  const startupConfig = loadConfigSnapshot();
  const depth = currentDepth();
  const depthLimit = startupConfig ? maxDepth(startupConfig) : DEFAULT_MAX_DEPTH;
  const startupAgentNames = startupConfig ? agentNames(startupConfig) : [];
  const catalog = startupConfig ? agentCatalog(startupConfig) : "";
  const description = [
    "Delegate a self-contained task to a configured isolated subagent.",
    "Use the matching role directly; do not inspect the filesystem to discover subagents.",
    "Model, thinking, tools, system prompt, and policy are locked locally.",
    catalog ? `Available subagents:\n${catalog}` : "",
  ].filter(Boolean).join("\n\n");

  const delegationAvailable = startupAgentNames.length > 0 && depth < depthLimit;

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
        enum: startupAgentNames,
      }),
      task: Type.String({
        description: "Complete self-contained task with enough context for independent execution.",
      }),
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config;
      try {
        config = await loadConfig();
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot load ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
        };
      }

      const agent = config.agents[params.agent];
      if (!agent) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown subagent "${params.agent}". Available: ${Object.keys(config.agents).join(", ")}` }],
          details: {},
        };
      }

      const depthNow = currentDepth();
      const limit = maxDepth(config);
      if (depthNow >= limit) {
        return {
          isError: true,
          content: [{ type: "text", text: `Subagent depth limit reached (${depthNow}/${limit}).` }],
          details: {},
        };
      }

      const childDepth = depthNow + 1;
      const allowedAgents = agent.allowedAgents ?? [];
      const canDelegate = childDepth < limit && allowedAgents.length > 0 && (agent.tools?.includes("subagent") ?? false);
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        [ALLOWED_ENV]: canDelegate ? allowedAgents.join(",") : "",
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
        const details = {
          agent: params.agent,
          lockedModel: agent.model,
          thinking: agent.thinking ?? null,
          transcriptPath: result.transcriptPath,
          exitCode: result.code,
          stopReason: result.stopReason ?? null,
        };

        const modelFailed = result.stopReason === "error" || result.stopReason === "aborted";
        if (result.code !== 0 || modelFailed) {
          const failure = result.errorMessage?.trim() || result.stderr.trim() || result.finalOutput || "(no output)";
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Subagent "${params.agent}" failed (exit=${result.code}, stop=${result.stopReason ?? "unknown"}).\n${failure}\nTranscript: ${result.transcriptPath}`,
            }],
            details,
          };
        }

        return {
          content: [{ type: "text", text: result.finalOutput || "(subagent completed with no final text)" }],
          details,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Failed to start subagent "${params.agent}": ${err instanceof Error ? err.message : String(err)}`,
          }],
          details: { agent: params.agent, lockedModel: agent.model },
        };
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "Show locally configured locked subagents",
    handler: async (_args, ctx) => {
      try {
        const config = await loadConfig();
        ctx.ui.notify(Object.entries(config.agents).map(([name, agent]) => {
          const purpose = compactDescription(agent.description);
          const delegates = agent.allowedAgents?.length ? ` -> [${agent.allowedAgents.join(", ")}]` : "";
          return `${name}${purpose ? ` — ${purpose}` : ""} -> ${agent.model}${agent.thinking ? `:${agent.thinking}` : ""}${delegates}`;
        }).join("\n") || "No subagents configured", "info");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
