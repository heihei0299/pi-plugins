# Native Responses Web Search

A minimal Pi extension that enables Standard or Codex Responses native hosted web search on explicitly configured provider channels.

It does not register a local `web_search` tool, add prompt instructions, execute searches, or copy search results into Pi context. The provider returns its normal assistant text; the extension only adds the native Responses capability to the request payload.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/native-responses-web-search.ts
cp native-responses-web-search.example.json ~/.pi/agent/native-responses-web-search.json
```

After changing the configuration, run:

```text
/reload
```

Show the read-only status:

```text
/native-web-search
```

## Configuration

Default path:

```text
~/.pi/agent/native-responses-web-search.json
```

Override it with:

```bash
export PI_NATIVE_RESPONSES_WEB_SEARCH_CONFIG=/path/to/native-responses-web-search.json
```

Example:

```json
{
  "enabled": true,
  "transport": "auto",
  "channels": [
    {
      "provider": "openai",
      "endpoint": "standard",
      "modelPrefix": "gpt-",
      "enabled": true
    },
    {
      "provider": "codex-channel",
      "endpoint": "codex",
      "transport": "websocket-cached",
      "modelPrefix": "gpt-",
      "enabled": false
    }
  ]
}
```

A channel is disabled unless its own `enabled` value is explicitly `true`. The configured provider must already have the desired Responses models, base URL, and authentication. The extension registers an overlay for that provider without supplying `models`, `baseUrl`, or `apiKey`, so the existing catalogue and credentials remain authoritative.

Reserve the configured provider ID for this extension. Do not use the same provider ID with another provider shim such as `cpa-codex-ws`.

`modelPrefix` is optional; when omitted, all models on the dedicated provider channel that use the selected Responses API match.

## Endpoint and transport

`endpoint` selects the adapter explicitly:

- `standard` uses the `openai-responses` model API and appends `{ "type": "web_search_preview" }`.
- `codex` uses the `openai-codex-responses` model API and appends `{ "type": "web_search" }`.

Codex `transport` accepts `sse`, `websocket`, `websocket-cached`, or `auto`. A channel value overrides the top-level default, which is `auto`. The configured value is passed directly to Pi's native Codex adapter; this plugin does not infer a protocol from the URL or implement a fallback transport.

## Request behavior

Existing tools and payload fields are retained. An existing native web-search declaration is not duplicated. A request with `"tool_choice": "none"` is left unchanged. Existing `onPayload` and `onResponse` callbacks are preserved; Codex's adapter runs the existing payload callback before adding its declaration.

The model still decides whether to search. No search is forced for ordinary prompts, and no search action, query, result snippet, or unused source is added to later model-visible context. The endpoint's assistant text is returned unchanged.

## Manual smoke test

1. Configure a provider whose Standard model uses `api: "openai-responses"` and whose endpoint supports `web_search_preview`.
2. Enable the Standard channel, run `/reload`, then `/native-web-search` and confirm the channel reports a matching model.
3. Ask a current-information question and verify the provider receives `{ "type": "web_search_preview" }`.
4. Configure a separate provider channel whose model uses `api: "openai-codex-responses"`, enable the Codex channel with an explicit transport, and reload.
5. Verify the Codex endpoint receives `{ "type": "web_search" }` over the configured transport.
6. Ask a normal coding question and verify no local `web_search` tool or extra prompt text appears.
