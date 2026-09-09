import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

interface ChannelConfig {
  /** Pi provider/channel id, for example: cpa, third_party, cliproxyapi */
  provider: string;
  /** Only models with this prefix use the shim. Default: gpt- */
  modelPrefix?: string;
  /** Per-channel switch. Default: true */
  enabled?: boolean;
  /** CPA address. /v1 and /backend-api forms are both accepted. */
  baseUrl?: string;
  /** Per-channel transport override. */
  transport?: Transport;
}

interface PluginConfig {
  /** Master switch. Default: true */
  enabled?: boolean;
  /** Default transport. Default: websocket-cached */
  transport?: Transport;
  channels?: ChannelConfig[];
}

const CONFIG_PATH =
  process.env.PI_CPA_CODEX_WS_CONFIG ||
  join(homedir(), ".pi", "agent", "cpa-codex-ws.json");

const DEFAULT_CONFIG: Required<Pick<PluginConfig, "enabled" | "transport">> & {
  channels: ChannelConfig[];
} = {
  enabled: true,
  transport: "websocket-cached",
  channels: [
    {
      provider: "cpa",
      modelPrefix: "gpt-",
      enabled: true,
      baseUrl: "http://127.0.0.1:8317",
    },
  ],
};

async function loadConfig(): Promise<PluginConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as PluginConfig;
    return {
      enabled: parsed.enabled ?? true,
      transport: parsed.transport ?? "websocket-cached",
      channels: Array.isArray(parsed.channels) ? parsed.channels : [],
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }
}

/**
 * Pi's native openai-codex-responses implementation appends /codex/responses.
 * CPA exposes the Codex-compatible inference namespace below /backend-api,
 * so all common CPA base URL forms are normalized to .../backend-api.
 */
function normalizeCpaInferenceBaseUrl(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;

  const url = new URL(raw);
  let pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/backend-api/codex/responses")) {
    pathname = pathname.slice(0, -"/codex/responses".length);
  } else if (pathname.endsWith("/backend-api")) {
    // already correct
  } else if (pathname.endsWith("/v1")) {
    pathname = `${pathname.slice(0, -3)}/backend-api`;
  } else if (!pathname || pathname === "/") {
    pathname = "/backend-api";
  } else {
    pathname = `${pathname}/backend-api`;
  }

  url.pathname = pathname.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function modelMatches(model: Model<any>, channel: ChannelConfig): boolean {
  if (model.provider !== channel.provider) return false;
  const prefix = channel.modelPrefix ?? "gpt-";
  return prefix.length === 0 || model.id.startsWith(prefix);
}

export default async function cpaCodexWs(pi: ExtensionAPI) {
  const config = await loadConfig();
  if (config.enabled === false) return;

  const defaultTransport = config.transport ?? "websocket-cached";
  const activeChannels = (config.channels ?? []).filter(
    (channel) => channel.enabled !== false && channel.provider?.trim(),
  );

  for (const channel of activeChannels) {
    const provider = channel.provider.trim();
    const transport = channel.transport ?? defaultTransport;
    const baseUrl = normalizeCpaInferenceBaseUrl(
      channel.baseUrl ?? "http://127.0.0.1:8317",
    );

    // No models array is supplied: Pi keeps the provider's existing catalogue.
    // The selected provider is routed through Pi's native Codex Responses API.
    pi.registerProvider(provider, {
      baseUrl,
      api: "openai-codex-responses",
      streamSimple: (
        model: Model<any>,
        context: Context,
        options?: SimpleStreamOptions,
      ) => {
        if (!modelMatches(model, channel)) {
          throw new Error(
            `[cpa-codex-ws] ${model.provider}/${model.id} does not match ` +
              `modelPrefix=${JSON.stringify(channel.modelPrefix ?? "gpt-")}. ` +
              `Use this provider channel only for configured GPT models, or disable this channel.`,
          );
        }

        return streamCodexResponses(
          model as Model<"openai-codex-responses">,
          context,
          {
            ...options,
            // Explicitly force the configured transport after Pi has supplied
            // sessionId/apiKey/signal/reasoning/etc. websocket-cached reuses the
            // session WebSocket and cached response context when available.
            transport,
          },
        );
      },
    });
  }

  // Command only; no LLM-callable tool schema is added to model context.
  pi.registerCommand("cpa-ws", {
    description: "Show CPA Codex WebSocket transport status",
    handler: async (_args, ctx) => {
      const lines = activeChannels.map((channel) => {
        const transport = channel.transport ?? defaultTransport;
        const baseUrl = normalizeCpaInferenceBaseUrl(
          channel.baseUrl ?? "http://127.0.0.1:8317",
        );
        return `${channel.provider}/${channel.modelPrefix ?? "gpt-*"} -> ${transport} -> ${baseUrl}/codex/responses`;
      });

      ctx.ui.notify(
        [
          `CPA Codex WS: ${config.enabled === false ? "disabled" : "enabled"}`,
          ...lines,
          `config: ${CONFIG_PATH}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
