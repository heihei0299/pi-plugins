# Native Responses Web Search

A Pi extension that exposes a local `web_search` tool backed by a nested Standard or Codex Responses request. The configured endpoint selects the adapter and native hosted-search declaration:

- `standard` → `openai-responses` → `{ "type": "web_search_preview" }`
- `codex` → `openai-codex-responses` → `{ "type": "web_search" }`

## Install

Copy the whole plugin directory so its runtime dependency is available to the extension:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r native-responses-web-search ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/native-responses-web-search
pnpm install --prod --ignore-scripts
```

Copy the example configuration only when you do not already have one:

```bash
cp native-responses-web-search.example.json ~/.pi/agent/native-responses-web-search.json
```

Run `/reload` after configuration changes. Use `/native-web-search` for status.

## Configuration

Default path: `~/.pi/agent/native-responses-web-search.json`. Override it with `PI_NATIVE_RESPONSES_WEB_SEARCH_CONFIG`.

```json
{
  "enabled": true,
  "transport": "auto",
  "channels": [
    {
      "provider": "cpa",
      "endpoint": "standard",
      "modelPrefix": "gpt-5.6-luna",
      "model": "gpt-5.6-luna",
      "enabled": true
    },
    {
      "provider": "openai-codex",
      "endpoint": "codex",
      "transport": "websocket-cached",
      "modelPrefix": "gpt-",
      "enabled": false
    }
  ]
}
```

Only one channel may be enabled at a time. An enabled channel must match the active model's provider, API, and optional model prefix. Standard channels require `openai-responses`; Codex channels require `openai-codex-responses`. Disabled entries may remain in the configuration.

Set `model` on a channel to make `web_search` a standalone tool: nested search requests then always run through that exact model (resolved from the provider registry, with its own credentials) regardless of which model is active. Without `model`, the active model must match the channel. The backend model must exist in the provider registry and use the channel's Responses API.

The configured provider must already contain the desired model, base URL, and credentials. The overlay supplies none of those fields, preserving the provider catalogue and authentication. Reserve the configured provider ID for this extension and do not share it with another provider shim.

## Behavior

The plugin registers a local `web_search` tool with a single `query` parameter. The parent model decides when to call it. Each call performs a separate Responses request with:

- only a short search instruction and the explicit query;
- no parent conversation, parent tool list, or session ID;
- `toolChoice: "required"`;
- the configured Codex transport when using the Codex endpoint;
- credentials resolved through Pi's model registry;
- the endpoint-specific native hosted-search declaration.

The nested assistant text is returned as the local tool result. Nested errors and cancellation are surfaced. The plugin does not synthesize citations or copy raw search material into later context.

Parent provider requests expose only the local `web_search` function tool. They do not receive a native web-search declaration; an externally injected native declaration is removed before the parent request is sent. Existing payload and response callbacks are preserved.

## Failure handling

Use `/native-web-search` to distinguish configuration errors, missing Responses adapters, model/API mismatches, and tool registration failures. The tool uses the current active model and does not silently select another one.

No third-party search service or `pi-ai` source change is required. The extension directory must have its `@earendil-works/pi-ai` dependency installed; copying only `index.ts` is not sufficient for runtime adapter imports.

## Smoke test

1. Install the whole directory and run `pnpm install --prod --ignore-scripts` inside it.
2. Configure one enabled channel whose provider/API matches the active model.
3. Reload Pi and run `/native-web-search`.
4. Confirm the status reports `model matches; tool registered`.
5. Ask a current-information question and confirm the model calls local `web_search`.
6. Confirm the nested request uses `web_search_preview` for Standard or `web_search` for Codex.
7. Confirm ordinary coding questions do not automatically call the search tool.
