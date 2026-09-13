import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ResponsesEndpoint = "standard" | "codex";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type NativeStreamSimple = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface WebSearchChannelConfig {
  /** Existing Pi provider/channel id reserved for this plugin. */
  provider: string;
  /** Responses endpoint used by this channel. Default: standard. */
  endpoint?: ResponsesEndpoint;
  /** Only models with this prefix use native web search. Empty means all models. */
  modelPrefix?: string;
  /** Must be explicitly true to opt in this channel. */
  enabled?: boolean;
  /** Codex transport. Standard Responses ignores this value. */
  transport?: Transport;
}

export interface PluginConfig {
  /** Master switch. Default: true; channels still require enabled: true. */
  enabled?: boolean;
  /** Default Codex transport when a channel does not set one. */
  transport?: Transport;
  channels?: WebSearchChannelConfig[];
}

export interface NormalizedWebSearchChannel {
  provider: string;
  endpoint: ResponsesEndpoint;
  modelPrefix: string;
  enabled: boolean;
  transport: Transport;
}

export interface NormalizedPluginConfig {
  enabled: boolean;
  transport: Transport;
  channels: NormalizedWebSearchChannel[];
}

export interface ModelIdentity {
  provider?: string;
  id?: string;
  api?: string;
}

export type RuntimeCapabilityState = "unknown" | "available" | "unavailable";

export interface RuntimeStatus {
  payloadCallback: RuntimeCapabilityState;
  activeTools: RuntimeCapabilityState;
}

export interface StreamAdapters {
  standard?: NativeStreamSimple;
  codex?: NativeStreamSimple;
}

const CONFIG_PATH =
  process.env.PI_NATIVE_RESPONSES_WEB_SEARCH_CONFIG ||
  join(homedir(), ".pi", "agent", "native-responses-web-search.json");

export const DEFAULT_CONFIG: NormalizedPluginConfig = {
  enabled: true,
  transport: "auto",
  channels: [],
};

const STANDARD_RESPONSES_API = "openai-responses" as const;
const CODEX_RESPONSES_API = "openai-codex-responses" as const;
const STANDARD_WEB_SEARCH_TOOL = { type: "web_search_preview" } as const;
const CODEX_WEB_SEARCH_TOOL = { type: "web_search" } as const;
const NATIVE_WEB_SEARCH_TYPES = new Set([
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11",
]);
const TRANSPORTS = new Set<Transport>([
  "sse",
  "websocket",
  "websocket-cached",
  "auto",
]);
const DEFAULT_RUNTIME_STATUS: RuntimeStatus = {
  payloadCallback: "unknown",
  activeTools: "unknown",
};

type JsonObject = Record<string, unknown>;

type PluginAPI = Pick<
  ExtensionAPI,
  "getActiveTools" | "registerCommand" | "registerProvider"
>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function readEndpoint(
  value: unknown,
  fallback: ResponsesEndpoint,
  label: string,
): ResponsesEndpoint {
  if (value === undefined) return fallback;
  if (value === "standard" || value === "codex") return value;
  throw new Error(`${label} must be "standard" or "codex"`);
}

function readTransport(value: unknown, fallback: Transport, label: string): Transport {
  if (value === undefined) return fallback;
  if (typeof value === "string" && TRANSPORTS.has(value as Transport)) {
    return value as Transport;
  }
  throw new Error(
    `${label} must be one of sse, websocket, websocket-cached, or auto`,
  );
}

