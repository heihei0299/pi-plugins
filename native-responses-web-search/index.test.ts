import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  augmentPayloadForModel,
  formatStatus,
  installNativeResponsesWebSearch,
  loadConfig,
  normalizeConfig,
} from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function createPi(activeTools: string[] = [], withToolInspection = true) {
  const handlers = new Map<string, Handler>();
  const providers: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, { handler: Handler }>();
  const pi: any = {
    handlers,
    providers,
    commands,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerProvider(name: string, config: unknown) {
      providers.push({ name, config });
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
  };
  if (withToolInspection) {
    pi.getActiveTools = () => activeTools;
  }
  return pi;
}

function nativeAdapter(capture: { options?: any }) {
  return (_model: unknown, _context: unknown, options: unknown) => {
    capture.options = options;
    return { type: "fake-stream" } as any;
  };
}

function confirmProviderOwnership(pi: any) {
  const providerConfig = pi.providers[0]?.config;
  pi.handlers.get("session_start")?.({}, {
    modelRegistry: {
      getRegisteredProviderConfig: () => providerConfig,
    },
  });
}

const standardConfig = normalizeConfig({
  channels: [
    { provider: "openai", modelPrefix: "gpt-", enabled: true },
  ],
});

const codexConfig = normalizeConfig({
  transport: "sse",
  channels: [
    {
      provider: "codex-channel",
      endpoint: "codex",
      modelPrefix: "gpt-",
      transport: "websocket",
      enabled: true,
    },
  ],
});

const standardModel = {
  provider: "openai",
  id: "gpt-4.1",
  api: "openai-responses",
};

const codexModel = {
  provider: "codex-channel",
  id: "gpt-5-codex",
  api: "openai-codex-responses",
};

async function runStandardPayload(
  payload: unknown,
  model = standardModel,
  activeTools: string[] = [],
  onPayload: ((payload: unknown, model: unknown) => unknown) | undefined = async () => undefined,
) {
  const pi = createPi(activeTools);
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  const stream = pi.providers[0].config.streamSimple(model, {}, { onPayload });
  const result = await capture.options.onPayload(payload, model);
  return { pi, capture, result, stream };
}

test("keeps the plugin and channels opt-in by default", () => {
  const pi = createPi();
  installNativeResponsesWebSearch(pi, normalizeConfig({}));

  expect(pi.providers).toEqual([]);
  expect(pi.commands.has("native-web-search")).toBe(true);
});

test("requires explicit opt-in for a configured channel", () => {
  const pi = createPi();
  installNativeResponsesWebSearch(pi, normalizeConfig({
    channels: [{ provider: "openai" }],
  }));

  expect(pi.providers).toEqual([]);
});

test("reload reads the current config instead of carrying the previous channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-responses-web-search-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify({
      channels: [{ provider: "openai", endpoint: "standard", enabled: true }],
    }));
    const first = await loadConfig(path);

    await writeFile(path, JSON.stringify({
      channels: [{
        provider: "codex-channel",
        endpoint: "codex",
        transport: "sse",
        enabled: true,
      }],
    }));
    const second = await loadConfig(path);

    expect(first.channels[0].provider).toBe("openai");
    expect(second.channels[0].provider).toBe("codex-channel");
    expect(second.channels[0].endpoint).toBe("codex");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when another provider shim replaces the channel owner", () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );

  pi.handlers.get("session_start")?.({}, {
    modelRegistry: {
      getRegisteredProviderConfig: () => ({
        api: "openai-responses",
        streamSimple: () => ({ type: "other-shim" }),
      }),
    },
  });

  expect(() => pi.providers[0].config.streamSimple(standardModel, {}, {
    onPayload: async () => undefined,
  })).toThrow("Dedicated Provider Conflict");
});

test("does not send until provider ownership is confirmed", () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );

  expect(() => pi.providers[0].config.streamSimple(standardModel, {}, {
    onPayload: async () => undefined,
  })).toThrow("Dedicated Provider Conflict");
});

