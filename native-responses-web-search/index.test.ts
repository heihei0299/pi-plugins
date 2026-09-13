import { expect, test } from "bun:test";
import {
  augmentPayloadForModel,
  formatStatus,
  installStandardResponsesWebSearch,
  normalizeConfig,
} from "./index.ts";

type Handler = (event: any, ctx: any) => unknown;

function createPi() {
  const handlers = new Map<string, Handler>();
  const providers: Array<{ name: string; config: unknown }> = [];
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

const enabledConfig = normalizeConfig({
  channels: [
    { provider: "openai", modelPrefix: "gpt-", enabled: true },
  ],
});

const standardModel = {
  provider: "openai",
  id: "gpt-4.1",
  api: "openai-responses",
};

async function runPayload(payload: unknown, model = standardModel) {
  const pi = createPi();
  installStandardResponsesWebSearch(pi as any, enabledConfig, "/tmp/config.json");
  return pi.handlers.get("before_provider_request")?.(
    { type: "before_provider_request", payload },
    { model },
  );
}

test("keeps the plugin and channels opt-in by default", () => {
  const pi = createPi();
  installStandardResponsesWebSearch(pi as any, normalizeConfig({}));

  expect(pi.providers).toEqual([]);
  expect(pi.handlers.has("before_provider_request")).toBe(false);
  expect(pi.commands.has("native-web-search")).toBe(true);
});

test("registers an existing provider without replacing its models or auth", () => {
  const pi = createPi();
  installStandardResponsesWebSearch(pi as any, enabledConfig);

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

  const result = await runPayload(payload);

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

  const result = await runPayload(payload);

  expect(result).toEqual({
    ...payload,
    tools: [{ type: "web_search_preview" }],
  });
});

test("does not add search when tool choice is none", async () => {
  const stringChoice = await runPayload({
    model: "gpt-4.1",
    input: "no tools",
    tool_choice: "none",
  });
  const objectChoice = await runPayload({
    model: "gpt-4.1",
    input: "no tools",
    tool_choice: { type: "none" },
  });

  expect(stringChoice).toBeUndefined();
  expect(objectChoice).toBeUndefined();
});

test("does not affect other providers, APIs, or model prefixes", async () => {
  const otherProvider = await runPayload({ input: "hello" }, {
    provider: "anthropic",
    id: "claude-sonnet",
    api: "anthropic-messages",
  });
  const otherApi = await runPayload({ input: "hello" }, {
    provider: "openai",
    id: "gpt-4.1",
    api: "openai-completions",
  });
  const otherPrefix = await runPayload({ input: "hello" }, {
    provider: "openai",
    id: "o3-mini",
    api: "openai-responses",
  });

  expect(otherProvider).toBeUndefined();
  expect(otherApi).toBeUndefined();
  expect(otherPrefix).toBeUndefined();
});

test("does not duplicate an existing native web search declaration", async () => {
  const result = await runPayload({
    input: "already enabled",
    tools: [
      { type: "function", name: "read" },
      { type: "web_search_preview" },
    ],
  });

  expect(result).toBeUndefined();
});

test("reports the configured channel and current match state", async () => {
  const pi = createPi();
  installStandardResponsesWebSearch(pi as any, enabledConfig, "/tmp/config.json");
  const notifications: string[] = [];

  await pi.commands.get("native-web-search")?.handler("", {
    model: standardModel,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });

  expect(notifications[0]).toContain(
    "openai/gpt- -> Standard Responses -> enabled; model matches",
  );
  expect(notifications[0]).toContain("config: /tmp/config.json");
});

test("rejects malformed or duplicate enabled channel configuration", () => {
  expect(() => normalizeConfig({ channels: "openai" })).toThrow(
    "config.channels must be an array",
  );
  expect(() => normalizeConfig({
    channels: [
      { provider: "openai", enabled: true },
      { provider: "openai", enabled: true },
    ],
  })).toThrow("duplicate enabled provider");
});

test("payload augmentation is a no-op for an unsupported payload", () => {
  expect(augmentPayloadForModel(null, standardModel, enabledConfig.channels)).toBeNull();
  expect(augmentPayloadForModel({ tools: "not-an-array" }, standardModel, enabledConfig.channels))
    .toEqual({ tools: "not-an-array" });
});

test("status reports an incompatible model API", () => {
  const status = formatStatus(enabledConfig, {
    provider: "openai",
    id: "gpt-4.1",
    api: "openai-completions",
  });

  expect(status).toContain("unavailable; model is not Standard Responses");
});
