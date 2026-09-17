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

export interface RunLimits {
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  transcriptMaxBytes: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  timeoutMs: 120_000,
  stdoutMaxBytes: 1_048_576,
  stderrMaxBytes: 262_144,
  transcriptMaxBytes: 1_048_576,
};

const SENSITIVE_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE)/i;

function redactionValues(env: NodeJS.ProcessEnv, explicitNames: string[]): string[] {
  const names = new Set([
    ...explicitNames,
    ...Object.keys(env).filter((name) => SENSITIVE_ENV_NAME.test(name)),
  ]);
  return [...new Set(
    [...names]
      .map((name) => env[name])
      .filter((value): value is string => typeof value === "string" && value !== ""),
  )].sort((left, right) => right.length - left.length);
}

function redactText(text: string, values: string[]): string {
  return values.reduce((result, value) => result.split(value).join("[redacted]"), text);
}

export async function runChild(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  limits: RunLimits = DEFAULT_RUN_LIMITS,
  sensitiveEnvNames: string[] = [],
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
    sawValidMessageEnd: boolean;
    protocolError?: string;
    failureReason?: string;
  }>((resolve, reject) => {
    const transcript = createWriteStream(transcriptPath, { encoding: "utf8", mode: 0o600 });
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let settled = false;
    let finalOutput = "";
    let stderr = "";
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let transcriptSourceBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let sawValidMessageEnd = false;
    let protocolError: string | undefined;
    let failureReason: string | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const redactions = redactionValues(env, sensitiveEnvNames);

    const terminate = (signalName: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {
        try { child.kill(signalName); } catch { /* process already exited */ }
      }
    };

    const stop = (reason: string) => {
      if (settled || failureReason) return;
      failureReason = reason;
      terminate();
      forceKillTimer = setTimeout(() => terminate("SIGKILL"), 250);
    };

    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown };
        if (event.type === "message_end") {
          const info = assistantMessageInfo(event.message);
          if (info) {
            sawValidMessageEnd = true;
            if (info.text !== null) finalOutput = info.text;
            if (info.stopReason !== undefined) stopReason = info.stopReason;
            if (info.errorMessage !== undefined) errorMessage = info.errorMessage;
          }
        }
      } catch {
        protocolError ??= "worker output contained invalid JSON";
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || failureReason) return;
      const bytes = Buffer.from(chunk);
      if (stdoutBytes + bytes.byteLength > limits.stdoutMaxBytes) {
        stop(`subagent stdout exceeded ${limits.stdoutMaxBytes} bytes`);
        return;
      }
      if (transcriptSourceBytes + bytes.byteLength > limits.transcriptMaxBytes) {
        stop(`subagent transcript exceeded ${limits.transcriptMaxBytes} bytes`);
        return;
      }
      stdoutChunks.push(bytes);
      stdoutBytes += bytes.byteLength;
      transcriptSourceBytes += bytes.byteLength;
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled || failureReason) return;
      const bytes = Buffer.from(chunk);
      if (stderrBytes + bytes.byteLength > limits.stderrMaxBytes) {
        stop(`subagent stderr exceeded ${limits.stderrMaxBytes} bytes`);
        return;
      }
      stderrChunks.push(bytes);
      stderrBytes += bytes.byteLength;
    });

    const abort = () => stop("subagent aborted");
    const timeout = setTimeout(
      () => stop(`subagent timed out after ${limits.timeoutMs} ms`),
      limits.timeoutMs,
    );

    transcript.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      terminate();
      transcript.destroy();
      reject(new Error(`Failed to write subagent transcript: ${err.message}`, { cause: err }));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      transcript.end();
      reject(err);
    });
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (!failureReason) {
        for (const line of stdout.split("\n")) parseLine(line);
      }
      const safeTranscript = Buffer.from(redactText(stdout, redactions));
      if (safeTranscript.byteLength > limits.transcriptMaxBytes) {
        failureReason ??= `subagent transcript exceeded ${limits.transcriptMaxBytes} bytes`;
      }
      const transcriptOutput = safeTranscript.subarray(0, limits.transcriptMaxBytes);
      if (transcriptOutput.byteLength > 0) transcript.write(transcriptOutput);

      stderr = redactText(Buffer.concat(stderrChunks).toString("utf8"), redactions);
      if (Buffer.byteLength(stderr, "utf8") > limits.stderrMaxBytes) {
        stderr = Buffer.from(stderr).subarray(0, limits.stderrMaxBytes).toString("utf8");
      }
      finalOutput = redactText(finalOutput, redactions);
      errorMessage = errorMessage === undefined ? undefined : redactText(errorMessage, redactions);
      stopReason = stopReason === undefined ? undefined : redactText(stopReason, redactions);
      transcript.end(() => {
        if (settled) return;
        settled = true;
        if (!failureReason && !sawValidMessageEnd) {
          protocolError ??= "worker exited without a valid message_end event";
        }
        resolve({
          code,
          finalOutput,
          stderr,
          transcriptPath,
          stopReason,
          errorMessage,
          sawValidMessageEnd,
          protocolError,
          failureReason,
        });
      });
    });
  });
}
