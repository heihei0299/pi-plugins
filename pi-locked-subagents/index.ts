import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CONFIG_PATH,
  DEFAULT_MAX_DEPTH,
  childEnvironment,
  currentDepth,
  loadConfig,
  loadConfigSnapshot,
  maxDepth,
} from "./config.ts";
import { agentCatalog, agentNames, compactDescription } from "./registry.ts";
import {
  DEFAULT_RUN_LIMITS,
  childArgs,
  projectParentOutput,
  runChild,
  truncateUtf8,
} from "./runner.ts";

type ReviewPacket = {
  issue: string;
  fixedPoint: string;
  currentHead: string;
  changedFiles: string[];
  requirements: string[];
  checks: string[];
  limitations: string[];
  scope: string;
};

const reviewPacketSchema = Type.Optional(Type.Object({
  issue: Type.String(),
  fixedPoint: Type.String(),
  currentHead: Type.String(),
  changedFiles: Type.Array(Type.String()),
  requirements: Type.Array(Type.String()),
  checks: Type.Array(Type.String()),
  limitations: Type.Array(Type.String()),
  scope: Type.String(),
}, { additionalProperties: false }));

const MAX_REVIEW_PACKET_FILES = 32;
const MAX_REVIEW_PACKET_REQUIREMENTS = 32;
const MAX_REVIEW_TASK_KIB = 32;
const MAX_REVIEW_TASK_BYTES = MAX_REVIEW_TASK_KIB * 1024;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function reviewPacketError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "Reviewer calls require a reviewPacket.";
  const packet = value as Record<string, unknown>;
  for (const field of ["issue", "fixedPoint", "currentHead", "scope"]) {
    if (!nonEmptyString(packet[field])) return `Reviewer reviewPacket.${field} must be a non-empty string.`;
  }
  for (const field of ["changedFiles", "requirements", "checks", "limitations"]) {
    if (!stringList(packet[field])) return `Reviewer reviewPacket.${field} must be an array of non-empty strings.`;
  }
  if ((packet.changedFiles as string[]).length === 0) return "Reviewer reviewPacket.changedFiles must not be empty.";
  if ((packet.requirements as string[]).length === 0) return "Reviewer reviewPacket.requirements must not be empty.";
  if ((packet.changedFiles as string[]).length > MAX_REVIEW_PACKET_FILES) {
    return `Reviewer reviewPacket.changedFiles must contain at most ${MAX_REVIEW_PACKET_FILES} entries.`;
  }
  if ((packet.requirements as string[]).length > MAX_REVIEW_PACKET_REQUIREMENTS) {
    return `Reviewer reviewPacket.requirements must contain at most ${MAX_REVIEW_PACKET_REQUIREMENTS} entries.`;
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function boundedReviewTask(task: string, packet: ReviewPacket): string {
  const list = (values: string[]) => values.length ? values.map((value) => `- ${value}`).join("\n") : "- none reported";
  const diffCommand = [
    `git --literal-pathspecs diff ${shellQuote(packet.fixedPoint)}...${shellQuote(packet.currentHead)} --`,
    ...packet.changedFiles.map(shellQuote),
  ].join(" ");
  return [
    "Review this bounded change only.",
    "Start from the supplied issue and diff boundary:",
    diffCommand,
    "",
    `Issue: ${packet.issue}`,
    "Requirements:",
    list(packet.requirements),
    "",
    "Verification state — checks already performed:",
    list(packet.checks),
    "Known limitations:",
    list(packet.limitations),
    "",
    `Scope: ${packet.scope}`,
    "Do not perform repository-wide discovery.",
    "Read additional files only to prove or disprove a concrete finding.",
    "Do not inline or reproduce the complete diff in the response.",
    "Return a concise VERDICT followed by findings and evidence; do not provide an exploration diary.",
    "",
    "Parent task:",
    task,
  ].join("\n");
}

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
    "Reviewer calls must include a bounded reviewPacket with the issue, fixed/current heads, changed files, requirements, verification state, and scope.",
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
      reviewPacket: reviewPacketSchema,
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config;
      try {
        config = await loadConfig();
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: truncateUtf8(
              `Cannot load ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
              DEFAULT_RUN_LIMITS.parentOutputMaxBytes,
            ),
          }],
          details: {},
        };
      }

      const agent = config.agents[params.agent];
      if (!agent) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: truncateUtf8(
              `Unknown subagent "${params.agent}". Available: ${Object.keys(config.agents).join(", ")}`,
              DEFAULT_RUN_LIMITS.parentOutputMaxBytes,
            ),
          }],
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

      let childTask = params.task;
      if (params.agent === "reviewer") {
        const packetError = reviewPacketError(params.reviewPacket);
        if (packetError) {
          return {
            isError: true,
            content: [{ type: "text", text: packetError }],
            details: {},
          };
        }
        const reviewTask = boundedReviewTask(params.task, params.reviewPacket as ReviewPacket);
        if (Buffer.byteLength(reviewTask, "utf8") > MAX_REVIEW_TASK_BYTES) {
          return {
            isError: true,
            content: [{ type: "text", text: `Reviewer childTask exceeds the ${MAX_REVIEW_TASK_KIB} KiB limit.` }],
            details: {},
          };
        }
        childTask = reviewTask;
      }

      const childDepth = depthNow + 1;
      const allowedAgents = agent.allowedAgents ?? [];
      const canDelegate = params.agent !== "reviewer" && childDepth < limit && allowedAgents.length > 0 && (agent.tools?.includes("subagent") ?? false);
      const childEnv = childEnvironment(agent, process.env, canDelegate, childDepth);

      try {
        const result = await runChild(
          config.piBinary || process.env.PI_BINARY || "pi",
          childArgs(agent, childTask, canDelegate),
          ctx.cwd,
          childEnv,
          signal,
          undefined,
          agent.env ?? [],
        );
        const details = {
          agent: params.agent,
          lockedModel: agent.model,
          thinking: agent.thinking ?? null,
          transcriptPath: result.transcriptPath,
          transcriptTruncated: result.transcriptTruncated,
          finalOutputBytes: result.finalOutputBytes,
          parentOutputBytes: result.parentOutputBytes,
          outputPath: result.outputPath ?? null,
          projected: result.projected,
          diagnosticPath: null as string | null,
          exitCode: result.code,
          stopReason: result.stopReason ?? null,
          failureReason: result.failureReason ?? null,
        };

        const modelFailed =
          result.stopReason === "error" ||
          result.stopReason === "aborted" ||
          Boolean(result.errorMessage?.trim());
        const protocolFailed = !result.sawValidMessageEnd || Boolean(result.protocolError);
        if (result.code !== 0 || modelFailed || protocolFailed) {
          const failure =
            result.failureReason ||
            result.errorMessage?.trim() ||
            result.protocolError ||
            result.stderr.trim() ||
            result.finalOutput ||
            "(no output)";
          const header = `Subagent "${params.agent}" failed (exit=${result.code}, stop=${result.stopReason ?? "unknown"}, reason=${result.failureReason ?? "subagent failure"}).`;
          const suffix = `\n\nTranscript: ${result.transcriptPath}\n\n`;
          const diagnosticBudget = Math.max(
            0,
            result.parentOutputMaxBytes - Buffer.byteLength(header + suffix, "utf8"),
          );
          const diagnostic = await projectParentOutput(failure, diagnosticBudget);
          details.diagnosticPath = diagnostic.outputPath ?? null;
          return {
            isError: true,
            content: [{
              type: "text",
              text: truncateUtf8(
                `${header}${suffix}${diagnostic.text}`,
                result.parentOutputMaxBytes,
              ),
            }],
            details,
          };
        }

        return {
          content: [{ type: "text", text: result.finalOutput || "(subagent completed with no final text)" }],
          details,
        };
      } catch (err) {
        const failure = `Subagent "${params.agent}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
        try {
          const diagnostic = await projectParentOutput(failure, DEFAULT_RUN_LIMITS.parentOutputMaxBytes);
          return {
            isError: true,
            content: [{ type: "text", text: diagnostic.text }],
            details: {
              agent: params.agent,
              lockedModel: agent.model,
              diagnosticPath: diagnostic.outputPath ?? null,
              projected: diagnostic.projected,
            },
          };
        } catch {
          return {
            isError: true,
            content: [{
              type: "text",
              text: truncateUtf8(failure, DEFAULT_RUN_LIMITS.parentOutputMaxBytes),
            }],
            details: { agent: params.agent, lockedModel: agent.model },
          };
        }
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
