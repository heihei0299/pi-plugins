# Native Responses Web Search

A minimal Pi extension that enables Standard Responses native hosted web search on explicitly configured provider channels.

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
  "channels": [
    {
      "provider": "openai",
      "modelPrefix": "gpt-",
      "enabled": true
    }
  ]
}
```

A channel is disabled unless its own `enabled` value is explicitly `true`. The configured provider must already have the desired Standard Responses models, base URL, and authentication. The extension registers an overlay for that provider without supplying `models`, `baseUrl`, or `apiKey`, so the existing catalogue and credentials remain authoritative.

Reserve the configured provider ID for this extension. Do not use the same provider ID with another provider shim such as `cpa-codex-ws`.

`modelPrefix` is optional; when omitted, all models on the dedicated provider channel that use the `openai-responses` API match.

## Request behavior

For a matching Standard Responses model, the extension appends this minimal declaration:

```json
{ "type": "web_search_preview" }
```

Existing tools and payload fields are retained. An existing native web-search declaration is not duplicated. A request with `"tool_choice": "none"` is left unchanged.

The model still decides whether to search. No search is forced for ordinary prompts, and no search action, query, result snippet, or unused source is added to later model-visible context.

## Manual smoke test

1. Configure a provider whose model uses `api: "openai-responses"` and whose endpoint supports `web_search_preview`.
2. Enable that provider channel in the file above.
3. Run `/reload`, then `/native-web-search` and confirm the channel reports a matching model.
4. Ask a current-information question and verify the provider receives the hosted-search declaration.
5. Ask a normal coding question and verify no local `web_search` tool or extra prompt text appears.
