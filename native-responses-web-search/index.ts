import {
  type ExtensionAPI,
  type ExtensionCommandContext,
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
export type NativeWebSearchTool = "web_search" | "web_search_preview";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type NativeStreamSimple = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface WebSearchChannelConfig {
  /** Existing Pi provider/channel id reserved for this plugin. */
  provider: string;
  /** Responses endpoint used for the nested local web search request. */
  endpoint?: ResponsesEndpoint;
  /** Native hosted-search declaration used by the nested request. */
  nativeTool?: NativeWebSearchTool;
  /** Only models with this prefix use local web search. Empty means all models. */
  modelPrefix?: string;
  /**
   * Backend model id for nested search requests. When set, web_search works
   * from any active model; when unset, the active model must match the channel.
   */
  model?: string;
  /** Must be explicitly true to opt in this channel. */
  enabled?: boolean;
  /** Codex transport. */
  transport?: Transport;
}

export interface PluginConfig {
  /** Master switch. Default: true; channels still require enabled: true. */
  enabled?: boolean;
  /** Default Codex transport when a channel does not set one. */
  transport?: Transport;
  channels?: WebSearchChannelConfig[];
}

export const NESTED_SEARCH_TIMEOUT_MS = 30_000;

export interface NormalizedWebSearchChannel {
  provider: string;
  endpoint: ResponsesEndpoint;
  nativeTool: NativeWebSearchTool;
  modelPrefix: string;
  model: string;
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
  toolRegistration: RuntimeCapabilityState;
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

const WEB_SEARCH_PREVIEW_TOOL = { type: "web_search_preview" } as const;
const WEB_SEARCH_TOOL = { type: "web_search" } as const;
const STANDARD_RESPONSES_API = "openai-responses" as const;
const CODEX_RESPONSES_API = "openai-codex-responses" as const;
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
  toolRegistration: "unknown",
};
const WEB_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "The web search query" },
  },
  required: ["query"],
  additionalProperties: false,
};

type JsonObject = Record<string, unknown>;
type PluginAPI = Pick<
  ExtensionAPI,
  "registerCommand" | "registerProvider" | "registerTool"
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

