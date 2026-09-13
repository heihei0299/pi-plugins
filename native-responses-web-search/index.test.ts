import { expect, test } from "bun:test";
import {
  addNativeWebSearch,
  formatStatus,
  installNativeResponsesWebSearch,
  normalizeConfig,
} from "./index.ts";

const model = {
  provider: "codex",
  id: "gpt-5-codex",
  api: "openai-codex-responses",
};

const config = normalizeConfig({
  transport: "sse",
  channels: [{
    provider: "codex",
    endpoint: "codex",
    modelPrefix: "gpt-",
    enabled: true,
  }],
});

function assistantResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "openai-codex-responses",
    provider: "codex",
    model: "gpt-5-codex",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function setup(result = assistantResult(), transport = "sse") {
  const tools: any[] = [];
  const providers: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, { handler: any }>();
  const capture: { calls: any[] } = { calls: [] };
  const pi: any = {
    tools,
    providers,
    commands,
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerProvider(name: string, providerConfig: any) {
      providers.push({ name, config: providerConfig });
    },
    registerCommand(name: string, command: { handler: any }) {
      commands.set(name, command);
    },
  };
  const adapter = (adapterModel: unknown, context: unknown, options: unknown) => {
    capture.calls.push({ model: adapterModel, context, options });
    return { result: async () => result } as any;
  };
  const channelConfig = normalizeConfig({
    transport,
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(pi, channelConfig, "/tmp/config", {
    codex: adapter as any,
  });
  return { pi, capture, modelRegistry: authRegistry() };
}

function authRegistry() {
  return {
    getApiKeyAndHeaders: async () => ({
      ok: true,
      apiKey: "key",
      headers: { "x-test": "yes" },
    }),
  };
}

function toolContext(
  modelOverride: unknown = model,
  modelRegistry: unknown = authRegistry(),
) {
  return {
    model: modelOverride,
    modelRegistry,
    signal: undefined,
    sessionManager: { getSessionId: () => "parent-session" },
  };
}

test("registers the local tool and preserves the Codex provider overlay", () => {
  const { pi } = setup();

  expect(pi.tools).toHaveLength(1);
  expect(pi.tools[0].name).toBe("web_search");
  expect(pi.tools[0].parameters).toEqual({
    type: "object",
    properties: {
      query: { type: "string", description: "The web search query" },
    },
    required: ["query"],
    additionalProperties: false,
  });
  expect(pi.providers).toHaveLength(1);
  expect(pi.providers[0].name).toBe("codex");
  expect(pi.providers[0].config.api).toBe("openai-codex-responses");
});

test("does not register a tool when the plugin is disabled", () => {
  const pi: any = {
    tools: [],
    providers: [],
    registerTool(tool: unknown) { this.tools.push(tool); },
    registerProvider(name: string, config: unknown) { this.providers.push({ name, config }); },
    registerCommand() {},
  };

  installNativeResponsesWebSearch(
    pi,
    normalizeConfig({
      enabled: false,
      channels: [{ provider: "codex", endpoint: "codex", enabled: true }],
    }),
    "/tmp/config",
    {},
  );

  expect(pi.tools).toHaveLength(0);
  expect(pi.providers).toHaveLength(0);
});

test("requires enabled channels to use the Codex endpoint", () => {
  expect(() => normalizeConfig({
    channels: [{ provider: "openai", endpoint: "standard", enabled: true }],
  })).toThrow("endpoint must be \"codex\"");

  expect(() => normalizeConfig({
    channels: [
      { provider: "codex", endpoint: "codex", enabled: true },
      { provider: "other", endpoint: "codex", enabled: true },
    ],
  })).toThrow("one enabled Dedicated Provider Channel");
});

test("validates query and model before resolving auth", async () => {
  const { pi } = setup();
  let authCalls = 0;
  const registry = {
    getApiKeyAndHeaders: async () => {
      authCalls += 1;
      return { ok: true, apiKey: "key" };
    },
  };
  const tool = pi.tools[0];

  await expect(tool.execute("1", {}, undefined, undefined, toolContext(model, registry)))
    .rejects.toThrow("non-empty");
  await expect(tool.execute(
    "1",
    { query: "x" },
    undefined,
    undefined,
    toolContext({ ...model, provider: "other" }, registry),
  )).rejects.toThrow("does not match");

  expect(authCalls).toBe(0);
});

test("runs a nested native Codex search with auth, transport, signal, and no session", async () => {
  const { pi, capture, modelRegistry } = setup();
  const signal = new AbortController().signal;
  const result = await pi.tools[0].execute(
    "1",
    { query: "  latest news  " },
    signal,
    undefined,
    toolContext(model, modelRegistry),
  );
  const call = capture.calls[0];
  const payload = await call.options.onPayload({
    input: "latest news",
    tools: [{ type: "function", name: "read" }],
  });

  expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  expect(result.usage.input).toBe(1);
  expect(call.context.systemPrompt).toContain("native web search");
  expect(call.context.messages).toHaveLength(1);
  expect(call.context.messages[0]).toMatchObject({
    role: "user",
    content: "latest news",
  });
  expect(call.context.messages[0].timestamp).toBeNumber();
  expect(call.context.tools).toEqual([]);
  expect(call.options).toMatchObject({
    apiKey: "key",
    headers: { "x-test": "yes" },
    transport: "sse",
    toolChoice: "required",
    signal,
  });
  expect(call.options.sessionId).toBeUndefined();
  expect(payload).toEqual({
    input: "latest news",
    tools: [
      { type: "function", name: "read" },
      { type: "web_search" },
    ],
  });
});

test("does not duplicate an existing native declaration or mutate the payload", () => {
  const payload = {
    input: "already enabled",
    tools: [{ type: "web_search" }],
  };
  const result = addNativeWebSearch(payload, "codex");

  expect(result).toBe(payload);
  expect(payload.tools).toEqual([{ type: "web_search" }]);
  expect(addNativeWebSearch({ input: "none", tool_choice: "none" }, "codex"))
    .toEqual({ input: "none", tool_choice: "none" });
});

test("does not declare native search on the parent request or reject the local tool", async () => {
  const { pi, capture } = setup();
  let payloadCallbackCalls = 0;
  let responseCallbackCalls = 0;
  const stream = pi.providers[0].config.streamSimple(model, { messages: [], tools: [] }, {
    onPayload: async (payload: any) => {
      payloadCallbackCalls += 1;
      return { ...payload, temperature: 0 };
    },
    onResponse: async () => {
      responseCallbackCalls += 1;
    },
  });
  const payload = await capture.calls[0].options.onPayload({ input: "x" }, model);
  await capture.calls[0].options.onResponse({ status: 200, headers: {} }, model);

  expect(stream).toBeDefined();
  expect(payloadCallbackCalls).toBe(1);
  expect(responseCallbackCalls).toBe(1);
  expect(payload).toEqual({ input: "x", temperature: 0 });
  expect(capture.calls[0].options.transport).toBe("sse");
});

test("surfaces authentication and nested response failures", async () => {
  const authFailure = setup();
  const auth = {
    getApiKeyAndHeaders: async () => ({ ok: false, error: "not signed in" }),
  };
  await expect(authFailure.pi.tools[0].execute(
    "1",
    { query: "latest" },
    undefined,
    undefined,
    toolContext(model, auth),
  )).rejects.toThrow("not signed in");

  const failed = setup(assistantResult({
    stopReason: "error",
    errorMessage: "endpoint rejected",
  }));
  await expect(failed.pi.tools[0].execute(
    "1",
    { query: "latest" },
    undefined,
    undefined,
    toolContext(model, failed.modelRegistry),
  )).rejects.toThrow("endpoint rejected");
});

test("fails closed when the Codex adapter is unavailable", () => {
  const notifications: string[] = [];
  const pi: any = {
    tools: [],
    providers: [],
    registerTool(tool: unknown) { this.tools.push(tool); },
    registerProvider(name: string, config: unknown) { this.providers.push({ name, config }); },
    registerCommand(name: string, command: any) { this.command = { name, ...command }; },
  };
  installNativeResponsesWebSearch(pi, config, "/tmp/config", {});
  pi.command.handler("", {
    model,
    ui: { notify(message: string) { notifications.push(message); } },
  });

  expect(pi.tools).toHaveLength(0);
  expect(notifications[0]).toContain("adapter is unavailable");
});

test("reports configured status and model mismatch", async () => {
  const { pi } = setup();
  const notifications: string[] = [];
  await pi.commands.get("native-web-search")?.handler("", {
    model: { ...model, id: "o3-mini" },
    ui: { notify(message: string) { notifications.push(message); } },
  });

  expect(notifications[0]).toContain("model prefix does not match");
  expect(formatStatus(config, model, "/tmp/config")).toContain(
    "codex/gpt- -> Codex Responses (sse) -> enabled; model matches (tool registration pending)",
  );
});

test("reports a registered tool for a matching model", async () => {
  const { pi } = setup();
  const notifications: string[] = [];
  await pi.commands.get("native-web-search")?.handler("", {
    model,
    ui: { notify(message: string) { notifications.push(message); } },
  });

  expect(notifications[0]).toContain("enabled; model matches; tool registered");
});

test("supports every configured Codex transport", async () => {
  for (const transport of ["sse", "websocket", "websocket-cached", "auto"] as const) {
    const { pi, capture, modelRegistry } = setup(assistantResult(), transport);
    await pi.tools[0].execute(
      "1",
      { query: "latest" },
      undefined,
      undefined,
      toolContext(model, modelRegistry),
    );
    expect(capture.calls[0].options.transport).toBe(transport);
  }
});

test("allows disabled Standard entries while requiring enabled channels to be Codex", () => {
  const normalized = normalizeConfig({
    channels: [
      { provider: "legacy", endpoint: "standard", enabled: false },
      { provider: "codex", endpoint: "codex", enabled: true },
    ],
  });

  expect(normalized.channels[0]).toMatchObject({
    provider: "legacy",
    endpoint: "standard",
    enabled: false,
  });
  expect(normalized.channels[1].endpoint).toBe("codex");
});

test("removes an externally injected native search declaration from the parent request", async () => {
  const { pi, capture } = setup();
  pi.providers[0].config.streamSimple(model, { messages: [], tools: [] }, {
    onPayload: async (payload: any) => ({
      ...payload,
      tools: [
        { type: "function", name: "read" },
        { type: "web_search" },
      ],
    }),
  });

  const payload = await capture.calls[0].options.onPayload({ input: "x" }, model);

  expect(payload).toEqual({
    input: "x",
    tools: [{ type: "function", name: "read" }],
  });
});

test("preserves parent HTTP response callback semantics", async () => {
  const { pi, capture } = setup();
  let callbackCalls = 0;
  pi.providers[0].config.streamSimple(model, { messages: [], tools: [] }, {
    onResponse: async () => {
      callbackCalls += 1;
    },
  });

  await expect(capture.calls[0].options.onResponse(
    { status: 500, headers: {} },
    model,
  )).resolves.toBeUndefined();
  expect(callbackCalls).toBe(1);
});