export function normalizeConfig(value: unknown): NormalizedPluginConfig {
  if (!isObject(value)) {
    throw new Error("native-responses-web-search config must be a JSON object");
  }

  const enabled = readBoolean(value.enabled, true, "config.enabled");
  const transport = readTransport(value.transport, "auto", "config.transport");
  const rawChannels = value.channels;
  if (rawChannels !== undefined && !Array.isArray(rawChannels)) {
    throw new Error("config.channels must be an array");
  }

  const channels = (rawChannels ?? []).map((rawChannel, index) => {
    if (!isObject(rawChannel)) {
      throw new Error(`config.channels[${index}] must be an object`);
    }

    const provider = rawChannel.provider;
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new Error(`config.channels[${index}].provider must be a non-empty string`);
    }

    const modelPrefix = rawChannel.modelPrefix;
    if (modelPrefix !== undefined && typeof modelPrefix !== "string") {
      throw new Error(`config.channels[${index}].modelPrefix must be a string`);
    }

    return {
      provider: provider.trim(),
      endpoint: readEndpoint(
        rawChannel.endpoint,
        "standard",
        `config.channels[${index}].endpoint`,
      ),
      modelPrefix: modelPrefix ?? "",
      enabled: readBoolean(
        rawChannel.enabled,
        false,
        `config.channels[${index}].enabled`,
      ),
      transport: readTransport(
        rawChannel.transport,
        transport,
        `config.channels[${index}].transport`,
      ),
    } satisfies NormalizedWebSearchChannel;
  });

  const activeProviders = new Set<string>();
  for (const channel of channels) {
    if (!channel.enabled) continue;
    if (activeProviders.has(channel.provider)) {
      throw new Error(
        `config.channels contains duplicate enabled provider ${JSON.stringify(channel.provider)}`,
      );
    }
    if (activeProviders.size > 0) {
      throw new Error(
        "config supports one enabled Dedicated Provider Channel at a time",
      );
    }
    activeProviders.add(channel.provider);
  }

  return { enabled, transport, channels };
}

export async function loadConfig(
  path = CONFIG_PATH,
): Promise<NormalizedPluginConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return normalizeConfig(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }
}

export function getActiveChannels(
  config: NormalizedPluginConfig,
): NormalizedWebSearchChannel[] {
  if (!config.enabled) return [];
  return config.channels.filter((channel) => channel.enabled);
}

function apiForEndpoint(
  endpoint: ResponsesEndpoint,
): typeof STANDARD_RESPONSES_API | typeof CODEX_RESPONSES_API {
  return endpoint === "codex" ? CODEX_RESPONSES_API : STANDARD_RESPONSES_API;
}

export function matchesChannel(
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
): boolean {
  return (
    model?.provider === channel.provider &&
    model.api === apiForEndpoint(channel.endpoint) &&
    typeof model.id === "string" &&
    (channel.modelPrefix === "" || model.id.startsWith(channel.modelPrefix))
  );
}

function isToolChoiceNone(value: unknown): boolean {
  return value === "none" || (isObject(value) && value.type === "none");
}

function isNativeWebSearchTool(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    NATIVE_WEB_SEARCH_TYPES.has(value.type)
  );
}

/**
 * Add the endpoint-specific hosted-search declaration without mutating or
 * replacing any existing payload field.
 */
export function addNativeWebSearch(
  payload: unknown,
  endpoint: ResponsesEndpoint = "standard",
): unknown {
  if (!isObject(payload) || isToolChoiceNone(payload.tool_choice)) {
    return payload;
  }

  const currentTools = payload.tools;
  if (currentTools !== undefined && !Array.isArray(currentTools)) {
    return payload;
  }

  const tools = currentTools ?? [];
  if (tools.some(isNativeWebSearchTool)) return payload;

  return {
    ...payload,
    tools: [
      ...tools,
      endpoint === "codex"
        ? { ...CODEX_WEB_SEARCH_TOOL }
        : { ...STANDARD_WEB_SEARCH_TOOL },
    ],
  };
}

export function prepareNativePayload(
  payload: unknown,
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
  activeTools: readonly string[],
): unknown {
  if (!matchesChannel(model, channel)) return payload;
  if (!isObject(payload)) return payload;
  if (activeTools.includes("web_search")) {
    throw new Error(
      "Capability Conflict: an active local web_search tool conflicts with native hosted web search",
    );
  }
  if (isToolChoiceNone(payload.tool_choice)) return payload;
  return addNativeWebSearch(payload, channel.endpoint);
}