function readEndpoint(value: unknown, label: string): ResponsesEndpoint {
  if (value === undefined) {
    throw new Error(`${label} must be explicitly configured as standard or codex`);
  }
  if (value === "standard" || value === "codex") return value;
  throw new Error(`${label} must be \"standard\" or \"codex\"`);
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

function readNativeTool(
  value: unknown,
  endpoint: ResponsesEndpoint,
  label: string,
): NativeWebSearchTool {
  const defaultTool = endpoint === "standard" ? "web_search_preview" : "web_search";
  if (value === undefined) return defaultTool;
  if (value !== "web_search" && value !== "web_search_preview") {
    throw new Error(`${label} must be web_search or web_search_preview`);
  }
  if (endpoint === "codex" && value !== "web_search") {
    throw new Error(`${label} must be web_search for the codex endpoint`);
  }
  return value;
}

function readChannelModel(value: unknown, label: string): string {
  if (value === undefined) return "";
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new Error(`${label} must be a non-empty string`);
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
    const endpoint = readEndpoint(
      rawChannel.endpoint,
      `config.channels[${index}].endpoint`,
    );

    return {
      provider: provider.trim(),
      endpoint,
      nativeTool: readNativeTool(
        rawChannel.nativeTool,
        endpoint,
        `config.channels[${index}].nativeTool`,
      ),
      modelPrefix: (modelPrefix ?? "").trim(),
      model: readChannelModel(
        rawChannel.model,
        `config.channels[${index}].model`,
      ),
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

function apiForEndpoint(endpoint: ResponsesEndpoint):
  typeof STANDARD_RESPONSES_API | typeof CODEX_RESPONSES_API {
  return endpoint === "standard" ? STANDARD_RESPONSES_API : CODEX_RESPONSES_API;
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

/** Standalone tool mode: the channel names the backend model explicitly. */
function resolveChannelModel(
  registry: {
    find?: (provider: string, modelId: string) => Model<any> | undefined;
  },
  channel: NormalizedWebSearchChannel,
): Model<any> {
  if (typeof registry.find !== "function") {
    throw new Error("web_search model registry does not support model lookup");
  }
  const resolved = registry.find(channel.provider, channel.model);
  if (!resolved) {
    throw new Error(
      `web_search model ${channel.provider}/${channel.model} is not present in the model registry`,
    );
  }
  if (resolved.api !== apiForEndpoint(channel.endpoint)) {
    throw new Error(
      `web_search model ${channel.provider}/${channel.model} does not use the configured ${channel.endpoint} Responses API`,
    );
  }
  return resolved;
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

function removeNativeWebSearch(payload: unknown): unknown {
  if (!isObject(payload) || !Array.isArray(payload.tools)) return payload;
  const tools = payload.tools.filter((tool) => !isNativeWebSearchTool(tool));
  return tools.length === payload.tools.length ? payload : { ...payload, tools };
}

/** Add a Codex/Responses hosted-search declaration without mutating the payload. */
export function addNativeWebSearch(
  payload: unknown,
  endpoint: ResponsesEndpoint = "codex",
  nativeTool: NativeWebSearchTool =
    endpoint === "standard" ? "web_search_preview" : "web_search",
): unknown {
  if (!isObject(payload) || isToolChoiceNone(payload.tool_choice)) {
    return payload;
  }

  const currentTools = payload.tools;
  if (currentTools !== undefined && !Array.isArray(currentTools)) {
    return payload;
  }

  const tools = currentTools ?? [];
  const configuredTool = tools.find(
    (tool) => isObject(tool) && tool.type === nativeTool,
  );
  const nativeTools = tools.filter(isNativeWebSearchTool);
  if (nativeTools.length === 1 && configuredTool !== undefined) return payload;

  const declaration = configuredTool ?? (
    nativeTool === "web_search"
      ? { ...WEB_SEARCH_TOOL }
      : { ...WEB_SEARCH_PREVIEW_TOOL }
  );
  return {
    ...payload,
    tools: [
      ...tools.filter((tool) => !isNativeWebSearchTool(tool)),
      declaration,
    ],
  };
}

/** Parent requests intentionally do not receive the native declaration. */
function currentModelStatus(
  model: ModelIdentity | undefined,
  channel: NormalizedWebSearchChannel,
  globallyEnabled: boolean,
  runtime: RuntimeStatus,
): string {
  if (!globallyEnabled || !channel.enabled) return "disabled";
  if (channel.model) {
    if (runtime.toolRegistration === "unavailable") {
      return "unavailable; web_search tool registration failed";
    }
    return runtime.toolRegistration === "available"
      ? `standalone; backend ${channel.provider}/${channel.model}; tool registered`
      : `standalone; backend ${channel.provider}/${channel.model} (tool registration pending)`;
  }
  if (!model) return "enabled; no active model";
  if (model.provider !== channel.provider) return "enabled; model not selected";
  if (model.api !== apiForEndpoint(channel.endpoint)) {
    return `unavailable; model is not ${channel.endpoint === "standard" ? "Standard" : "Codex"} Responses`;
  }
  if (typeof model.id !== "string") return "enabled; model id unavailable";
  if (channel.modelPrefix && !model.id.startsWith(channel.modelPrefix)) {
    return "enabled; model prefix does not match";
  }
  if (runtime.toolRegistration === "unavailable") {
    return "unavailable; web_search tool registration failed";
  }
  return runtime.toolRegistration === "available"
    ? "enabled; model matches; tool registered"
    : "enabled; model matches (tool registration pending)";
}

export function formatStatus(
  config: NormalizedPluginConfig,
  model?: ModelIdentity,
  configPath = CONFIG_PATH,
  runtime: RuntimeStatus = DEFAULT_RUNTIME_STATUS,
): string {
  const lines = [
    `Native web search tool: ${config.enabled ? "enabled" : "disabled"}`,
    `config: ${configPath}`,
  ];

  if (config.channels.length === 0) {
    lines.push("channels: none (explicit channel opt-in required)");
    return lines.join("\n");
  }

  for (const channel of config.channels) {
    const endpoint = channel.endpoint === "codex"
      ? `Codex Responses (${channel.transport}, ${channel.nativeTool})`
      : `Standard Responses (${channel.nativeTool})`;
    lines.push(
      `${channel.provider}/${channel.modelPrefix || "*"} -> ${endpoint} -> ${currentModelStatus(model, channel, config.enabled, runtime)}`,
    );
  }
  return lines.join("\n");
}

function textFromAssistant(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((part): part is { type: "text"; text: string } =>
      isObject(part) && part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}

function registerLocalWebSearch(
  pi: PluginAPI,
  channel: NormalizedWebSearchChannel,
  adapter: NativeStreamSimple,
  runtime: RuntimeStatus,
): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web for current information.",
    promptSnippet: "Use web_search when current web information is needed.",
    parameters: WEB_SEARCH_PARAMETERS as any,
    execute: async (
      _toolCallId: string,
      params: { query: string },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: any,
    ) => {
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      if (!query) {
        throw new Error("web_search query must be a non-empty string");
      }
      if (!ctx?.modelRegistry || typeof ctx.modelRegistry.getApiKeyAndHeaders !== "function") {
        throw new Error("web_search model registry is unavailable");
      }

      let model = ctx?.model as Model<any> | undefined;
      if (channel.model) {
        model = resolveChannelModel(ctx.modelRegistry, channel);
      } else if (!matchesChannel(model, channel)) {
        throw new Error(
          "web_search model does not match the configured Responses channel",
        );
      }

      const callerSignal = signal ?? ctx.signal;
      if (callerSignal?.aborted) {
        throw new Error("web_search aborted");
      }

      const timeoutSignal = AbortSignal.timeout(NESTED_SEARCH_TIMEOUT_MS);
      const requestSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;

      const checkAborted = () => {
        if (callerSignal?.aborted) {
          throw new Error("web_search aborted");
        }
        if (timeoutSignal.aborted) {
          throw new Error(
            `web_search request timed out after ${NESTED_SEARCH_TIMEOUT_MS} ms`,
          );
        }
        if (requestSignal.aborted) {
          throw new Error("web_search aborted");
        }
      };

      if (requestSignal.aborted) {
        checkAborted();
      }

      const withBoundary = <T>(promise: Promise<T>): Promise<T> => {
        if (requestSignal.aborted) {
          checkAborted();
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            requestSignal.removeEventListener("abort", onAbort);
            try {
              checkAborted();
            } catch (err) {
              reject(err);
            }
          };
          requestSignal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (val) => {
              requestSignal.removeEventListener("abort", onAbort);
              if (requestSignal.aborted) {
                try {
                  checkAborted();
                } catch (abortErr) {
                  reject(abortErr);
                  return;
                }
              }
              resolve(val);
            },
            (err) => {
              requestSignal.removeEventListener("abort", onAbort);
              if (requestSignal.aborted) {
                try {
                  checkAborted();
                } catch (abortErr) {
                  reject(abortErr);
                  return;
                }
              }
              reject(err);
            },
          );
        });
      };

      const auth = await withBoundary(Promise.resolve(ctx.modelRegistry.getApiKeyAndHeaders(model)));
      if (!auth.ok) {
        throw new Error(`web_search authentication unavailable: ${auth.error}`);
      }
      if (!auth.apiKey) {
        throw new Error("web_search requires an API key for the configured provider");
      }

      const stream = adapter(model, {
        systemPrompt:
          "Use the native web search capability to answer the search query. " +
          "Return concise factual results and include source links when available.",
        messages: [{ role: "user", content: query, timestamp: Date.now() }],
        tools: [],
      }, {
        apiKey: auth.apiKey,
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(channel.endpoint === "codex"
          ? { transport: channel.transport }
          : {}),
        toolChoice: "required",
        signal: requestSignal,
        onPayload: async (payload) =>
          addNativeWebSearch(payload, channel.endpoint, channel.nativeTool),
      });

      const result = await withBoundary(stream.result());
      if (result.stopReason === "error" || result.stopReason === "aborted" || requestSignal.aborted) {
        checkAborted();
        throw new Error(result.errorMessage || "web_search request failed");
      }

      const text = textFromAssistant(result);
      if (!text.trim()) {
        throw new Error("web_search returned no text");
      }

      return {
        content: [{ type: "text", text }],
        details: { query },
        usage: result.usage,
      };
    },
  });
  runtime.toolRegistration = "available";
}