test("rejects a Standard model that does not match the configured prefix", () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);

  expect(() => pi.providers[0].config.streamSimple({
    ...standardModel,
    id: "o3-mini",
  }, {}, {
    onPayload: async () => undefined,
  })).toThrow("does not match");
});

test("registers a Standard provider without replacing its models or auth", () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );

  expect(pi.providers).toHaveLength(1);
  expect(pi.providers[0].name).toBe("openai");
  expect(pi.providers[0].config.api).toBe("openai-responses");
  expect(pi.providers[0].config.streamSimple).toBeFunction();
});

test("adds the minimal Standard Responses hosted search tool", async () => {
  const payload = {
    model: "gpt-4.1",
    input: [{ role: "user", content: "What changed today?" }],
    tools: [{ type: "function", name: "read" }],
    temperature: 0,
  };

  const { result } = await runStandardPayload(payload);

  expect(result).toEqual({
    ...payload,
    tools: [
      { type: "function", name: "read" },
      { type: "web_search_preview" },
    ],
  });
  expect(payload.tools).toEqual([{ type: "function", name: "read" }]);
});

test("preserves payload changes made by an earlier payload callback", async () => {
  const payload = {
    model: "gpt-4.1",
    input: "latest news",
    metadata: { requestSource: "existing-extension" },
  };

  const { result } = await runStandardPayload(
    payload,
    standardModel,
    [],
    async (current) => ({ ...current as any, temperature: 0 }),
  );

  expect(result).toEqual({
    ...payload,
    temperature: 0,
    tools: [{ type: "web_search_preview" }],
  });
});

test("does not add search when tool choice is none", async () => {
  const stringChoice = await runStandardPayload({
    model: "gpt-4.1",
    input: "no tools",
    tool_choice: "none",
  });
  const objectChoice = await runStandardPayload({
    model: "gpt-4.1",
    input: "no tools",
    tool_choice: { type: "none" },
  });

  expect(stringChoice.result).toEqual({
    model: "gpt-4.1",
    input: "no tools",
    tool_choice: "none",
  });
  expect(objectChoice.result).toEqual({
    model: "gpt-4.1",
    input: "no tools",
    tool_choice: { type: "none" },
  });
});

test("does not add capability for other providers, APIs, or model prefixes", () => {
  expect(augmentPayloadForModel(
    { input: "hello" },
    { provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages" },
    standardConfig.channels,
  )).toEqual({ input: "hello" });
  expect(augmentPayloadForModel(
    { input: "hello" },
    { provider: "openai", id: "gpt-4.1", api: "openai-completions" },
    standardConfig.channels,
  )).toEqual({ input: "hello" });
  expect(augmentPayloadForModel(
    { input: "hello" },
    { provider: "openai", id: "o3-mini", api: "openai-responses" },
    standardConfig.channels,
  )).toEqual({ input: "hello" });
});

test("does not duplicate an existing native web search declaration", async () => {
  const payload = {
    input: "already enabled",
    tools: [
      { type: "function", name: "read" },
      { type: "web_search_preview" },
    ],
  };
  const { result } = await runStandardPayload(payload);

  expect(result).toEqual(payload);
});

test("fails closed when a local web_search tool is active", async () => {
  const pi = createPi(["read", "web_search"]);
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  pi.providers[0].config.streamSimple(standardModel, {}, {
    onPayload: async () => undefined,
  });

  await expect(capture.options.onPayload({ input: "search" }, standardModel))
    .rejects.toThrow("Capability Conflict");
});

test("rejects a runtime without active-tool inspection", () => {
  const pi = createPi([], false);
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );

  expect(pi.providers).toEqual([]);
  expect(pi.commands.has("native-web-search")).toBe(true);
});

