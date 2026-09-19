import {
  normalizeGatewayResponse,
  parseJevRequest,
  type JevEvaluation,
  type JevRequest,
  JevResponseError,
} from "./schema.ts";

export const JEV_API_KEY_ENV = "VERCEL_AI_GATEWAY_API_KEY";
export const JEV_MODEL = "typesafe-ai/jev";
export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
export const JEV_TIMEOUT_MS = 5_000;

export interface JevClientOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class JevUnavailableError extends Error {
  override name = "JevUnavailableError";
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface JevClient {
  evaluate(request: JevRequest, signal?: AbortSignal): Promise<JevEvaluation>;
}

export function createJevClient(options: JevClientOptions = {}): JevClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;

  return {
    async evaluate(request, signal) {
      const parsedRequest = parseJevRequest(request);
      const apiKey = (options.apiKey ?? process.env[JEV_API_KEY_ENV] ?? "").trim();
      if (!apiKey) throw new JevUnavailableError(`Missing ${JEV_API_KEY_ENV}`);
      if (typeof fetchImpl !== "function") throw new JevUnavailableError("Fetch is unavailable");

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();

      try {
        const response = await fetchImpl(JEV_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "ai-gateway-protocol-version": "0.0.1",
            "ai-gateway-auth-method": "api-key",
            "ai-evaluation-model-specification-version": "4",
            "ai-model-id": JEV_MODEL,
          },
          body: JSON.stringify(parsedRequest),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new JevUnavailableError(`Gateway returned HTTP ${response.status}`, response.status);
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new JevUnavailableError("Gateway returned invalid JSON");
        }

        try {
          return normalizeGatewayResponse(body, parsedRequest.questions);
        } catch (error) {
          if (error instanceof JevResponseError) {
            throw new JevUnavailableError(`Invalid Jev response: ${error.message}`);
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof JevUnavailableError) throw error;
        if (timedOut) throw new JevUnavailableError(`Gateway request timed out after ${timeoutMs}ms`);
        if (signal?.aborted) throw new JevUnavailableError("Gateway request was aborted");
        throw new JevUnavailableError("Gateway request failed");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