function currentModelStatus(
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
  globallyEnabled: boolean,
  activeTools: readonly string[],
  runtime: RuntimeStatus,
): string {
  if (!globallyEnabled || !channel.enabled) return "disabled";
  if (!model) return "enabled; no active model";
  if (model.provider !== channel.provider) return "enabled; model not selected";
  if (model.api !== apiForEndpoint(channel.endpoint)) {
    return `unavailable; model is not ${
      channel.endpoint === "codex" ? "Codex" : "Standard"
    } Responses`;
  }
  if (typeof model.id !== "string") return "enabled; model id unavailable";
  if (channel.modelPrefix && !model.id.startsWith(channel.modelPrefix)) {
    return "enabled; model prefix does not match";
  }
  if (activeTools.includes("web_search")) {
    return "unavailable; Capability Conflict with active local web_search";
  }
  if (runtime.payloadCallback === "unavailable") {
    return "unavailable; runtime payload callback is missing";
  }
  if (runtime.activeTools === "unavailable") {
    return "unavailable; runtime active-tool inspection is missing";
  }
  return runtime.payloadCallback === "unknown"
    ? "enabled; model matches (payload callback capability pending; fails closed)"
    : "enabled; model matches";
}

export function formatStatus(
  config: NormalizedPluginConfig,
  model?: ModelIdentity,
  configPath = CONFIG_PATH,
  activeTools: readonly string[] = [],
  runtime: RuntimeStatus = DEFAULT_RUNTIME_STATUS,
): string {
  const lines = [
    `Native Responses web search: ${config.enabled ? "enabled" : "disabled"}`,
    `config: ${configPath}`,
  ];

  if (config.channels.length === 0) {
    lines.push("channels: none (explicit channel opt-in required)");
    return lines.join("\n");
  }

  for (const channel of config.channels) {
    const endpoint = channel.endpoint === "codex"
      ? `Codex Responses (${channel.transport})`
      : "Standard Responses";
    lines.push(
      `${channel.provider}/${channel.modelPrefix || "*"} -> ${endpoint} -> ${currentModelStatus(model, channel, config.enabled, activeTools, runtime)}`,
    );
  }
  return lines.join("\n");
}

function getActiveToolsOrThrow(
  pi: PluginAPI,
  runtime: RuntimeStatus,
): readonly string[] {
  if (typeof pi.getActiveTools !== "function") {
    runtime.activeTools = "unavailable";
    throw new Error(
      "Runtime capability unavailable: active-tool inspection is required to detect local web_search conflicts",
    );
  }

  try {
    const activeTools = pi.getActiveTools();
    if (!Array.isArray(activeTools) || activeTools.some((name) => typeof name !== "string")) {
      runtime.activeTools = "unavailable";
      throw new Error("runtime returned an invalid active-tool list");
    }
    runtime.activeTools = "available";
    return activeTools;
  } catch (error: unknown) {
    runtime.activeTools = "unavailable";
    if (error instanceof Error && error.message.startsWith("runtime returned")) {
      throw error;
    }
    throw new Error(
      `Runtime capability unavailable: active-tool inspection failed (${String(error)})`,
    );
  }
}

