import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("typebox", () => ({
  Type: {
    Array: (items: unknown) => items,
    Object: (properties: unknown) => properties,
    Optional: (schema: unknown) => schema,
    Record: (_k: unknown, v: unknown) => v,
    String: (options: unknown) => options,
    Union: (items: unknown) => items,
  },
}));

const runDir = await mkdtemp(join(tmpdir(), "pi-locked-subagents-test-"));
const configPath = join(runDir, "locked-subagents.json");
process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = runDir;
process.env.PI_LOCKED_SUBAGENTS_CONFIG = configPath;

beforeEach(() => {
  process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = runDir;
  process.env.PI_LOCKED_SUBAGENTS_CONFIG = configPath;
});

const { DEFAULT_RUN_LIMITS, projectParentOutput, runChild } = await import("./runner.ts");

const env = { PATH: process.env.PATH ?? "" };

function runScript(
  script: string,
  limits?: Record<string, number>,
  childEnv: Record<string, string> = env,
  sensitiveEnvNames: string[] = [],
) {
  return runChild(
    process.execPath,
    ["-e", script],
    process.cwd(),
    childEnv,
    undefined,
    { ...DEFAULT_RUN_LIMITS, ...limits },
    sensitiveEnvNames,
  );
}

afterAll(async () => {
  delete process.env.PI_LOCKED_SUBAGENTS_RUN_DIR;
  delete process.env.PI_LOCKED_SUBAGENTS_CONFIG;
  await rm(runDir, { recursive: true, force: true });
});

test("fails the protocol when a worker exits without message_end", async () => {
  const result = await runScript(
    `process.stdout.write(JSON.stringify({type: "message_start"}) + "\\n")`,
  );

  expect(result.code).toBe(0);
  expect(result.sawValidMessageEnd).toBe(false);
  expect(result.protocolError).toContain("message_end");
});

test("fails the protocol when worker output is not valid JSON", async () => {
  const result = await runScript(`process.stdout.write("not json\\n")`);

  expect(result.code).toBe(0);
  expect(result.sawValidMessageEnd).toBe(false);
  expect(result.protocolError).toContain("invalid JSON");
});

test("records malformed JSON before a valid final message", async () => {
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    },
  });
  const result = await runScript(
    `process.stdout.write(${JSON.stringify(`not json\n${event}\n`)})`,
  );

  expect(result.code).toBe(0);
  expect(result.sawValidMessageEnd).toBe(true);
  expect(result.protocolError).toContain("invalid JSON");
});

test("parses multiple JSONL events across arbitrary chunks", async () => {
  const final = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  });
  const output = `${JSON.stringify({ type: "message_start" })}\n${final}`;
  const result = await runScript(
    `const output = ${JSON.stringify(output)}; process.stdout.write(output.slice(0, 5)); setTimeout(() => process.stdout.write(output.slice(5)), 5)`,
  );

  expect(result.sawValidMessageEnd).toBe(true);
  expect(result.finalOutput).toBe("done");
});

test("fails deterministically when one JSONL line exceeds its limit", async () => {
  const result = await runScript(
    `process.stdout.write("x".repeat(100))`,
    { timeoutMs: 1000, maxJsonLineBytes: 64, stderrMaxBytes: 100, transcriptMaxBytes: 100, parentOutputMaxBytes: 100 },
  );

  expect(result.failureReason).toContain("JSONL line exceeded 64 bytes");
});

test("stops a worker that exceeds the execution timeout", async () => {
  const result = await runScript(
    `setInterval(() => {}, 1000)`,
    { timeoutMs: 20, stderrMaxBytes: 100, transcriptMaxBytes: 100, parentOutputMaxBytes: 100 },
  );

  expect(result.failureReason).toContain("timed out");
});

test("streams more than 1 MiB of event traffic before a valid final result", async () => {
  const event = `${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [] } })}\n`;
  const final = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  });
  const result = await runScript(
    `process.stdout.write(${JSON.stringify(event)}.repeat(20000)); process.stdout.write(${JSON.stringify(final)})`,
  );

  expect(result.failureReason).toBeUndefined();
  expect(result.sawValidMessageEnd).toBe(true);
  expect(result.finalOutput).toBe("done");
});

test("bounds stderr without terminating a healthy worker", async () => {
  const event = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  });
  const result = await runScript(
    `process.stderr.write("x".repeat(64)); process.stdout.write(${JSON.stringify(event)})`,
    { timeoutMs: 1000, stderrMaxBytes: 32, transcriptMaxBytes: 100, parentOutputMaxBytes: 100 },
  );

  expect(result.failureReason).toBeUndefined();
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(32);
  expect(result.finalOutput).toBe("done");
});

