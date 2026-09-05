import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";

import { FxCodexAuthError } from "./FxCodexAuth.ts";
import type { makeFxCodexTransport } from "./FxCodexTransport.ts";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// Each native session gets a private loopback URL. OAuth credentials never enter
// the worker environment, fx profile, request logs, or remote client connection.
export async function openFxCodexProxy(
  transport: Pick<ReturnType<typeof makeFxCodexTransport>, "models" | "responses">,
  options?: {
    prepare: (body: string) => Promise<{ body: string; lite: boolean }>;
    onEvent?: (event: unknown) => void;
    onStatus?: (status: number) => void;
  },
) {
  const secret = NodeCrypto.randomBytes(32).toString("hex");
  const active = new Set<AbortController>();
  const server = NodeHttp.createServer((request, response) => {
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    const handle = async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const route = url.pathname;
      if (route !== `/${secret}/responses` && route !== `/${secret}/models`) {
        response.writeHead(404).end();
        return;
      }
      const isModels = route.endsWith("/models");
      if (request.method !== (isModels ? "GET" : "POST")) {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += buffer.length;
        if (bytes > MAX_REQUEST_BYTES) {
          request.resume();
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const originalBody = Buffer.concat(chunks).toString("utf8");
      const prepared =
        !isModels && options
          ? await options.prepare(originalBody)
          : { body: originalBody, lite: false };
      if (prepared.lite) headers.set("x-openai-internal-codex-responses-lite", "true");
      const upstream = isModels
        ? await transport.models({
            headers,
            signal: controller.signal,
            ...(url.searchParams.has("client_version")
              ? { clientVersion: url.searchParams.get("client_version")! }
              : {}),
          })
        : await transport.responses({
            body: prepared.body,
            headers,
            signal: controller.signal,
          });
      if (!isModels) options?.onStatus?.(upstream.status);
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      const reader = upstream.body?.getReader();
      const sse = upstream.headers.get("content-type")?.includes("text/event-stream");
      const decoder = new TextDecoder();
      let pendingLine = "";
      let trailing = "";
      const readLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        try {
          options?.onEvent?.(JSON.parse(line.slice(5).trim()));
        } catch {
          /* Incomplete SSE data is not a completed event. */
        }
      };
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            controller.signal.throwIfAborted();
            if (sse) {
              const text = decoder.decode(chunk.value, { stream: true });
              trailing = (trailing + text).slice(-4);
              pendingLine += text;
              if (pendingLine.length > MAX_REQUEST_BYTES)
                throw new Error("Codex SSE record exceeds limit");
              let newline: number;
              while ((newline = pendingLine.indexOf("\n")) >= 0) {
                readLine(pendingLine.slice(0, newline));
                pendingLine = pendingLine.slice(newline + 1);
              }
            }
            if (!response.write(chunk.value))
              await NodeEvents.EventEmitter.once(response, "drain", { signal: controller.signal });
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      if (sse) {
        readLine(pendingLine + decoder.decode());
        // Some Codex streams end immediately after a complete terminal JSON
        // record. Flush its SSE delimiter without replaying a paid request.
        if (trailing && !trailing.endsWith("\n\n") && !trailing.endsWith("\r\n\r\n"))
          response.write("\n\n");
      }
      response.end();
    };
    void handle()
      .catch((error: unknown) => {
        if (response.headersSent || controller.signal.aborted) {
          response.destroy();
          return;
        }
        const authError = error instanceof FxCodexAuthError;
        response.writeHead(authError && !error.retryable ? 401 : 503, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: { message: authError ? error.message : "Codex transport unavailable" },
          }),
        );
      })
      .finally(() => {
        active.delete(controller);
        request.off("aborted", cancel);
        response.off("close", cancel);
      });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not bind the fx Codex transport");
  }
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${secret}`,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        for (const controller of active) controller.abort();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })),
  };
}