function providerConfig(
  channel: NormalizedWebSearchChannel,
  nativeStream: NativeStreamSimple,
  pi: PluginAPI,
  runtime: RuntimeStatus,
) {
  const config = {
    api: apiForEndpoint(channel.endpoint),
    streamSimple: (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => {
      if (!matchesChannel(model, channel)) {
        throw new Error(
          `[native-responses-web-search] ${model.provider}/${model.id} does not match ` +
            `the configured ${channel.endpoint} channel model prefix ${JSON.stringify(channel.modelPrefix)}`,
        );
      }
      if (typeof options?.onPayload !== "function") {
        runtime.payloadCallback = "unavailable";
        throw new Error(
          "Runtime capability unavailable: provider payload callback is required for native web search",
        );
      }
      const activeTools = getActiveToolsOrThrow(pi, runtime);
      if (activeTools.includes("web_search")) {
        throw new Error(
          "Capability Conflict: an active local web_search tool conflicts with native hosted web search",
        );
      }
      const existingOnPayload = options.onPayload;

      return nativeStream(model, context, {
        ...options,
        ...(channel.endpoint === "codex"
          ? { transport: channel.transport }
          : {}),
        onPayload: async (payload, payloadModel) => {
          runtime.payloadCallback = "available";

          const existingPayload = await existingOnPayload(
            payload,
            payloadModel,
          );
          const currentPayload = existingPayload === undefined
            ? payload
            : existingPayload;
          if (!matchesChannel(payloadModel, channel)) return currentPayload;

          return prepareNativePayload(
            currentPayload,
            payloadModel,
            channel,
            getActiveToolsOrThrow(pi, runtime),
          );
        },
        onResponse: async (response, responseModel) => {
          await options?.onResponse?.(response, responseModel);
          if (response.status >= 400) {
            throw new Error(
              `[native-responses-web-search] ${channel.endpoint} Responses endpoint rejected hosted web search (HTTP ${response.status})`,
            );
          }
        },
      });
    },
  };
  return config;
}

function registerStatusCommand(
  pi: PluginAPI,
  config: NormalizedPluginConfig,
  configPath: string,
  runtime: RuntimeStatus,
  unavailableReason?: string,
): void {
  pi.registerCommand("native-web-search", {
    description: "Show native Responses web search channel status",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      let activeTools: readonly string[] = [];
      try {
        activeTools = getActiveToolsOrThrow(pi, runtime);
      } catch {
        // formatStatus reports the capability state recorded by the helper.
      }
      const status = formatStatus(
        config,
        ctx.model,
        configPath,
        activeTools,
        runtime,
      );
      ctx.ui.notify(
        unavailableReason ? `${status}\nstatus: unavailable; ${unavailableReason}` : status,
        unavailableReason ? "error" : "info",
      );
    },
  });
}

function registerConfigErrorStatus(
  pi: PluginAPI,
  configPath: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  pi.registerCommand("native-web-search", {
    description: "Show native Responses web search configuration status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          "Native Responses web search: unavailable",
          `config: ${configPath}`,
          `status: configuration error; ${message}`,
        ].join("\n"),
        "error",
      );
    },
  });
}

export function installNativeResponsesWebSearch(
  pi: PluginAPI,
  config: NormalizedPluginConfig,
  configPath = CONFIG_PATH,
  adapters: StreamAdapters = {},
): void {
  const runtime: RuntimeStatus = { ...DEFAULT_RUNTIME_STATUS };
  const activeChannels = getActiveChannels(config);

  if (activeChannels.length > 0 && typeof pi.getActiveTools !== "function") {
    registerStatusCommand(
      pi,
      config,
      configPath,
      { ...runtime, activeTools: "unavailable" },
      "runtime active-tool inspection is required",
    );
    return;
  }

  const [channel] = activeChannels;
  if (channel) {
    const nativeStream = channel.endpoint === "codex"
      ? adapters.codex
      : adapters.standard;
    if (!nativeStream) {
      throw new Error(
        `${channel.endpoint} Responses adapter is unavailable; no native stream was loaded`,
      );
    }
    pi.registerProvider(
      channel.provider,
      providerConfig(channel, nativeStream, pi, runtime),
    );
  }

  registerStatusCommand(pi, config, configPath, runtime);
}

export default async function nativeResponsesWebSearch(pi: ExtensionAPI) {
  const configPath = CONFIG_PATH;
  let config: NormalizedPluginConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error: unknown) {
    registerConfigErrorStatus(pi, configPath, error);
    return;
  }

  const activeChannels = getActiveChannels(config);
  const adapters: StreamAdapters = {};
  try {
    if (activeChannels.some((channel) => channel.endpoint === "standard")) {
      adapters.standard = (await import("@earendil-works/pi-ai/api/openai-responses"))
        .streamSimple as NativeStreamSimple;
    }
    if (activeChannels.some((channel) => channel.endpoint === "codex")) {
      adapters.codex = (await import("@earendil-works/pi-ai/api/openai-codex-responses"))
        .streamSimple as NativeStreamSimple;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    registerStatusCommand(
      pi,
      config,
      configPath,
      { ...DEFAULT_RUNTIME_STATUS },
      `Responses adapter unavailable; ${message}`,
    );
    return;
  }

  installNativeResponsesWebSearch(pi, config, configPath, adapters);
}
