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

function pluginHarness(result: Record<string, unknown> = assistantResult()) {
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
  return { pi, tools, providers, capture, adapter };
}

function setup(result = assistantResult(), transport = "sse") {
  const h = pluginHarness(result);
  const channelConfig = normalizeConfig({
    transport,
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: h.adapter as any,
  });
  return { pi: h.pi, capture: h.capture, modelRegistry: authRegistry() };
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

test("requires an explicit endpoint for every channel", () => {
  expect(() => normalizeConfig({
    channels: [{ provider: "missing-endpoint", enabled: true }],
  })).toThrow("endpoint must be explicitly configured as standard or codex");
});

test("accepts an enabled Standard Responses channel", () => {
  const normalized = normalizeConfig({
    channels: [{ provider: "cpa", endpoint: "standard", enabled: true }],
  });

  expect(normalized.channels[0]).toMatchObject({
    provider: "cpa",
    endpoint: "standard",
    enabled: true,
  });
});

test("normalizes endpoint-specific native web-search tool choices", () => {
  expect(normalizeConfig({
    channels: [{ provider: "standard", endpoint: "standard", enabled: true }],
  }).channels[0].nativeTool).toBe("web_search_preview");
  expect(normalizeConfig({
    channels: [{
      provider: "modern",
      endpoint: "standard",
      nativeTool: "web_search",
      enabled: true,
    }],
  }).channels[0].nativeTool).toBe("web_search");
  expect(normalizeConfig({
    channels: [{ provider: "codex", endpoint: "codex", enabled: true }],
  }).channels[0].nativeTool).toBe("web_search");
});

test("rejects unsupported native web-search tool choices", () => {
  expect(() => normalizeConfig({
    channels: [{
      provider: "standard",
      endpoint: "standard",
      nativeTool: "unknown",
    }],
  })).toThrow("nativeTool must be web_search or web_search_preview");
  expect(() => normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      nativeTool: "web_search_preview",
    }],
  })).toThrow("nativeTool must be web_search for the codex endpoint");
});

test("limits configuration to one enabled provider channel", () => {
  expect(() => normalizeConfig({
    channels: [
      { provider: "codex", endpoint: "codex", enabled: true },
      { provider: "other", endpoint: "codex", enabled: true },
    ],
  })).toThrow("one enabled Dedicated Provider Channel");
});

