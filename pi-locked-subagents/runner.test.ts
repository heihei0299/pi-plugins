import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runDir = await mkdtemp(join(tmpdir(), "pi-locked-subagents-test-"));
process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = runDir;

const { runChild } = await import("./runner.ts");

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
    limits,
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

test("stops a worker that exceeds the execution timeout", async () => {
  const result = await runScript(
    `setInterval(() => {}, 1000)`,
    { timeoutMs: 20, stdoutMaxBytes: 100, stderrMaxBytes: 100, transcriptMaxBytes: 100 },
  );

  expect(result.failureReason).toContain("timed out");
});

test("stops a worker that exceeds the stdout limit", async () => {
  const result = await runScript(
    `process.stdout.write("x".repeat(64))`,
    { timeoutMs: 1000, stdoutMaxBytes: 32, stderrMaxBytes: 100, transcriptMaxBytes: 100 },
  );

  expect(result.failureReason).toContain("stdout exceeded");
});

test("stops a worker that exceeds the stderr limit", async () => {
  const result = await runScript(
    `process.stderr.write("x".repeat(64))`,
    { timeoutMs: 1000, stdoutMaxBytes: 100, stderrMaxBytes: 32, transcriptMaxBytes: 100 },
  );

  expect(result.failureReason).toContain("stderr exceeded");
});

test("stops a worker before the transcript exceeds its limit", async () => {
  const result = await runScript(
    `process.stdout.write("x".repeat(64))`,
    { timeoutMs: 1000, stdoutMaxBytes: 100, stderrMaxBytes: 100, transcriptMaxBytes: 32 },
  );
  const transcript = await readFile(result.transcriptPath);

  expect(result.failureReason).toContain("transcript exceeded");
  expect(transcript.byteLength).toBeLessThanOrEqual(32);
});

test("redacts explicitly passed credentials from the transcript", async () => {
  const secret = "super-secret-provider-key";
  const result = await runScript(
    `process.stdout.write(process.env.OPENAI_API_KEY ?? "")`,
    { timeoutMs: 1000, stdoutMaxBytes: 100, stderrMaxBytes: 100, transcriptMaxBytes: 100 },
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
    { timeoutMs: 1000, stdoutMaxBytes: 1000, stderrMaxBytes: 100, transcriptMaxBytes: 1000 },
    { ...env, OPENAI_API_KEY: secret },
    ["OPENAI_API_KEY"],
  );

  expect(resultWithSecretFields.finalOutput).not.toContain(secret);
  expect(resultWithSecretFields.stopReason).not.toContain(secret);
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
