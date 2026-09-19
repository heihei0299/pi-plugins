# Jev

A small Pi extension that exposes one explicit tool, `jev_evaluate`, for low-risk typed decisions through the Vercel AI Gateway. It does not register Jev as a Pi model, change the agent loop, or approve dangerous actions.

## Setup

Set the Gateway key in the process environment:

```bash
export VERCEL_AI_GATEWAY_API_KEY=...
```

The extension uses the fixed model `typesafe-ai/jev` and a five-second request timeout. The root package registers it automatically when installed or loaded from this repository.

## Verified Gateway protocol

T01 was verified against the Vercel AI SDK Gateway evaluation protocol:

- `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`
- `Authorization: Bearer $VERCEL_AI_GATEWAY_API_KEY`
- `ai-model-id: typesafe-ai/jev`
- `ai-evaluation-model-specification-version: 4`
- JSON body: `{ "state": ..., "questions": ... }`
- JSON response: `{ "answers": ..., "usage": ... }`

Minimal request sample:

```bash
: "${VERCEL_AI_GATEWAY_API_KEY:?set VERCEL_AI_GATEWAY_API_KEY first}"
curl --fail-with-body --max-time 10 \
  https://ai-gateway.vercel.sh/v4/ai/evaluation-model \
  -H "Authorization: Bearer ${VERCEL_AI_GATEWAY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'ai-gateway-protocol-version: 0.0.1' \
  -H 'ai-gateway-auth-method: api-key' \
  -H 'ai-evaluation-model-specification-version: 4' \
  -H 'ai-model-id: typesafe-ai/jev' \
  --data '{
    "state": "The implementation has a failing test.",
    "questions": {
      "should_review": {
        "type": "boolean",
        "instructions": "Should the result be reviewed before continuing?"
      }
    }
  }'
```

The Pi tool hides the Gateway answer format and returns normalized answers:

```json
{
  "status": "ok",
  "answers": {
    "should_review": { "result": true, "probability": 0.91 }
  }
}
```

Choice answers return `choice` and `probabilities`; score answers return `score` and `probabilities`.

## Controlled decisions

These are examples of explicit calls, not automatic hooks:

- `should_continue` — after a test or implementation step, decide whether more work is warranted.
- `should_retry` — after a transient tool or provider failure, decide whether one deliberate retry is useful.
- `should_review` — before asking for review or presenting a risky-looking code change.
- `should_use_subagent` — before starting an optional, isolated subagent task.
- `should_ask_user` — when requirements contain a material ambiguity.

Keep the state limited to the evidence needed for the question. Jev is advisory: an unavailable result means the main model makes the decision itself. Calls are explicit tool calls; this extension never starts retries, subagents, or user prompts on its own.

## Failure and telemetry behavior

Missing credentials, timeouts, network failures, HTTP errors, and malformed responses return `status: "unavailable"` without blocking the Pi turn. The client makes one request and does not retry. In-memory tool details record only aggregate `calls`, `input_tokens`, `latency`, and `errors`; the API key and complete state are not recorded.