test("truncates the transcript archive without stopping final-state parsing", async () => {
  const event = `${JSON.stringify({ type: "message_start" })}\n`;
  const final = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  });
  const result = await runScript(
    `process.stdout.write(${JSON.stringify(event)}.repeat(100)); process.stdout.write(${JSON.stringify(final)})`,
    { timeoutMs: 1000, stderrMaxBytes: 100, transcriptMaxBytes: 32, parentOutputMaxBytes: 100 },
  );
  const transcript = await readFile(result.transcriptPath);
  const transcriptText = transcript.toString("utf8");

  expect(result.failureReason).toBeUndefined();
  expect(result.transcriptTruncated).toBe(true);
  expect(transcript.byteLength).toBeLessThanOrEqual(32);
  expect(transcriptText).not.toContain("[object");
  for (const line of transcriptText.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  expect(result.finalOutput).toBe("done");
});

test("keeps transcript truncation line-atomic and valid UTF-8", async () => {
  const first = `${JSON.stringify({ type: "message_start" })}\n`;
  const second = `${JSON.stringify({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "é".repeat(20) }] },
  })}\n`;
  const final = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  });
  const result = await runScript(
    `process.stdout.write(${JSON.stringify(first + second + final)})`,
    { timeoutMs: 1000, maxJsonLineBytes: 1024, stderrMaxBytes: 100, transcriptMaxBytes: Buffer.byteLength(first) + 2, parentOutputMaxBytes: 100 },
  );
  const transcriptText = (await readFile(result.transcriptPath, "utf8"));

  expect(result.failureReason).toBeUndefined();
  expect(result.transcriptTruncated).toBe(true);
  expect(transcriptText).toBe(first);
  expect(transcriptText).not.toContain("�");
  expect(JSON.parse(transcriptText.trim()).type).toBe("message_start");
  expect(result.finalOutput).toBe("done");
});

test("redacts explicitly passed credentials from the transcript", async () => {
  const secret = "super-secret-provider-key";
  const result = await runScript(
    `process.stdout.write(process.env.OPENAI_API_KEY ?? "")`,
    { timeoutMs: 1000, stderrMaxBytes: 100, transcriptMaxBytes: 100, parentOutputMaxBytes: 100 },
    { ...env, OPENAI_API_KEY: secret },
    ["OPENAI_API_KEY"],
  );
  const transcript = await readFile(result.transcriptPath, "utf8");

  expect(transcript).not.toContain(secret);

  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: secret }],
      stopReason: secret,
    },
  });
  const resultWithSecretFields = await runScript(
    `process.stdout.write(${JSON.stringify(event)})`,
    { timeoutMs: 1000, stderrMaxBytes: 100, transcriptMaxBytes: 1000, parentOutputMaxBytes: 1000 },
    { ...env, OPENAI_API_KEY: secret },
    ["OPENAI_API_KEY"],
  );

  expect(resultWithSecretFields.finalOutput).not.toContain(secret);
  expect(resultWithSecretFields.stopReason).not.toContain(secret);
});

test("redacts credentials containing quotes, backslashes, and newlines from transcript, final output, stderr, and projected sidecar", async () => {
  const secret = 'sec"ret\\with\nnewline';
  const escapedSecret = JSON.stringify(secret).slice(1, -1);
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Output containing ${secret}` }],
      stopReason: "stop",
    },
  });
  const result = await runScript(
    `process.stderr.write("Stderr with " + ${JSON.stringify(secret)} + " and escaped " + ${JSON.stringify(escapedSecret)} + "\\n"); process.stdout.write(${JSON.stringify(`${event}\n`)})`,
    { timeoutMs: 1000, stderrMaxBytes: 1000, transcriptMaxBytes: 10000, parentOutputMaxBytes: 1000 },
    { ...env, TEST_CREDENTIAL: secret },
    ["TEST_CREDENTIAL"],
  );
  const transcript = await readFile(result.transcriptPath, "utf8");

  expect(result.finalOutput).not.toContain(secret);
  expect(result.finalOutput).not.toContain(escapedSecret);
  expect(transcript).not.toContain(secret);
  expect(transcript).not.toContain(escapedSecret);
  expect(result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain(escapedSecret);
});

test("redacts credentials appearing as top-level and nested object keys from transcript, final output, stderr, and projected sidecar", async () => {
  const secret = 'sec"ret\\key\nnewline';
  const escapedSecret = JSON.stringify(secret).slice(1, -1);
  const event = JSON.stringify({
    type: "message_end",
    [secret]: "top-level-secret-key-value",
    nested: {
      [secret]: "nested-secret-key-value",
    },
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Output with key ${secret} and ${JSON.stringify({ [secret]: "val" })} ` + "x".repeat(300) }],
      stopReason: "stop",
    },
  });
  const result = await runScript(
    `process.stderr.write("Stderr key: " + ${JSON.stringify(secret)} + " and escaped: " + ${JSON.stringify(escapedSecret)} + "\\n"); process.stdout.write(${JSON.stringify(`${event}\n`)})`,
    { timeoutMs: 1000, stderrMaxBytes: 1000, transcriptMaxBytes: 10000, parentOutputMaxBytes: 100 },
    { ...env, TEST_CREDENTIAL: secret },
    ["TEST_CREDENTIAL"],
  );
  const transcript = await readFile(result.transcriptPath, "utf8");

  expect(result.finalOutput).not.toContain(secret);
  expect(result.finalOutput).not.toContain(escapedSecret);
  expect(transcript).not.toContain(secret);
  expect(transcript).not.toContain(escapedSecret);
  expect(result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain(escapedSecret);

  expect(result.projected).toBe(true);
  expect(result.outputPath).toBeDefined();
  const sidecar = await readFile(result.outputPath!, "utf8");
  expect(sidecar).not.toContain(secret);
  expect(sidecar).not.toContain(escapedSecret);
});

