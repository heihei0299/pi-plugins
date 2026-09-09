# cpa-codex-ws

Minimal Pi extension for forcing selected CPA GPT provider channels through Pi's native Codex Responses WebSocket transport.

Default behavior:

```text
cpa/gpt-* -> websocket-cached
```

It intentionally adds **no LLM-callable tool**, so it adds essentially no tool-schema context to the parent model.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp cpa-codex-ws.ts ~/.pi/agent/extensions/
cp cpa-codex-ws.example.json ~/.pi/agent/cpa-codex-ws.json
```

Then restart Pi or run:

```text
/reload
```

Check status:

```text
/cpa-ws
```

## Config

Default path:

```text
~/.pi/agent/cpa-codex-ws.json
```

Override with:

```bash
export PI_CPA_CODEX_WS_CONFIG=/path/to/cpa-codex-ws.json
```

Example:

```json
{
  "enabled": true,
  "transport": "websocket-cached",
  "channels": [
    {
      "provider": "cpa",
      "modelPrefix": "gpt-",
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8317"
    }
  ]
}
```

## Multiple provider channels

```json
{
  "enabled": true,
  "transport": "websocket-cached",
  "channels": [
    {
      "provider": "cpa",
      "modelPrefix": "gpt-",
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8317"
    },
    {
      "provider": "cpa-remote",
      "modelPrefix": "gpt-",
      "enabled": false,
      "baseUrl": "https://example.com"
    }
  ]
}
```

The `provider` value is the Pi provider/channel ID, not the upstream OpenAI model provider name.

## Transport modes

Supported values are Pi's native transports:

```text
sse
websocket
websocket-cached
auto
```

For CPA GPT models, the intended mode is:

```json
"transport": "websocket-cached"
```

This reuses the session WebSocket and connection-scoped cached Responses context when Pi and the upstream CPA route support it.

## CPA URL normalization

Pi's native `openai-codex-responses` transport appends `/codex/responses` to the configured base URL. This plugin normalizes common CPA URLs so that:

```text
http://127.0.0.1:8317
http://127.0.0.1:8317/v1
```

become:

```text
http://127.0.0.1:8317/backend-api/codex/responses
ws://127.0.0.1:8317/backend-api/codex/responses
```

for the Codex Responses transport.

## What it copies from pi-codex-minimal-tools

Only the transport/provider-shim idea:

- Codex Responses API path
- WebSocket transport
- `websocket-cached` session reuse
- provider-level routing

It does **not** include:

- apply_patch replacement
- web search tools
- image generation
- view_image
- model profiles
- tool rewrites
- extra system prompt injection

## Important limitation

The selected CPA build/channel must actually expose the Codex Responses WebSocket endpoint. This plugin cannot add WebSocket support to a CPA server that only implements HTTP/SSE.

Also, because Pi provider overrides apply at provider level, dedicate a provider/channel ID to GPT models when possible. Example:

```text
cpa/gpt-5.6-luna
cpa/gpt-5.6-sol
```

If the same provider ID also contains non-GPT models, this plugin intentionally rejects those models rather than silently sending them through the wrong protocol.
