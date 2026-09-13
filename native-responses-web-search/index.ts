import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ResponsesEndpoint = "standard" | "codex";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type CodexStreamSimple = StreamFunction<
  "openai-codex-responses",
  SimpleStreamOptions
>;

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

const CONFIG_PATH =
  process.env.PI_NATIVE_RESPONSES_WEB_SEARCH_CONFIG ||
  join(homedir(), ".pi", "agent", "native-responses-web-search.json");

export const DEFAULT_CONFIG: NormalizedPluginConfig = {
  enabled: true,
  transport: "auto",
  channels: [],
};

const STANDARD_RESPONSES_API = "openai-responses";
const CODEX_RESPONSES_API = "openai-codex-responses";
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

type JsonObject = Record<string, unknown>;

type PluginAPI = Pick<
  ExtensionAPI,
  "on" | "registerCommand" | "registerProvider"
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

function apiForEndpoint(endpoint: ResponsesEndpoint): string {
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

export function augmentPayloadForModel(
  payload: unknown,
  model: ModelIdentity | undefined,
  channels: readonly NormalizedWebSearchChannel[],
): unknown {
  const channel = channels.find((candidate) =>
    matchesChannel(model, candidate),
  );
  return channel ? addNativeWebSearch(payload, channel.endpoint) : payload;
}

function currentModelStatus(
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
  globallyEnabled: boolean,
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
  return "enabled; model matches";
}

export function formatStatus(
  config: NormalizedPluginConfig,
  model?: ModelIdentity,
  configPath = CONFIG_PATH,
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
      `${channel.provider}/${channel.modelPrefix || "*"} -> ${endpoint} -> ${currentModelStatus(model, channel, config.enabled)}`,
    );
  }
  return lines.join("\n");
}

function codexProviderConfig(
  channel: NormalizedWebSearchChannel,
  codexStream: CodexStreamSimple,
) {
  return {
    api: CODEX_RESPONSES_API,
    streamSimple: (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => {
      if (!matchesChannel(model, channel)) {
        throw new Error(
          `[native-responses-web-search] ${model.provider}/${model.id} does not match ` +
            `the configured Codex channel model prefix ${JSON.stringify(channel.modelPrefix)}`,
        );
      }

      return codexStream(model as Model<"openai-codex-responses">, context, {
        ...options,
        // The configured channel owns transport selection. No URL inspection
        // or protocol fallback is performed by this plugin.
        transport: channel.transport,
        onPayload: async (payload, payloadModel) => {
          const existingPayload = await options?.onPayload?.(
            payload,
            payloadModel,
          );
          return addNativeWebSearch(
            existingPayload === undefined ? payload : existingPayload,
            "codex",
          );
        },
      });
    },
  };
}

export function installNativeResponsesWebSearch(
  pi: PluginAPI,
  config: NormalizedPluginConfig,
  configPath = CONFIG_PATH,
  codexStream?: CodexStreamSimple,
): void {
  const activeChannels = getActiveChannels(config);

  // No models, base URL, or credentials are supplied: the existing provider
  // catalogue and authentication remain the source of truth for each channel.
  for (const channel of activeChannels) {
    if (channel.endpoint === "codex") {
      if (!codexStream) {
        throw new Error(
          "Codex Responses adapter is unavailable; no native stream was loaded",
        );
      }
      pi.registerProvider(
        channel.provider,
        codexProviderConfig(channel, codexStream),
      );
    } else {
      pi.registerProvider(channel.provider, { api: STANDARD_RESPONSES_API });
    }
  }

  const standardChannels = activeChannels.filter(
    (channel) => channel.endpoint === "standard",
  );
  if (standardChannels.length > 0) {
    pi.on("before_provider_request", (event, ctx) => {
      const payload = augmentPayloadForModel(
        event.payload,
        ctx.model,
        standardChannels,
      );
      return payload === event.payload ? undefined : payload;
    });
  }

  pi.registerCommand("native-web-search", {
    description: "Show native Responses web search channel status",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(formatStatus(config, ctx.model, configPath), "info");
    },
  });
}

export default async function nativeResponsesWebSearch(pi: ExtensionAPI) {
  const config = await loadConfig();
  const hasCodexChannel = getActiveChannels(config).some(
    (channel) => channel.endpoint === "codex",
  );
  const codexStream = hasCodexChannel
    ? (await import("@earendil-works/pi-ai/api/openai-codex-responses"))
        .streamSimple
    : undefined;
  installNativeResponsesWebSearch(pi, config, CONFIG_PATH, codexStream);
}