test("redacts secrets before applying the stderr byte boundary", async () => {
  const secret = "boundary-secret-value";
  const prefix = "x".repeat(24);
  const result = await runScript(
    `process.stderr.write(${JSON.stringify(`${prefix}${secret.slice(0, 8)}`)}); setTimeout(() => process.stderr.write(${JSON.stringify(`${secret.slice(8)}-tail`)}), 5)`,
    { timeoutMs: 1000, stderrMaxBytes: 32, transcriptMaxBytes: 100, parentOutputMaxBytes: 100 },
    { ...env, TEST_SECRET: secret },
    ["TEST_SECRET"],
  );

  expect(result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain(secret.slice(0, 8));
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(32);
});

test("projects an already-redacted diagnostic to a bounded parent result", async () => {
  const diagnostic = "diagnostic-secret-value-".repeat(200);
  const projection = await projectParentOutput(diagnostic, 256);

  expect(projection.projected).toBe(true);
  expect(projection.text).toContain("[output projected:");
  expect(projection.outputPath).toBeDefined();
  expect(Buffer.byteLength(projection.text)).toBeLessThanOrEqual(256);
  expect(await readFile(projection.outputPath!, "utf8")).toBe(diagnostic);
});

test("creates the run directory when projecting output directly", async () => {
  const freshRunDir = join(runDir, "direct-output-run");
  await rm(freshRunDir, { recursive: true, force: true });
  const previousRunDir = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR;
  process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = freshRunDir;

  try {
    const projection = await projectParentOutput("x".repeat(300), 64);

    expect(projection.outputPath).toBeDefined();
    expect(await readFile(projection.outputPath!, "utf8")).toBe("x".repeat(300));
  } finally {
    if (previousRunDir === undefined) delete process.env.PI_LOCKED_SUBAGENTS_RUN_DIR;
    else process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = previousRunDir;
  }
});

test("projects oversized final output to the parent and keeps a complete sidecar", async () => {
  const text = "z".repeat(30_000);
  const event = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  });
  const result = await runScript(
    `process.stdout.write(${JSON.stringify(event)})`,
    { timeoutMs: 1000, maxJsonLineBytes: 100_000, stderrMaxBytes: 100, transcriptMaxBytes: 100_000, parentOutputMaxBytes: 256 },
  );

  expect(result.projected).toBe(true);
  expect(result.outputPath).toBeDefined();
  expect(result.finalOutputBytes).toBe(Buffer.byteLength(text));
  expect(result.parentOutputBytes).toBeLessThanOrEqual(256);
  expect(result.finalOutput).toContain("[output projected:");
  expect(result.finalOutput).toContain("Full output:");
  expect(await readFile(result.outputPath!, "utf8")).toBe(text);
});

test("terminates an aborted worker", async () => {
  const controller = new AbortController();
  const promise = runChild(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    env,
    controller.signal,
    { ...DEFAULT_RUN_LIMITS, timeoutMs: 1000 },
  );
  setTimeout(() => controller.abort(), 20);
  const result = await promise;

  expect(result.failureReason).toContain("aborted");
});

test("bounds the actual subagent tool failure result and exposes its diagnostic sidecar", async () => {
  const workerPath = join(runDir, "failure-worker.mjs");
  const errorMessage = "error-diagnostic-".repeat(3000);
  await writeFile(workerPath, `#!/usr/bin/env node\nprocess.stderr.write("s".repeat(300_000)); process.stdout.write(${JSON.stringify(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  }))})`, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({
    piBinary: workerPath,
    agents: { worker: { model: "test/model" } },
  }));

  const { default: lockedSubagents } = await import("./index.ts");
  let registeredTool: any;
  lockedSubagents({
    registerTool(tool: any) { registeredTool = tool; },
    registerCommand() {},
  } as any);

  const result = await registeredTool.execute(
    "call-1",
    { agent: "worker", task: "produce a failure" },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const content = result.content[0].text;
  const diagnosticPath = result.details.diagnosticPath;

  expect(result.isError).toBe(true);
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(DEFAULT_RUN_LIMITS.parentOutputMaxBytes);
  expect(diagnosticPath).toBeTruthy();
  expect(await readFile(diagnosticPath, "utf8")).toBe(errorMessage);
});

test("accepts a valid final message_end", async () => {
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    },
  });
  const result = await runScript(`process.stdout.write(${JSON.stringify(`${event}\n`)})`);

  expect(result.code).toBe(0);
  expect(result.sawValidMessageEnd).toBe(true);
  expect(result.finalOutput).toBe("done");
});