test("rejects a runtime without the provider payload callback", async () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  expect(() => pi.providers[0].config.streamSimple(standardModel, {}, {}))
    .toThrow("provider payload callback is required");
});

test("status reports a missing payload callback after a failed runtime check", async () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  expect(() => pi.providers[0].config.streamSimple(standardModel, {}, {}))
    .toThrow("provider payload callback is required");

  const notifications: string[] = [];
  await pi.commands.get("native-web-search")?.handler("", {
    model: standardModel,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });
  expect(notifications[0]).toContain("runtime payload callback is missing");
});

test("reports a clear error when the endpoint rejects hosted search", async () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    standardConfig,
    "/tmp/config.json",
    { standard: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  pi.providers[0].config.streamSimple(standardModel, {}, {
    onPayload: async () => undefined,
  });

  await expect(capture.options.onResponse({ status: 403, headers: {} }, standardModel))
    .rejects.toThrow("standard Responses endpoint rejected hosted web search (HTTP 403)");
});

test("registers a Codex provider with its configured transport", () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    codexConfig,
    "/tmp/config.json",
    { codex: nativeAdapter(capture) as any },
  );

  expect(pi.providers).toHaveLength(1);
  expect(pi.providers[0].name).toBe("codex-channel");
  expect(pi.providers[0].config.api).toBe("openai-codex-responses");
  expect(pi.providers[0].config.streamSimple).toBeFunction();
});

test("Codex composes existing callbacks and keeps the endpoint text path untouched", async () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  let payloadCallbackCalls = 0;
  let responseCallbackCalls = 0;
  const onResponse = () => {
    responseCallbackCalls += 1;
  };
  installNativeResponsesWebSearch(
    pi,
    codexConfig,
    "/tmp/config.json",
    { codex: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);

  const stream = pi.providers[0].config.streamSimple(codexModel, {}, {
    transport: "sse",
    onResponse,
    onPayload: async (payload: any) => {
      payloadCallbackCalls += 1;
      return { ...payload, temperature: 0 };
    },
  });
  const result = await capture.options.onPayload(
    { input: "latest news", tools: [{ type: "function", name: "read" }] },
    codexModel,
  );
  await capture.options.onResponse({ status: 200, headers: {} }, codexModel);

  expect(stream).toEqual({ type: "fake-stream" });
  expect(payloadCallbackCalls).toBe(1);
  expect(responseCallbackCalls).toBe(1);
  expect(capture.options.transport).toBe("websocket");
  expect(result).toEqual({
    input: "latest news",
    temperature: 0,
    tools: [
      { type: "function", name: "read" },
      { type: "web_search" },
    ],
  });
});

test("Codex does not add search when tool choice is none", async () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    codexConfig,
    "/tmp/config.json",
    { codex: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  pi.providers[0].config.streamSimple(codexModel, {}, {
    onPayload: async (payload: any) => ({ ...payload, tool_choice: "none" }),
  });

  const result = await capture.options.onPayload({ input: "no tools" }, codexModel);
  expect(result).toEqual({ input: "no tools", tool_choice: "none" });
});