test("registers and runs local search through Standard Responses", async () => {
  const standardModel = {
    provider: "cpa",
    id: "gpt-5.6-luna",
    api: "openai-responses",
  };
  const standardConfig = normalizeConfig({
    channels: [{
      provider: "cpa",
      endpoint: "standard",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  const tools: any[] = [];
  const providers: any[] = [];
  const capture: any = {};
  const pi: any = {
    registerTool(tool: any) { tools.push(tool); },
    registerProvider(name: string, value: any) { providers.push({ name, value }); },
    registerCommand() {},
  };
  const adapter = (_model: any, context: any, options: any) => {
    capture.context = context;
    capture.options = options;
    return { result: async () => assistantResult() } as any;
  };

  installNativeResponsesWebSearch(pi, standardConfig, "/tmp/config", {
    standard: adapter as any,
  } as any);
  const result = await tools[0].execute(
    "1",
    { query: "latest news" },
    undefined,
    undefined,
    {
      model: standardModel,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
      },
    },
  );
  const payload = await capture.options.onPayload({ input: "latest news" });

  expect(providers[0].value.api).toBe("openai-responses");
  expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  expect(payload.tools).toEqual([{ type: "web_search_preview" }]);
});

test("uses the configured Standard native tool in nested requests", async () => {
  const standardModel = {
    provider: "cpa",
    id: "gpt-5.6-luna",
    api: "openai-responses",
  };
  const h = pluginHarness();
  installNativeResponsesWebSearch(
    h.pi,
    normalizeConfig({
      channels: [{
        provider: "cpa",
        endpoint: "standard",
        nativeTool: "web_search",
        modelPrefix: "gpt-",
        enabled: true,
      }],
    }),
    "/tmp/config",
    { standard: h.adapter as any },
  );

  await h.tools[0].execute(
    "1",
    { query: "latest news" },
    undefined,
    undefined,
    {
      model: standardModel,
      modelRegistry: authRegistry(),
    },
  );
  const payload = await h.capture.calls[0].options.onPayload({
    input: "latest news",
  });

  expect(payload.tools).toEqual([{ type: "web_search" }]);
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

test("replaces an existing differently typed native declaration", () => {
  const payload = {
    input: "use the configured declaration",
    tools: [{ type: "web_search" }],
  };

  expect(addNativeWebSearch(payload, "standard", "web_search_preview")).toEqual({
    input: "use the configured declaration",
    tools: [{ type: "web_search_preview" }],
  });
});

test("deduplicates an existing declaration of the configured type", () => {
  const payload = {
    input: "use one declaration",
    tools: [{ type: "web_search_preview" }, { type: "web_search_preview" }],
  };

  expect(addNativeWebSearch(payload, "standard", "web_search_preview")).toEqual({
    input: "use one declaration",
    tools: [{ type: "web_search_preview" }],
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

test("passes non-matching models through to the adapter unchanged", () => {
  const { pi, capture } = setup();
  const otherModel = { ...model, id: "gemini-3.8-flash-high" };
  const options = { onResponse: async () => {} };

  const stream = pi.providers[0].config.streamSimple(
    otherModel,
    { messages: [], tools: [] },
    options,
  );

  expect(stream).toBeDefined();
  expect(capture.calls).toHaveLength(1);
  expect(capture.calls[0].model).toBe(otherModel);
  expect(capture.calls[0].options).toBe(options);
});

const searchBackendModel = {
  provider: "cpa",
  id: "gpt-5.6-luna",
  api: "openai-responses",
};

function searchRegistry() {
  const authFor: string[] = [];
  return {
    authFor,
    find(provider: string, id: string) {
      return provider === searchBackendModel.provider && id === searchBackendModel.id
        ? { ...searchBackendModel }
        : undefined;
    },
    getApiKeyAndHeaders: async (model: { id: string }) => {
      authFor.push(model.id);
      return { ok: true, apiKey: `key-for-${model.id}` };
    },
  };
}

function standaloneSetup(registry = searchRegistry()) {
  const h = pluginHarness();
  installNativeResponsesWebSearch(
    h.pi,
    normalizeConfig({
      channels: [{
        provider: "cpa",
        endpoint: "standard",
        model: "gpt-5.6-luna",
        enabled: true,
      }],
    }),
    "/tmp/config",
    { standard: h.adapter as any },
  );
  return { tools: h.tools, capture: h.capture, registry };
}

test("runs web_search from any model through the configured backend model", async () => {
  const { tools, capture, registry } = standaloneSetup();
  const gemini = {
    provider: "cpa",
    id: "gemini-3.8-flash-high",
    api: "openai-responses",
  };

  const result = await tools[0].execute(
    "1",
    { query: "latest news" },
    undefined,
    undefined,
    toolContext(gemini, registry),
  );

  expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  expect(capture.calls[0].model).toMatchObject({
    provider: "cpa",
    id: "gpt-5.6-luna",
  });
  expect(registry.authFor).toEqual(["gpt-5.6-luna"]);
});

test("fails clearly when the configured backend model is not in the registry", async () => {
  const { tools, registry } = standaloneSetup({
    ...searchRegistry(),
    find: () => undefined,
  });

  await expect(tools[0].execute(
    "1",
    { query: "latest news" },
    undefined,
    undefined,
    toolContext({ ...searchBackendModel, id: "gemini-3.8-flash-high" }, registry),
  )).rejects.toThrow("not present in the model registry");
});

test("fails clearly when the configured backend model uses another API", async () => {
  const { tools, registry } = standaloneSetup({
    ...searchRegistry(),
    find: () => ({ ...searchBackendModel, api: "openai-completions" }),
  });

  await expect(tools[0].execute(
    "1",
    { query: "latest news" },
    undefined,
    undefined,
    toolContext({ ...searchBackendModel, id: "gemini-3.8-flash-high" }, registry),
  )).rejects.toThrow("does not use the configured");
});

test("rejects an empty backend model in a channel", () => {
  expect(() => normalizeConfig({
    channels: [{
      provider: "cpa",
      endpoint: "standard",
      model: "  ",
      enabled: true,
    }],
  })).toThrow("model must be a non-empty string");
});

test("fails clearly when the model registry does not support model lookup", async () => {
  const { tools, registry } = standaloneSetup({
    ...searchRegistry(),
    find: undefined,
  } as any);

  await expect(tools[0].execute(
    "1",
    { query: "latest news" },
    undefined,
    undefined,
    toolContext({ ...searchBackendModel, id: "gemini-3.8-flash-high" }, registry),
  )).rejects.toThrow("does not support model lookup");
});

test("reports standalone status with the backend model", async () => {
  const notifications: string[] = [];
  const pi: any = {
    registerTool() {},
    registerProvider() {},
    registerCommand(name: string, command: { handler: any }) {
      pi.commands = { ...pi.commands, [name]: command };
    },
    commands: {},
  };
  installNativeResponsesWebSearch(
    pi,
    normalizeConfig({
      channels: [{
        provider: "cpa",
        endpoint: "standard",
        modelPrefix: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        enabled: true,
      }],
    }),
    "/tmp/config",
    { standard: (() => ({ result: async () => assistantResult() })) as any },
  );
  await pi.commands["native-web-search"].handler("", {
    model: { provider: "cpa", id: "gemini-3.8-flash-high", api: "openai-responses" },
    ui: { notify(message: string) { notifications.push(message); } },
  });

  expect(notifications[0]).toContain("standalone; backend cpa/gpt-5.6-luna");
  expect(notifications[0]).not.toContain("model prefix does not match");
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

test("uses endpoint-neutral authentication wording for Standard", async () => {
  const h = pluginHarness();
  const standardModel = {
    provider: "cpa",
    id: "gpt-5.6-luna",
    api: "openai-responses",
  };
  installNativeResponsesWebSearch(
    h.pi,
    normalizeConfig({
      channels: [{ provider: "cpa", endpoint: "standard", enabled: true }],
    }),
    "/tmp/config",
    { standard: h.adapter as any },
  );

  const error = await h.tools[0].execute(
    "1",
    { query: "latest" },
    undefined,
    undefined,
    toolContext(standardModel, {
      getApiKeyAndHeaders: async () => ({ ok: true }),
    }),
  ).catch((value: unknown) => value as Error);

  expect(error.message).toContain("configured provider");
  expect(error.message).not.toContain("Codex");
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

test("reports the configured native web-search tool in status", () => {
  const standardConfig = normalizeConfig({
    channels: [{
      provider: "cpa",
      endpoint: "standard",
      nativeTool: "web_search",
      enabled: true,
    }],
  });

  const status = formatStatus(standardConfig, undefined, "/tmp/config");
  expect(status).toContain("Native web search tool: enabled");
  expect(status).not.toContain("Codex web search tool:");
  expect(status).toContain("cpa/* -> Standard Responses (web_search)");
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
    "codex/gpt- -> Codex Responses (sse, web_search) -> enabled; model matches (tool registration pending)",
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

test("allows disabled Standard entries alongside an enabled channel", () => {
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

test("does not register provider overlay when tool registration fails", () => {
  const h = pluginHarness();
  h.pi.registerTool = () => {
    throw new Error("Tool registration explosion");
  };
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: h.adapter as any,
  });

  expect(h.providers.length).toBe(0);
  const statusCmd = h.pi.commands.get("native-web-search");
  expect(statusCmd).toBeDefined();
});

test("aborts nested search immediately if caller signal is already aborted", async () => {
  const h = pluginHarness();
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: h.adapter as any,
  });

  const tool = h.tools.find((t: any) => t.name === "web_search");
  const controller = new AbortController();
  controller.abort();

  await expect(tool.execute("call-1", { query: "test" }, controller.signal, undefined, toolContext(model, authRegistry())))
    .rejects.toThrow("web_search aborted");
});

test("normalizes whitespace-only modelPrefix to empty string", () => {
  const normalized = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "   ",
      enabled: true,
    }],
  });
  expect(normalized.channels[0].modelPrefix).toBe("");
});

test("aborts nested search if authentication blocks and caller aborts", async () => {
  const h = pluginHarness();
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: h.adapter as any,
  });

  const tool = h.tools.find((t: any) => t.name === "web_search");
  const controller = new AbortController();
  const blockingRegistry = {
    getApiKeyAndHeaders: () => new Promise<any>(() => {}),
  };

  const executePromise = tool.execute(
    "call-1",
    { query: "test" },
    controller.signal,
    undefined,
    toolContext(model, blockingRegistry),
  );
  controller.abort();

  await expect(executePromise).rejects.toThrow("web_search aborted");
});

test("times out nested search if authentication blocks and timeout expires", async () => {
  const h = pluginHarness();
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(
    h.pi,
    channelConfig,
    "/tmp/config",
    { codex: h.adapter as any },
    { timeoutMs: 15 },
  );

  const tool = h.tools.find((t: any) => t.name === "web_search");
  const blockingRegistry = {
    getApiKeyAndHeaders: () => new Promise<any>(() => {}),
  };

  await expect(
    tool.execute(
      "call-1",
      { query: "test" },
      undefined,
      undefined,
      toolContext(model, blockingRegistry),
    ),
  ).rejects.toThrow("web_search request timed out after 15 ms");
});

test("aborts nested search if stream.result blocks and caller aborts", async () => {
  const h = pluginHarness();
  const blockingAdapter = () => ({
    result: () => new Promise<any>(() => {}),
  });
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: blockingAdapter as any,
  });

  const tool = h.tools.find((t: any) => t.name === "web_search");
  const controller = new AbortController();

  const executePromise = tool.execute(
    "call-1",
    { query: "test" },
    controller.signal,
    undefined,
    toolContext(model, authRegistry()),
  );
  controller.abort();

  await expect(executePromise).rejects.toThrow("web_search aborted");
});

test("times out nested search if stream.result blocks and timeout expires", async () => {
  const h = pluginHarness();
  const blockingAdapter = () => ({
    result: () => new Promise<any>(() => {}),
  });
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(
    h.pi,
    channelConfig,
    "/tmp/config",
    { codex: blockingAdapter as any },
    { timeoutMs: 15 },
  );

  const tool = h.tools.find((t: any) => t.name === "web_search");

  await expect(
    tool.execute(
      "call-1",
      { query: "test" },
      undefined,
      undefined,
      toolContext(model, authRegistry()),
    ),
  ).rejects.toThrow("web_search request timed out after 15 ms");
});

test("maps underlying AbortError to caller abort error when caller aborts", async () => {
  const h = pluginHarness();
  const rejectingAdapter = (_model: any, _context: any, options: any) => ({
    result: () =>
      new Promise<any>((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }),
  });
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: rejectingAdapter as any,
  });

  const tool = h.tools.find((t: any) => t.name === "web_search");
  const controller = new AbortController();

  const executePromise = tool.execute(
    "call-1",
    { query: "test" },
    controller.signal,
    undefined,
    toolContext(model, authRegistry()),
  );
  controller.abort();

  await expect(executePromise).rejects.toThrow("web_search aborted");
});

test("maps underlying AbortError to timeout error when timeout expires", async () => {
  const h = pluginHarness();
  const rejectingAdapter = (_model: any, _context: any, options: any) => ({
    result: () =>
      new Promise<any>((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }),
  });
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(
    h.pi,
    channelConfig,
    "/tmp/config",
    { codex: rejectingAdapter as any },
    { timeoutMs: 15 },
  );

  const tool = h.tools.find((t: any) => t.name === "web_search");

  await expect(
    tool.execute(
      "call-1",
      { query: "test" },
      undefined,
      undefined,
      toolContext(model, authRegistry()),
    ),
  ).rejects.toThrow("web_search request timed out after 15 ms");
});

test("preserves non-cancellation rejection from underlying adapter", async () => {
  const h = pluginHarness();
  const failingAdapter = () => ({
    result: () => Promise.reject(new Error("network failure")),
  });
  const channelConfig = normalizeConfig({
    channels: [{
      provider: "codex",
      endpoint: "codex",
      modelPrefix: "gpt-",
      enabled: true,
    }],
  });
  installNativeResponsesWebSearch(h.pi, channelConfig, "/tmp/config", {
    codex: failingAdapter as any,
  });

  const tool = h.tools.find((t: any) => t.name === "web_search");

  await expect(
    tool.execute(
      "call-1",
      { query: "test" },
      undefined,
      undefined,
      toolContext(model, authRegistry()),
    ),
  ).rejects.toThrow("network failure");
});

