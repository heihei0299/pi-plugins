import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_DIR, type AgentConfig } from "./config.ts";
import { JsonlLineLimitError, JsonlParser } from "./stream-parser.ts";

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
  maxJsonLineBytes: number;
  stderrMaxBytes: number;
  transcriptMaxBytes: number;
  parentOutputMaxBytes: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  timeoutMs: 120_000,
  maxJsonLineBytes: 8 * 1024 * 1024,
  stderrMaxBytes: 256 * 1024,
  transcriptMaxBytes: 8 * 1024 * 1024,
  parentOutputMaxBytes: 24 * 1024,
};

const SENSITIVE_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE)/i;

function redactionValues(env: NodeJS.ProcessEnv, explicitNames: string[]): string[] {
  const names = new Set([
    ...explicitNames,
    ...Object.keys(env).filter((name) => SENSITIVE_ENV_NAME.test(name)),
  ]);
  const rawValues = [...names]
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value !== "");

  const allValues = new Set<string>();
  for (const value of rawValues) {
    allValues.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped) allValues.add(escaped);
  }

  return [...allValues].sort((left, right) => right.length - left.length);
}

function redactText(text: string, values: string[]): string {
  return values.reduce((result, value) => result.split(value).join("[redacted]"), text);
}

function redactValue(value: unknown, redactions: string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactions));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = redactValue(v, redactions);
    }
    return result;
  }
  return value;
}

function maxValueBytes(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, Buffer.byteLength(value, "utf8")), 0);
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  let result = bytes.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

function appendBoundedUtf8(current: string, chunk: string, maxBytes: number): string {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return current;
  return truncateUtf8(current + chunk, maxBytes);
}

function tailUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  let result = bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
  if (result.startsWith("�")) result = result.slice(1);
  return result;
}

function headTailProjection(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const separator = "\n...\n";
  const available = Math.max(0, maxBytes - Buffer.byteLength(separator, "utf8"));
  const headBytes = Math.ceil(available / 2);
  const tailBytes = Math.floor(available / 2);
  return `${truncateUtf8(text, headBytes)}${separator}${tailUtf8(text, tailBytes)}`;
}

function projectOutput(text: string, maxBytes: number, outputPath: string): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  let visibleBytes = maxBytes;
  let projected = "";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const marker = `[output projected: ${originalBytes} bytes → ${visibleBytes} bytes]\nFull output: ${outputPath}\n`;
    projected = truncateUtf8(
      marker + headTailProjection(text, maxBytes - Buffer.byteLength(marker, "utf8")),
      maxBytes,
    );
    const nextVisibleBytes = Buffer.byteLength(projected, "utf8");
    if (nextVisibleBytes === visibleBytes) return projected;
    visibleBytes = nextVisibleBytes;
  }

  return projected;
}

export interface ParentOutputProjection {
  text: string;
  originalBytes: number;
  parentOutputBytes: number;
  outputPath?: string;
  projected: boolean;
}

export async function projectParentOutput(
  text: string,
  maxBytes: number,
): Promise<ParentOutputProjection> {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return {
      text,
      originalBytes,
      parentOutputBytes: originalBytes,
      projected: false,
    };
  }

  const runDir = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR || RUN_DIR;
  const outputPath = join(runDir, `${Date.now()}-${randomUUID()}.txt`);
  await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
  const projected = projectOutput(text, maxBytes, outputPath);
  return {
    text: projected,
    originalBytes,
    parentOutputBytes: Buffer.byteLength(projected, "utf8"),
    outputPath,
    projected: true,
  };
}

export interface RunChildResult {
  code: number | null;
  finalOutput: string;
  stderr: string;
  transcriptPath: string;
  stopReason?: string;
  errorMessage?: string;
  sawValidMessageEnd: boolean;
  protocolError?: string;
  failureReason?: string;
  transcriptTruncated: boolean;
  finalOutputBytes: number;
  parentOutputBytes: number;
  parentOutputMaxBytes: number;
  outputPath?: string;
  projected: boolean;
}

