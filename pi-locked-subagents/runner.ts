import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RUN_DIR, type AgentConfig } from "./config.ts";

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete the assigned task independently. " +
  "Read what you need yourself. Return only the useful final result.";

export function childArgs(agent: AgentConfig, task: string, canDelegate: boolean): string[] {
  const iso = agent.isolate ?? {};
  const args = ["-p", "--mode", "json", "--no-session", "--model", agent.model];

  if (agent.thinking) args.push("--thinking", agent.thinking);
  const tools = canDelegate ? agent.tools : agent.tools?.filter((tool) => tool !== "subagent");
  if (tools !== undefined) {
    if (tools.length === 0) args.push("--no-tools");
    else args.push("--tools", tools.join(","));
  }
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

interface AssistantMessageInfo {
  text: string | null;
  stopReason?: string;
  errorMessage?: string;
}

function assistantMessageInfo(message: unknown): AssistantMessageInfo | null {
  if (!message || typeof message !== "object") return null;
  const m = message as {
    role?: string;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return null;

  const text = m.content
    .filter((p): p is { type: string; text: string } =>
      !!p && typeof p === "object" && (p as { type?: string }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");

  return {
    text: text || null,
    stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined,
    errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
  };
}

export async function runChild(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  await mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const transcriptPath = join(RUN_DIR, `${Date.now()}-${randomUUID()}.jsonl`);

  return new Promise<{
    code: number | null;
    finalOutput: string;
    stderr: string;
    transcriptPath: string;
    stopReason?: string;
    errorMessage?: string;
  }>((resolve, reject) => {
    const transcript = createWriteStream(transcriptPath, { encoding: "utf8", mode: 0o600 });
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let settled = false;
    let pending = "";
    let finalOutput = "";
    let stderr = "";
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown };
        if (event.type === "message_end") {
          const info = assistantMessageInfo(event.message);
          if (info) {
            if (info.text !== null) finalOutput = info.text;
            if (info.stopReason !== undefined) stopReason = info.stopReason;
            if (info.errorMessage !== undefined) errorMessage = info.errorMessage;
          }
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

    transcript.once("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      abort();
      transcript.destroy();
      reject(new Error(`Failed to write subagent transcript: ${err.message}`, { cause: err }));
    });
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      transcript.end();
      reject(err);
    });
    child.once("close", (code) => {
      if (settled) return;
      signal?.removeEventListener("abort", abort);
      if (pending.trim()) parseLine(pending);
      transcript.end(() => {
        if (settled) return;
        settled = true;
        resolve({ code, finalOutput, stderr, transcriptPath, stopReason, errorMessage });
      });
    });
  });
}
