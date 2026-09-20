import { afterAll, expect, mock, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousConfigPath = process.env.PI_LOCKED_SUBAGENTS_CONFIG;
const previousRunDir = process.env.PI_LOCKED_SUBAGENTS_RUN_DIR;
const previousAllowed = process.env.PI_LOCKED_SUBAGENT_ALLOWED;
const previousDepth = process.env.PI_LOCKED_SUBAGENT_DEPTH;
delete process.env.PI_LOCKED_SUBAGENT_ALLOWED;
delete process.env.PI_LOCKED_SUBAGENT_DEPTH;

const root = await mkdtemp(join(tmpdir(), "pi-locked-subagents-index-test-"));
const workerPath = join(root, "worker");
const configPath = join(root, "config.json");
const mixedProtocolOutput = [
  "not json",
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    },
  }),
].join("\n") + "\n";
await writeFile(
  workerPath,
  `#!${process.execPath}
const task = process.argv.at(-1);
process.stdout.write(task === "return a result"
  ? ${JSON.stringify(mixedProtocolOutput)}
  : JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: task }],
        stopReason: "stop",
      },
    }) + "\\n");
`,
  { mode: 0o700 },
);
await chmod(workerPath, 0o700);
await writeFile(configPath, JSON.stringify({
  piBinary: workerPath,
  agents: {
    worker: { model: "test/model" },
    reviewer: { model: "test/model" },
  },
}));
process.env.PI_LOCKED_SUBAGENTS_CONFIG = configPath;
process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = root;

mock.module("typebox", () => ({
  Type: {
    Array: (items: unknown) => items,
    Object: (properties: unknown) => properties,
    Optional: (schema: unknown) => schema,
    String: (options: unknown) => options,
  },
}));

const { default: lockedSubagents } = await import("./index.ts");

function createTool() {
  let tool: any;
  lockedSubagents({
    registerTool(value: unknown) { tool = value; },
    registerCommand() {},
  } as any);
  return tool;
}

afterAll(async () => {
  if (previousConfigPath === undefined) delete process.env.PI_LOCKED_SUBAGENTS_CONFIG;
  else process.env.PI_LOCKED_SUBAGENTS_CONFIG = previousConfigPath;
  if (previousRunDir === undefined) delete process.env.PI_LOCKED_SUBAGENTS_RUN_DIR;
  else process.env.PI_LOCKED_SUBAGENTS_RUN_DIR = previousRunDir;
  if (previousAllowed === undefined) delete process.env.PI_LOCKED_SUBAGENT_ALLOWED;
  else process.env.PI_LOCKED_SUBAGENT_ALLOWED = previousAllowed;
  if (previousDepth === undefined) delete process.env.PI_LOCKED_SUBAGENT_DEPTH;
  else process.env.PI_LOCKED_SUBAGENT_DEPTH = previousDepth;
  await rm(root, { recursive: true, force: true });
});

test("reports malformed output before a valid message_end as failed", async () => {
  const tool = createTool();

  const result = await tool.execute(
    "call-1",
    { agent: "worker", task: "return a result" },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("invalid JSON");
});

test("passes a bounded review packet without embedding a complete diff", async () => {
  const tool = createTool();

  const result = await tool.execute(
    "call-2",
    {
      agent: "reviewer",
      task: "Assess the change.",
      reviewPacket: {
        issue: "T01 — Review Packet",
        fixedPoint: "base123",
        currentHead: "head456",
        changedFiles: ["pi-locked-subagents/index.ts"],
        requirements: ["Review only the bounded diff."],
        checks: ["bun test pi-locked-subagents/index.test.ts"],
        limitations: ["No live provider run."],
        scope: "Review this issue/change only.",
      },
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  expect(result.isError).not.toBe(true);
  const text = result.content[0].text;
  expect(text).toContain("Issue: T01 — Review Packet");
  expect(text).toContain("git diff base123...head456");
  expect(text).toContain("pi-locked-subagents/index.ts");
  expect(text).toContain("Do not perform repository-wide discovery.");
  expect(text).toContain("Assess the change.");
});

test("requires a review packet for reviewer calls", async () => {
  const tool = createTool();

  const result = await tool.execute(
    "call-3",
    { agent: "reviewer", task: "Review the change." },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("reviewPacket");
});
