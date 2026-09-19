import { expect, test } from "bun:test";
import {
  createJevClient,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_API_KEY_ENV,
  JevUnavailableError,
} from "./client.ts";

const request = {
  state: "A small change is ready.",
  questions: {
    should_review: {
      type: "boolean" as const,
      instructions: "Should this be reviewed?",
    },
  },
};

test("uses the Gateway evaluation protocol and normalizes the response", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const client = createJevClient({
    apiKey: "test-key",
    fetch: async (input, requestInit) => {
      url = String(input);
      init = requestInit;
      return new Response(JSON.stringify({
        answers: { should_review: { type: "boolean", probability: 0.91 } },
        usage: { inputTokens: 12, outputTokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await expect(client.evaluate(request)).resolves.toEqual({
    answers: { should_review: { result: true, probability: 0.91 } },
    usage: { input_tokens: 12, output_tokens: 2 },
  });
  expect(url).toBe(JEV_ENDPOINT);
  expect(init?.method).toBe("POST");
  expect(init?.headers).toMatchObject({
    authorization: "Bearer test-key",
    "ai-model-id": JEV_MODEL,
    "ai-evaluation-model-specification-version": "4",
  });
  expect(JSON.parse(String(init?.body))).toEqual(request);
});

test("does not retry HTTP failures and never includes response bodies in the error", async () => {
  let calls = 0;
  const client = createJevClient({
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      return new Response("secret response body", { status: 429 });
    },
  });

  await expect(client.evaluate(request)).rejects.toSatisfy((error: unknown) =>
    error instanceof JevUnavailableError && error.message.includes("HTTP 429") && !error.message.includes("secret"),
  );
  expect(calls).toBe(1);
});

test("reports a missing configured key without making a request", async () => {
  let calls = 0;
  const client = createJevClient({ apiKey: "", fetch: async () => {
    calls += 1;
    return new Response();
  } });

  await expect(client.evaluate(request)).rejects.toSatisfy((error: unknown) =>
    error instanceof JevUnavailableError && error.message.includes(JEV_API_KEY_ENV),
  );
  expect(calls).toBe(0);
});
