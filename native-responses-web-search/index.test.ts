import { expect, test } from "bun:test";
import {
  augmentPayloadForModel,
  formatStatus,
  installNativeResponsesWebSearch,
  normalizeConfig,
} from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function createPi() {
  const handlers = new Map<string, Handler>();
  const providers: Array<{ name: string; config: any }> = [];
  const commands = new Map<string, { handler: Handler }>();

  return {
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

async function runStandardPayload(payload: unknown, model = standardModel) {
  const pi = createPi();
  installNativeResponsesWebSearch(pi as any, standardConfig, "/tmp/config.json");
  return pi.handlers.get("before_provider_request")?.(
    { type: "before_provider_request", payload },
    { model },
  );
}

test("keeps the plugin and channels opt-in by default", () => {
  const pi = createPi();
  installNativeResponsesWebSearch(pi as any, normalizeConfig({}));

  expect(pi.providers).toEqual([]);
  expect(pi.handlers.has("before_provider_request")).toBe(false);
  expect(pi.commands.has("native-web-search")).toBe(true);
});

test("requires explicit opt-in for a configured channel", () => {
  const pi = createPi();
  installNativeResponsesWebSearch(pi as any, normalizeConfig({
    channels: [{ provider: "openai" }],
  }));

  expect(pi.providers).toEqual([]);
});

test("registers a Standard provider without replacing its models or auth", () => {
  const pi = createPi();
  installNativeResponsesWebSearch(pi as any, standardConfig);

  expect(pi.providers).toEqual([
    { name: "openai", config: { api: "openai-responses" } },
  ]);
});

test("adds the minimal Standard Responses hosted search tool", async () => {
  const payload = {
    model: "gpt-4.1",
    input: [{ role: "user", content: "What changed today?" }],
    tools: [{ type: "function", name: "read" }],
    temperature: 0,
  };

  const result = await runStandardPayload(payload);

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
    temperature: 0,
    metadata: { requestSource: "existing-extension" },
  };

  const result = await runStandardPayload(payload);

  expect(result).toEqual({
    ...payload,
    tools: [{ type: "web_search_preview" }],
  });
});

test("does not add Standard search when tool choice is none", async () => {
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

  expect(stringChoice).toBeUndefined();
  expect(objectChoice).toBeUndefined();
});

test("does not affect other providers, APIs, or model prefixes", async () => {
  const otherProvider = await runStandardPayload({ input: "hello" }, {
    provider: "anthropic",
    id: "claude-sonnet",
    api: "anthropic-messages",
  });
  const otherApi = await runStandardPayload({ input: "hello" }, {
    provider: "openai",
    id: "gpt-4.1",
    api: "openai-completions",
  });
  const otherPrefix = await runStandardPayload({ input: "hello" }, {
    provider: "openai",
    id: "o3-mini",
    api: "openai-responses",
  });

  expect(otherProvider).toBeUndefined();
  expect(otherApi).toBeUndefined();
  expect(otherPrefix).toBeUndefined();
});

test("does not duplicate an existing native web search declaration", async () => {
  const result = await runStandardPayload({
    input: "already enabled",
    tools: [
      { type: "function", name: "read" },
      { type: "web_search_preview" },
    ],
  });

  expect(result).toBeUndefined();
});

test("registers a Codex provider with its configured transport", () => {
  const pi = createPi();
  const codexStream = (() => ({}) as any) as any;
  installNativeResponsesWebSearch(
    pi as any,
    codexConfig,
    "/tmp/config.json",
    codexStream,
  );

  expect(pi.providers).toHaveLength(1);
  expect(pi.providers[0].name).toBe("codex-channel");
  expect(pi.providers[0].config.api).toBe("openai-codex-responses");
  expect(pi.providers[0].config.streamSimple).toBeFunction();
  expect(pi.handlers.has("before_provider_request")).toBe(false);
});

test("Codex composes the existing payload callback and keeps its response callback", async () => {
  const pi = createPi();
  let capturedOptions: any;
  let callbackCalls = 0;
  const codexStream = (_model: unknown, _context: unknown, options: unknown) => {
    capturedOptions = options;
    return {} as any;
  };
  const onResponse = () => {};
  installNativeResponsesWebSearch(
    pi as any,
    codexConfig,
    "/tmp/config.json",
    codexStream as any,
  );

  const providerConfig = pi.providers[0].config;
  providerConfig.streamSimple(codexModel, {}, {
    transport: "sse",
    onResponse,
    onPayload: async (payload: any) => {
      callbackCalls += 1;
      return { ...payload, temperature: 0 };
    },
  });

  const result = await capturedOptions.onPayload(
    { input: "latest news", tools: [{ type: "function", name: "read" }] },
    codexModel,
  );

  expect(callbackCalls).toBe(1);
  expect(capturedOptions.transport).toBe("websocket");
  expect(capturedOptions.onResponse).toBe(onResponse);
  expect(result).toEqual({
    input: "latest news",
    temperature: 0,
    tools: [
      { type: "function", name: "read" },
      { type: "web_search" },
    ],
  });
});

test("rejects a Codex model that does not match the configured prefix", () => {
  const pi = createPi();
  const codexStream = (() => ({}) as any) as any;
  installNativeResponsesWebSearch(
    pi as any,
    codexConfig,
    "/tmp/config.json",
    codexStream,
  );

  expect(() => pi.providers[0].config.streamSimple({
    ...codexModel,
    id: "o3-mini",
  }, {}, {})).toThrow("does not match");
});

test("passes every supported Codex transport without URL inference", () => {
  for (const transport of ["sse", "websocket", "websocket-cached", "auto"] as const) {
    const provider = `codex-${transport}`;
    const config = normalizeConfig({
      channels: [{ provider, endpoint: "codex", enabled: true, transport }],
    });
    const pi = createPi();
    let capturedOptions: any;
    const codexStream = (_model: unknown, _context: unknown, options: unknown) => {
      capturedOptions = options;
      return {} as any;
    };
    installNativeResponsesWebSearch(pi as any, config, "/tmp/config.json", codexStream as any);

    pi.providers[0].config.streamSimple({
      provider,
      id: "gpt-5-codex",
      api: "openai-codex-responses",
    }, {}, {});

    expect(capturedOptions.transport).toBe(transport);
  }
});

test("uses the top-level Codex transport when a channel omits its override", () => {
  const config = normalizeConfig({
    transport: "sse",
    channels: [{ provider: "codex-default", endpoint: "codex", enabled: true }],
  });
  const pi = createPi();
  let capturedOptions: any;
  const codexStream = (_model: unknown, _context: unknown, options: unknown) => {
    capturedOptions = options;
    return {} as any;
  };
  installNativeResponsesWebSearch(pi as any, config, "/tmp/config.json", codexStream as any);

  pi.providers[0].config.streamSimple({
    provider: "codex-default",
    id: "gpt-5-codex",
    api: "openai-codex-responses",
  }, {}, {});

  expect(config.channels[0].transport).toBe("sse");
  expect(capturedOptions.transport).toBe("sse");
  expect(normalizeConfig({
    channels: [{ provider: "codex-auto", endpoint: "codex", enabled: true }],
  }).channels[0].transport).toBe("auto");
});

test("Codex does not add search when tool choice is none", async () => {
  const pi = createPi();
  let capturedOptions: any;
  const codexStream = (_model: unknown, _context: unknown, options: unknown) => {
    capturedOptions = options;
    return {} as any;
  };
  installNativeResponsesWebSearch(pi as any, codexConfig, "/tmp/config.json", codexStream as any);

  pi.providers[0].config.streamSimple(codexModel, {}, {
    onPayload: async (payload: any) => ({ ...payload, tool_choice: "none" }),
  });

  const result = await capturedOptions.onPayload({ input: "no tools" }, codexModel);
  expect(result).toEqual({ input: "no tools", tool_choice: "none" });
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

test("reports the configured endpoint, transport, and current match state", async () => {
  const pi = createPi();
  installNativeResponsesWebSearch(pi as any, codexConfig, "/tmp/config.json", (() => ({})) as any);
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
});

test("payload augmentation is a no-op for an unsupported payload", () => {
  expect(augmentPayloadForModel(null, standardModel, standardConfig.channels)).toBeNull();
  expect(augmentPayloadForModel(
    { tools: "not-an-array" },
    standardModel,
    standardConfig.channels,
  )).toEqual({ tools: "not-an-array" });
});

test("status reports an incompatible model API", () => {
  const status = formatStatus(standardConfig, {
    provider: "openai",
    id: "gpt-4.1",
    api: "openai-completions",
  });

  expect(status).toContain("unavailable; model is not Standard Responses");
});