function providerConfig(
  channel: NormalizedWebSearchChannel,
  nativeStream: NativeStreamSimple,
) {
  return {
    api: apiForEndpoint(channel.endpoint),
    streamSimple: (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => {
      if (!matchesChannel(model, channel)) {
        // The host dispatches every same-API model of this provider here, but
        // the channel only owns its prefix; everything else keeps the default
        // behavior (no transport override, no payload rewriting).
        return nativeStream(model, context, options);
      }

      const existingOnPayload = options?.onPayload;
      return nativeStream(model, context, {
        ...(options ?? {}),
        ...(channel.endpoint === "codex"
          ? { transport: channel.transport }
          : {}),
        onPayload: async (payload, payloadModel) => {
          const result = typeof existingOnPayload === "function"
            ? await existingOnPayload(payload, payloadModel)
            : undefined;
          return removeNativeWebSearch(result === undefined ? payload : result);
        },
      });
    },
  };
}

function registerStatusCommand(
  pi: PluginAPI,
  config: NormalizedPluginConfig,
  configPath: string,
  runtime: RuntimeStatus,
  unavailableReason?: string,
): void {
  pi.registerCommand("native-web-search", {
    description: "Show native web search tool status",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const status = formatStatus(config, ctx.model, configPath, runtime);
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
    description: "Show native web search tool configuration status",
    handler: async (_args, _ctx) => {
      _ctx.ui.notify(
        [
          "Native web search tool: unavailable",
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
  const [channel] = activeChannels;

  if (channel) {
    const nativeStream = channel.endpoint === "standard"
      ? adapters.standard
      : adapters.codex;
    if (!nativeStream) {
      registerStatusCommand(
        pi,
        config,
        configPath,
        { ...runtime, toolRegistration: "unavailable" },
        `${channel.endpoint === "standard" ? "Standard" : "Codex"} Responses adapter is unavailable; no native stream was loaded`,
      );
      return;
    }

    try {
      registerLocalWebSearch(pi, channel, nativeStream, runtime);
    } catch (error: unknown) {
      runtime.toolRegistration = "unavailable";
      const message = error instanceof Error ? error.message : String(error);
      registerStatusCommand(
        pi,
        config,
        configPath,
        runtime,
        `web_search tool registration failed; ${message}`,
      );
      return;
    }

    try {
      pi.registerProvider(
        channel.provider,
        providerConfig(channel, nativeStream),
      );
    } catch (error: unknown) {
      runtime.toolRegistration = "unavailable";
      const message = error instanceof Error ? error.message : String(error);
      registerStatusCommand(
        pi,
        config,
        configPath,
        runtime,
        `provider overlay registration failed; ${message}`,
      );
      return;
    }
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
      { ...DEFAULT_RUNTIME_STATUS, toolRegistration: "unavailable" },
      `Responses adapter unavailable; ${message}`,
    );
    return;
  }

  installNativeResponsesWebSearch(pi, config, configPath, adapters);
}
