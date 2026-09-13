import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WebSearchChannelConfig {
  /** Existing Pi provider/channel id reserved for this plugin. */
  provider: string;
  /** Only models with this prefix use native web search. Empty means all models. */
  modelPrefix?: string;
  /** Must be explicitly true to opt in this channel. */
  enabled?: boolean;
}

export interface PluginConfig {
  /** Master switch. Default: true; channels still require enabled: true. */
  enabled?: boolean;
  channels?: WebSearchChannelConfig[];
}

export interface NormalizedWebSearchChannel {
  provider: string;
  modelPrefix: string;
  enabled: boolean;
}

export interface NormalizedPluginConfig {
  enabled: boolean;
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
  channels: [],
};

const STANDARD_RESPONSES_API = "openai-responses";
const STANDARD_WEB_SEARCH_TOOL = { type: "web_search_preview" } as const;
const NATIVE_WEB_SEARCH_TYPES = new Set([
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11",
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

export function normalizeConfig(value: unknown): NormalizedPluginConfig {
  if (!isObject(value)) {
    throw new Error("native-responses-web-search config must be a JSON object");
  }

  const enabled = readBoolean(value.enabled, true, "config.enabled");
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
      modelPrefix: modelPrefix ?? "",
      enabled: readBoolean(
        rawChannel.enabled,
        false,
        `config.channels[${index}].enabled`,
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

  return { enabled, channels };
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

export function matchesChannel(
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
): boolean {
  return (
    model?.provider === channel.provider &&
    model.api === STANDARD_RESPONSES_API &&
    typeof model.id === "string" &&
    (channel.modelPrefix === "" || model.id.startsWith(channel.modelPrefix))
  );
}

function isToolChoiceNone(value: unknown): boolean {
  return (
    value === "none" ||
    (isObject(value) && value.type === "none")
  );
}

function isNativeWebSearchTool(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    NATIVE_WEB_SEARCH_TYPES.has(value.type)
  );
}

/**
 * Add the smallest Standard Responses hosted-search declaration without
 * mutating or replacing any existing payload field.
 */
export function addNativeWebSearch(payload: unknown): unknown {
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
    tools: [...tools, { ...STANDARD_WEB_SEARCH_TOOL }],
  };
}

export function augmentPayloadForModel(
  payload: unknown,
  model: ModelIdentity | undefined,
  channels: readonly NormalizedWebSearchChannel[],
): unknown {
  if (!channels.some((channel) => matchesChannel(model, channel))) {
    return payload;
  }
  return addNativeWebSearch(payload);
}

function currentModelStatus(
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
  globallyEnabled: boolean,
): string {
  if (!globallyEnabled || !channel.enabled) return "disabled";
  if (!model) return "enabled; no active model";
  if (model.provider !== channel.provider) return "enabled; model not selected";
  if (model.api !== STANDARD_RESPONSES_API) {
    return "unavailable; model is not Standard Responses";
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
    lines.push(
      `${channel.provider}/${channel.modelPrefix || "*"} -> Standard Responses -> ${currentModelStatus(model, channel, config.enabled)}`,
    );
  }
  return lines.join("\n");
}

export function installStandardResponsesWebSearch(
  pi: PluginAPI,
  config: NormalizedPluginConfig,
  configPath = CONFIG_PATH,
): void {
  const activeChannels = getActiveChannels(config);

  // No models or credentials are supplied: the existing provider catalogue,
  // base URL, and authentication remain the source of truth for this channel.
  for (const channel of activeChannels) {
    pi.registerProvider(channel.provider, { api: STANDARD_RESPONSES_API });
  }

  if (activeChannels.length > 0) {
    pi.on("before_provider_request", (event, ctx) => {
      const payload = augmentPayloadForModel(
        event.payload,
        ctx.model,
        activeChannels,
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
  installStandardResponsesWebSearch(pi, config);
}