test("rejects a Codex model that does not match the configured prefix", () => {
  const pi = createPi();
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    codexConfig,
    "/tmp/config.json",
    { codex: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  const nonMatchingModel = { ...codexModel, id: "o3-mini" };

  expect(() => pi.providers[0].config.streamSimple(nonMatchingModel, {}, {
    onPayload: async () => undefined,
  })).toThrow("does not match");
});

test("selects the correct endpoint-specific declaration", () => {
  expect(augmentPayloadForModel(
    { input: "standard" },
    standardModel,
    standardConfig.channels,
  )).toEqual({ input: "standard", tools: [{ type: "web_search_preview" }] });
  expect(augmentPayloadForModel(
    { input: "codex" },
    codexModel,
    codexConfig.channels,
  )).toEqual({ input: "codex", tools: [{ type: "web_search" }] });
});

test("passes every supported Codex transport without URL inference", () => {
  for (const transport of ["sse", "websocket", "websocket-cached", "auto"] as const) {
    const provider = `codex-${transport}`;
    const config = normalizeConfig({
      channels: [{ provider, endpoint: "codex", enabled: true, transport }],
    });
    const pi = createPi();
    const capture: { options?: any } = {};
    installNativeResponsesWebSearch(
      pi,
      config,
      "/tmp/config.json",
      { codex: nativeAdapter(capture) as any },
    );
    confirmProviderOwnership(pi);

    pi.providers[0].config.streamSimple({
      provider,
      id: "gpt-5-codex",
      api: "openai-codex-responses",
    }, {}, { onPayload: async () => undefined });

    expect(capture.options.transport).toBe(transport);
  }
});

test("reports the configured endpoint, transport, and current match state", async () => {
  const pi = createPi(["read"]);
  const capture: { options?: any } = {};
  installNativeResponsesWebSearch(
    pi,
    codexConfig,
    "/tmp/config.json",
    { codex: nativeAdapter(capture) as any },
  );
  confirmProviderOwnership(pi);
  const notifications: string[] = [];

  await pi.commands.get("native-web-search")?.handler("", {
    model: codexModel,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });

  expect(notifications[0]).toContain(
    "codex-channel/gpt- -> Codex Responses (websocket) -> enabled; model matches",
  );
  expect(notifications[0]).toContain("config: /tmp/config.json");
});

test("status distinguishes a capability conflict and an incompatible endpoint", () => {
  const conflict = formatStatus(
    standardConfig,
    standardModel,
    "/tmp/config.json",
    ["web_search"],
    {
      payloadCallback: "available",
      activeTools: "available",
      providerOwnership: "available",
    },
  );
  const incompatible = formatStatus(
    standardConfig,
    {
      provider: "openai",
      id: "gpt-4.1",
      api: "openai-completions",
    },
    "/tmp/config.json",
    [],
    {
      payloadCallback: "available",
      activeTools: "available",
      providerOwnership: "available",
    },
  );

  expect(conflict).toContain("Capability Conflict");
  expect(incompatible).toContain("not Standard Responses");
});

test("rejects malformed, unsupported, or duplicate enabled channel configuration", () => {
  expect(() => normalizeConfig({ channels: "openai" })).toThrow(
    "config.channels must be an array",
  );
  expect(() => normalizeConfig({
    channels: [{ provider: "openai", endpoint: "other" }],
  })).toThrow("endpoint must be \"standard\" or \"codex\"");
  expect(() => normalizeConfig({
    channels: [{ provider: "openai", transport: "udp" }],
  })).toThrow("transport must be one of");
  expect(() => normalizeConfig({
    channels: [
      { provider: "openai", enabled: true },
      { provider: "openai", enabled: true },
    ],
  })).toThrow("duplicate enabled provider");
  expect(() => normalizeConfig({
    channels: [
      { provider: "openai", enabled: true },
      { provider: "codex", endpoint: "codex", enabled: true },
    ],
  })).toThrow("one enabled Dedicated Provider Channel");
});

test("does not synthesize source data or rewrite endpoint text", async () => {
  const payload = { input: "plain assistant text", metadata: { keep: true } };
  const { result } = await runStandardPayload(payload);

  expect(result).toEqual({
    input: "plain assistant text",
    metadata: { keep: true },
    tools: [{ type: "web_search_preview" }],
  });
  expect(result).not.toHaveProperty("sources");
  expect(result).not.toHaveProperty("search_results");
});

test("payload augmentation is a no-op for an unsupported payload", () => {
  expect(augmentPayloadForModel(null, standardModel, standardConfig.channels)).toBeNull();
  expect(augmentPayloadForModel(
    { tools: "not-an-array" },
    standardModel,
    standardConfig.channels,
  )).toEqual({ tools: "not-an-array" });
});
