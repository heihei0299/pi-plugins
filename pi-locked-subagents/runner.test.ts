import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDir = await mkdtemp(join(tmpdir(), "pi-locked-subagents-test-"));
process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = runDir;

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
  const event = JSON.stringify({ type: "message_update", message: { role: "assistant", content: [] } }) + "\\n";
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
  const event = JSON.stringify({ type: "message_start" }) + "\\n";
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
