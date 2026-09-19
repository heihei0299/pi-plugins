import { expect, test } from "bun:test";
import { createJevTool } from "./index.ts";
import { JevUnavailableError } from "./client.ts";

const request = {
  state: "A completed implementation.",
  questions: {
    should_continue: {
      type: "boolean" as const,
      instructions: "Should the agent continue?",
    },
  },
};

test("exposes one explicit jev_evaluate tool with the stable input shape", () => {
  const tool = createJevTool({ evaluate: async () => ({ answers: {} }) } as any) as any;

  expect(tool.name).toBe("jev_evaluate");
  expect(tool.parameters.type).toBe("object");
  expect(tool.description).toMatch(/explicit/i);
});

test("returns normalized answers and safe aggregate metrics", async () => {
  const tool = createJevTool({
    evaluate: async () => ({
      answers: { should_continue: { result: true, probability: 0.91 } },
      usage: { input_tokens: 12, output_tokens: 2 },
    }),
  });

  const result = await tool.execute("call-1", request, undefined, undefined, {} as any);
  expect(result.content[0]).toEqual({
    type: "text",
    text: JSON.stringify({
      status: "ok",
      answers: { should_continue: { result: true, probability: 0.91 } },
    }),
  });
  expect(result.details).toMatchObject({
    status: "ok",
    usage: { input_tokens: 12, output_tokens: 2 },
    metrics: { calls: 1, input_tokens: 12, errors: 0 },
  });
  expect(result.details.latency).toEqual(expect.any(Number));
});

test("returns unavailable instead of failing the Pi turn", async () => {
  const tool = createJevTool({
    evaluate: async () => {
      throw new JevUnavailableError("Gateway returned HTTP 503", 503);
    },
  });

  const result = await tool.execute("call-1", request, undefined, undefined, {} as any);
  expect(result.isError).not.toBe(true);
  expect(result.content[0]).toEqual({
    type: "text",
    text: JSON.stringify({ status: "unavailable", reason: "Gateway returned HTTP 503" }),
  });
  expect(result.details).toMatchObject({
    status: "unavailable",
    metrics: { calls: 1, input_tokens: 0, errors: 1 },
  });
});

test("reports invalid tool input without calling Jev", async () => {
  let calls = 0;
  const tool = createJevTool({
    evaluate: async () => {
      calls += 1;
      return { answers: {} };
    },
  } as any);

  const result = await tool.execute("call-1", {
    state: "x",
    questions: {},
  }, undefined, undefined, {} as any);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("At least one question is required");
  expect(calls).toBe(0);
});