export async function runChild(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  limits: RunLimits = DEFAULT_RUN_LIMITS,
  sensitiveEnvNames: string[] = [],
): Promise<RunChildResult> {
  const runDir = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR || RUN_DIR;
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const transcriptPath = join(runDir, `${Date.now()}-${randomUUID()}.jsonl`);

  return new Promise<RunChildResult>((resolve, reject) => {
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
    let transcriptBytes = 0;
    let transcriptTruncated = false;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let sawValidMessageEnd = false;
    let protocolError: string | undefined;
    let failureReason: string | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const redactions = redactionValues(env, sensitiveEnvNames);
    const stderrCaptureMaxBytes = limits.stderrMaxBytes + maxValueBytes(redactions);

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

    const writeTranscriptLine = (text: string, terminated: boolean) => {
      if (transcriptTruncated) return;
      const lineText = text + (terminated ? "\n" : "");
      const bytes = Buffer.from(lineText);
      const remaining = limits.transcriptMaxBytes - transcriptBytes;
      if (remaining <= 0) {
        transcriptTruncated = true;
        return;
      }
      if (bytes.byteLength > remaining) {
        transcriptTruncated = true;
        return;
      }
      transcript.write(bytes);
      transcriptBytes += bytes.byteLength;
    };

    const parseLine = (line: string, terminated: boolean) => {
      if (!line.trim()) {
        writeTranscriptLine(redactText(line, redactions), terminated);
        return;
      }
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown };
        const redactedEvent = redactValue(event, redactions) as { type?: string; message?: unknown };
        writeTranscriptLine(JSON.stringify(redactedEvent), terminated);

        if (redactedEvent.type === "message_end") {
          const info = assistantMessageInfo(redactedEvent.message);
          if (info) {
            sawValidMessageEnd = true;
            if (info.text !== null) finalOutput = redactText(info.text, redactions);
            if (info.stopReason !== undefined) stopReason = redactText(info.stopReason, redactions);
            if (info.errorMessage !== undefined) errorMessage = redactText(info.errorMessage, redactions);
          }
        }
      } catch {
        protocolError ??= "worker output contained invalid JSON";
        writeTranscriptLine(redactText(line, redactions), terminated);
      }
    };

    const parser = new JsonlParser((line, terminated) => {
      if (settled || failureReason) return;
      parseLine(line, terminated);
    }, limits.maxJsonLineBytes);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || failureReason) return;
      try {
        parser.push(chunk);
      } catch (error) {
        const reason = error instanceof JsonlLineLimitError
          ? error.message
          : `subagent JSONL parser failed: ${error instanceof Error ? error.message : String(error)}`;
        stop(reason);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderr = appendBoundedUtf8(stderr, chunk, stderrCaptureMaxBytes);
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

      if (!failureReason) parser.finish();
      const finalOutputBytes = Buffer.byteLength(finalOutput, "utf8");

      const finish = async () => {
        const parentOutput = await projectParentOutput(finalOutput, limits.parentOutputMaxBytes);
        stderr = truncateUtf8(redactText(stderr, redactions), limits.stderrMaxBytes);
        transcript.end(() => {
          if (settled) return;
          settled = true;
          if (!failureReason && !sawValidMessageEnd) {
            protocolError ??= "worker exited without a valid message_end event";
          }
          resolve({
            code,
            finalOutput: parentOutput.text,
            stderr,
            transcriptPath,
            stopReason,
            errorMessage,
            sawValidMessageEnd,
            protocolError,
            failureReason,
            transcriptTruncated,
            finalOutputBytes,
            parentOutputBytes: parentOutput.parentOutputBytes,
            parentOutputMaxBytes: limits.parentOutputMaxBytes,
            outputPath: parentOutput.outputPath,
            projected: parentOutput.projected,
          });
        });
      };

      void finish().catch((err: unknown) => {
        if (settled) return;
        settled = true;
        transcript.destroy();
        reject(new Error(`Failed to persist subagent output: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }));
      });
    });
  });
}
