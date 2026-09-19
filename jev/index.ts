import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createJevClient,
  JevUnavailableError,
  type JevClient,
} from "./client.ts";
import { JevInputError, parseJevRequest, type JevRequest } from "./schema.ts";

const BooleanQuestion = Type.Object({
  type: Type.Literal("boolean"),
  instructions: Type.Optional(Type.Any()),
  criteria: Type.Optional(Type.Union([
    Type.Null(),
    Type.Object({
      true: Type.Optional(Type.Any()),
      false: Type.Optional(Type.Any()),
    }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false });

const ChoiceQuestion = Type.Object({
  type: Type.Literal("choice"),
  instructions: Type.Optional(Type.Any()),
  criteria: Type.Record(Type.String(), Type.Any()),
}, { additionalProperties: false });

const ScoreQuestion = Type.Object({
  type: Type.Literal("score"),
  instructions: Type.Optional(Type.Any()),
  criteria: Type.Array(Type.Any(), { minItems: 2, maxItems: 10 }),
}, { additionalProperties: false });

export const JEV_PARAMETERS = Type.Object({
  state: Type.Any(),
  questions: Type.Record(Type.String(), Type.Union([
    BooleanQuestion,
    ChoiceQuestion,
    ScoreQuestion,
  ])),
}, { additionalProperties: false });

interface JevMetrics {
  calls: number;
  input_tokens: number;
  latency: number;
  errors: number;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function createJevTool(client: JevClient = createJevClient()) {
  const metrics: JevMetrics = {
    calls: 0,
    input_tokens: 0,
    latency: 0,
    errors: 0,
  };

  return {
    name: "jev_evaluate",
    label: "Jev Evaluate",
    description: [
      "Explicitly evaluate low-risk workflow decisions with TypeSafe Jev through Vercel AI Gateway.",
      "Accepts named boolean, choice, and score questions and returns normalized answers.",
      "If Jev is unavailable, treat the result as unavailable and make the decision yourself.",
      "Do not use this tool to approve dangerous actions or as an automatic agent loop.",
    ].join(" "),
    promptSnippet: "Use Jev only for an explicit, low-risk decision check.",
    promptGuidelines: [
      "Use explicit questions such as should_continue, should_retry, should_review, should_use_subagent, or should_ask_user.",
      "Do not call Jev automatically for every turn, and do not use an unavailable result as approval.",
    ],
    parameters: JEV_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) {
      let request: JevRequest;
      try {
        request = parseJevRequest(params);
      } catch (error) {
        const message = error instanceof JevInputError ? error.message : "Invalid Jev request";
        return {
          ...textResult({ status: "invalid_request", reason: message }),
          isError: true,
          details: { status: "invalid_request", reason: message, metrics: { ...metrics } },
        };
      }

      metrics.calls += 1;
      const started = Date.now();
      try {
        const evaluation = await client.evaluate(request, _signal);
        const latency = Date.now() - started;
        metrics.latency += latency;
        metrics.input_tokens += evaluation.usage?.input_tokens ?? 0;
        const output = {
          status: "ok",
          answers: evaluation.answers,
          ...(evaluation.usage ? { usage: evaluation.usage } : {}),
        };
        return {
          ...textResult(output),
          details: {
            status: "ok",
            usage: evaluation.usage,
            latency,
            metrics: { ...metrics },
          },
        };
      } catch (error) {
        const latency = Date.now() - started;
        metrics.latency += latency;
        metrics.errors += 1;
        const reason = error instanceof JevUnavailableError ? error.message : "Jev unavailable";
        return {
          ...textResult({ status: "unavailable", reason }),
          details: {
            status: "unavailable",
            latency,
            metrics: { ...metrics },
          },
        };
      }
    },
  };
}

export default function jevExtension(pi: ExtensionAPI) {
  pi.registerTool(createJevTool());
}
