import { expect, test } from "bun:test";
import {
  normalizeGatewayResponse,
  parseJevRequest,
  type JevRequest,
} from "./schema.ts";

const request: JevRequest = {
  state: "The task changed three files and has a failing test.",
  questions: {
    should_review: {
      type: "boolean",
      instructions: "Should the result be reviewed before continuing?",
    },
    next_step: {
      type: "choice",
      instructions: "What should happen next?",
      criteria: {
        review: "Ask for review.",
        continue: "Continue implementation.",
        stop: "Stop and report.",
      },
    },
    risk: {
      type: "score",
      instructions: "How risky is the change?",
      criteria: ["low", "medium", "high"],
    },
  },
};

test("accepts the three stable question types", () => {
  expect(parseJevRequest(request)).toEqual(request);
});

test("rejects empty or malformed question sets", () => {
  expect(() => parseJevRequest({ state: "x", questions: {} })).toThrow(
    "At least one question is required",
  );
  expect(() => parseJevRequest({
    state: "x",
    questions: { decision: { type: "noul" } },
  })).toThrow("must use one of: boolean, choice, score");
});

test("normalizes gateway answers without exposing its answer format", () => {
  expect(normalizeGatewayResponse({
    answers: {
      should_review: { type: "boolean", probability: 0.91 },
      next_step: {
        type: "choice",
        choice: "review",
        probabilities: { review: 0.81, continue: 0.14, stop: 0.05 },
      },
      risk: {
        type: "score",
        score: 1.7,
        probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
      },
    },
    usage: { inputTokens: 42, outputTokens: 7 },
  }, request.questions)).toEqual({
    answers: {
      should_review: { result: true, probability: 0.91 },
      next_step: {
        choice: "review",
        probabilities: { review: 0.81, continue: 0.14, stop: 0.05 },
      },
      risk: {
        score: 1.7,
        probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
      },
    },
    usage: { input_tokens: 42, output_tokens: 7 },
  });
});

test("rejects a response that does not answer every question", () => {
  expect(() => normalizeGatewayResponse({
    answers: { should_review: { type: "boolean", probability: 0.5 } },
  }, request.questions)).toThrow("missing answer for question \"next_step\"");
});


test("rejects non-JSON state instead of sending it to the gateway", () => {
  expect(() => parseJevRequest({
    state: undefined,
    questions: request.questions,
  })).toThrow("state must be JSON-compatible");
});
