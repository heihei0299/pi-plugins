# cpa-plugin-muse-spark

Minimal CLIProxyAPI v7 native plugin for exactly one model:

```text
muse-spark-1.3-contributor
```

It routes OpenAI **Responses API** payloads directly to:

```text
https://opencode.ai/zen/go/v1/responses
```

No Chat Completions conversion, no account pool, no OAuth, no model aliases.

## Why

Muse Spark 1.3 on OpenCode Go is served through the Responses endpoint. Routing it to `/v1/chat/completions` can fail with HTTP 500.

## Requirements

- CLIProxyAPI v7.x
- Go 1.24+
- CGO enabled
- OpenCode Go API key

The SDK module is pinned to `v7.2.155`. If your CPA host is newer, update the module version when necessary.

## Auth file

Create `opencode-go-muse.json` inside CPA's mounted auth directory:

```json
{
  "type": "opencode-go-muse",
  "api_key": "YOUR_OPENCODE_GO_API_KEY"
}
```

For the existing Docker layout this is normally:

```text
./cpa-data/auth-dir/opencode-go-muse.json
```

Do not commit this file.

## Enable plugin

In `config.yaml`:

```yaml
plugins:
  enabled: true
  dir: "plugins"
  configs:
    cpa-plugin-muse-spark:
      enabled: true
      priority: 100
```

Existing Docker mount:

```yaml
- ./cpa-data/plugins-dir:/CLIProxyAPI/plugins
```

## Build

```bash
CGO_ENABLED=1 go build \
  -buildmode=c-shared \
  -o cpa-plugin-muse-spark.so .
```

Copy `cpa-plugin-muse-spark.so` into `./cpa-data/plugins-dir/` and restart CPA.

## Test

Non-stream:

```bash
curl -sS http://127.0.0.1:8317/v1/responses \
  -H "Authorization: Bearer $CPA_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor",
    "input": "Reply exactly: OK",
    "stream": false
  }'
```

Stream:

```bash
curl -N http://127.0.0.1:8317/v1/responses \
  -H "Authorization: Bearer $CPA_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor",
    "input": "Reply exactly: OK",
    "stream": true
  }'
```

## Scope

Supported:

- `muse-spark-1.3-contributor`
- `/v1/responses`
- non-stream Responses
- streamed Responses
- OpenCode Go API-key auth

Intentionally unsupported:

- `/v1/chat/completions`
- Muse 1.2
- other OpenCode Go models
- OAuth
- account pools / failover
- quota UI
- protocol translation

## Streaming note

The first version preserves upstream Responses SSE frames but buffers them before returning them to CPA. The next small improvement is switching the stream path to CPA's `host.stream.emit` callback for true token-by-token streaming.
