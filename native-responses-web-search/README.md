# Native Responses Web Search

A Pi extension that overlays an explicitly configured provider channel and exposes a local `web_search` tool. The active channel for local behavior must use the Codex Responses endpoint. Each tool call runs a small, independent Codex Responses request; its hosted request contains `{ "type": "web_search" }`, and only the returned assistant text is given back to Pi.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/native-responses-web-search.ts
cp native-responses-web-search.example.json ~/.pi/agent/native-responses-web-search.json
```

Run `/reload` after configuration changes. Use `/native-web-search` for status.

## Configuration

Default path: `~/.pi/agent/native-responses-web-search.json`. Override it with `PI_NATIVE_RESPONSES_WEB_SEARCH_CONFIG`.

```json
{
  "enabled": true,
  "transport": "auto",
  "channels": [{
    "provider": "codex-channel",
    "endpoint": "codex",
    "transport": "websocket-cached",
    "modelPrefix": "gpt-",
    "enabled": true
  }]
}
```

A channel needs its own `enabled: true`; only one enabled channel is supported. The provider must already contain the desired models, base URL, and credentials. The overlay supplies none of those fields, preserving provider catalogue/authentication. `modelPrefix` is optional. The configured provider ID is reserved for this extension.

## Behavior

The plugin registers `web_search` with a query string parameter and a concise usage hint. It validates the active model and obtains credentials through Pi's model registry. The nested request uses the configured Codex transport, `toolChoice: "required"`, the incoming abort signal, no session ID, and a minimal context containing only a search instruction and query. Its payload callback appends the Codex native declaration. Nested errors and cancellation are surfaced; citations are not synthesized.

Parent provider requests retain their existing payload and response callbacks, but never receive a native web-search declaration and never conflict with the local tool. Enabled channels must use the Codex Responses endpoint; disabled Standard entries are ignored and may remain in the configuration.

No third-party dependency or `pi-ai` change is required. The tool uses the current active model; it does not silently select another Codex model. If the active model does not match the configured provider or prefix, the tool fails with a clear error.

## Smoke test

Configure a Codex channel, reload, and ask a current-information question. Confirm the model calls local `web_search`, the nested request uses `{ "type": "web_search" }` and the configured transport, and the parent request has no native web-search declaration.

Skipped: citation synthesis and search-result injection; add only if Pi later requires structured source metadata.
