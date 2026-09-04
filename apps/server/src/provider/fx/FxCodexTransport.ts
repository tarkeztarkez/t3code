import type { FxCodexAuth, FxCodexCredential, FxCodexFetch } from "./FxCodexAuth.ts";

const CODEX_URL = "https://chatgpt.com/backend-api/codex";
const FORWARDED_HEADERS = [
  "originator",
  "openai-beta",
  "user-agent",
  "version",
  "session-id",
  "x-client-request-id",
] as const;

export class FxCodexTransportError extends Error {
  constructor() {
    super("The Codex request failed before a response was received.");
    this.name = "FxCodexTransportError";
  }
}

// Only known Codex endpoints receive credentials. Keep this in the environment
// server; the native worker and remote clients do not receive OAuth tokens.
export function makeFxCodexTransport(options: {
  readonly auth: FxCodexAuth;
  readonly accountId: string;
  readonly fetch: FxCodexFetch;
}) {
  if (!options.accountId) throw new Error("A Codex account is required");

  const request = async (input: {
    readonly url: string;
    readonly body?: string;
    readonly headers?: HeadersInit;
    readonly signal?: AbortSignal;
  }): Promise<Response> => {
    const { signal } = input;
    const original = new Headers(input.headers);
    const send = async (credential: FxCodexCredential) => {
      signal?.throwIfAborted();
      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = original.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set("accept", input.body === undefined ? "application/json" : "text/event-stream");
      if (input.body !== undefined) headers.set("content-type", "application/json");
      credential.authorize(headers);
      try {
        return await options.fetch(input.url, {
          method: input.body === undefined ? "GET" : "POST",
          headers,
          redirect: "error",
          credentials: "omit",
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        signal?.throwIfAborted();
        throw new FxCodexTransportError();
      }
    };
    signal?.throwIfAborted();
    let credential = await options.auth.credentials(options.accountId);
    let response = await send(credential);
    if (response.status !== 401) return response;
    await response.body?.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    const reloaded = await options.auth.reload(options.accountId);
    if (reloaded.fingerprint !== credential.fingerprint) {
      credential = reloaded;
      response = await send(credential);
      if (response.status !== 401) return response;
      await response.body?.cancel().catch(() => undefined);
    }
    signal?.throwIfAborted();
    // One refresh recovery after the guarded reload. Never replay successful
    // SSE output, network failures, rate limits, or server errors automatically.
    return send(await options.auth.recover(credential));
  };

  return {
    responses: (input: {
      readonly body: string;
      readonly headers?: HeadersInit;
      readonly signal?: AbortSignal;
    }) => request({ ...input, url: `${CODEX_URL}/responses` }),
    models: (
      input: {
        readonly clientVersion?: string;
        readonly headers?: HeadersInit;
        readonly signal?: AbortSignal;
      } = {},
    ) => {
      const url = new URL(`${CODEX_URL}/models`);
      if (input.clientVersion !== undefined)
        url.searchParams.set("client_version", input.clientVersion);
      return request({ ...input, url: url.href });
    },
  };
}
