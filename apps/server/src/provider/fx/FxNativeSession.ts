// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
// @effect-diagnostics globalTimers:off - Native subprocess deadlines must fire independently of the Effect clock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

type RpcId = string | number;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface FxNativeOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly nativeHome: string;
  readonly model: string;
  readonly proxyUrl: string;
  readonly promptCacheKey: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }>;
  readonly environment: NodeJS.ProcessEnv;
  readonly resumeSessionId?: string;
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onToolCall: (
    name: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<{ readonly content: string; readonly isError?: boolean }>;
  readonly onPermission?: (params: unknown, signal: AbortSignal) => Promise<unknown>;
}

// One ACP process owns one conversation. Native state stays below nativeHome;
// the host supplies immutable context and tools again when loading a session.
export async function openFxNativeSession(options: FxNativeOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.promptCacheKey)) throw new Error("Invalid fx cache key");
  const profile = NodePath.join(options.nativeHome, ".fx");
  await NodeFSP.mkdir(profile, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(profile, "settings.json"),
    JSON.stringify({
      provider: "codex",
      codex_model: options.model,
    }),
    { mode: 0o600 },
  );
  const child = NodeChildProcess.spawn(options.binaryPath, ["acp", "--model", options.model], {
    cwd: options.cwd,
    env: {
      ...options.environment,
      HOME: options.nativeHome,
      FX_AUTH_MODE: "host-managed",
      FX_T3_CODEX_PROXY_URL: options.proxyUrl,
      FX_T3_PROMPT_CACHE_KEY: options.promptCacheKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0;
  let stopped = false;
  let buffer = "";
  let activeTurn: AbortController | undefined;
  const activeMessages = new Set<Promise<void>>();
  const pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void;
      reject: (cause: Error) => void;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  const lifetime = new AbortController();
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    activeTurn?.abort();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    child.kill("SIGKILL");
  };
  const write = (value: unknown) => {
    if (stopped) throw new Error("fx session is closed");
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new Error("fx request exceeds 32 MiB");
    child.stdin.write(line);
  };
  const request = (method: string, params: unknown, timeoutMs: number | null = 90_000) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => fail(new Error(`fx ${method} timed out`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  const accept = async (raw: unknown) => {
    const message = object(raw);
    if (!message) throw new Error("Invalid fx protocol message");
    const id =
      typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    if (typeof message.method === "string") {
      if (id === undefined) {
        options.onNotification(message.method, message.params);
        return;
      }
      try {
        let result: unknown;
        if (message.method === "libfx/tool_call") {
          const params = object(message.params);
          if (typeof params?.name !== "string" || !activeTurn)
            throw new Error("Unexpected fx tool call");
          result = await options.onToolCall(params.name, params.input, activeTurn.signal);
        } else if (message.method === "session/request_permission") {
          result = options.onPermission
            ? await options.onPermission(message.params, activeTurn?.signal ?? lifetime.signal)
            : { outcome: { outcome: "cancelled" } };
        } else throw new Error("Unsupported fx client request");
        if (!stopped) write({ jsonrpc: "2.0", id, result });
      } catch (error) {
        if (!stopped)
          write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Host tool failed",
            },
          });
      }
      return;
    }
    const entry = id === undefined ? undefined : pending.get(id);
    if (!entry || id === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error !== undefined)
      entry.reject(
        new Error(
          `fx request failed: ${String(object(message.error)?.message ?? "Unknown error")}`,
        ),
      );
    else entry.resolve(message.result);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
      fail(new Error("fx response exceeds 32 MiB"));
      return;
    }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const task = accept(JSON.parse(line));
        activeMessages.add(task);
        void task.then(
          () => activeMessages.delete(task),
          () => {
            activeMessages.delete(task);
            fail(new Error("Invalid fx protocol message"));
          },
        );
      } catch {
        fail(new Error("Invalid fx protocol message"));
      }
    }
  });
  // Drain diagnostics without copying private model content into client errors.
  child.stderr.resume();
  child.on("error", () => fail(new Error("Could not start the bundled fx executable")));
  child.stdin.on("error", () => fail(new Error("fx input pipe closed")));
  child.on("close", () => {
    fail(new Error("fx process exited"));
    exited.resolve();
  });
  const close = async () => {
    fail(new Error("fx session closed"));
    await exited.promise;
  };
  try {
    const initialized = await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "t3-code", version: "1" },
      clientCapabilities: { libfx: { instructions: options.instructions, tools: options.tools } },
    });
    const setup = await request(options.resumeSessionId ? "session/load" : "session/new", {
      cwd: options.cwd,
      mcpServers: [],
      ...(options.resumeSessionId ? { sessionId: options.resumeSessionId } : {}),
    });
    const sessionId = options.resumeSessionId ?? object(setup)?.sessionId;
    if (typeof sessionId !== "string") throw new Error("fx returned no session ID");
    return {
      sessionId,
      isClosed: () => stopped,
      initialized,
      setup,
      prompt: async (prompt: ReadonlyArray<unknown>, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (activeTurn) throw new Error("fx already has an active turn");
        activeTurn = new AbortController();
        const cancel = () => {
          activeTurn?.abort();
          if (!stopped) write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          return await request("session/prompt", { sessionId, prompt }, null);
        } finally {
          signal?.removeEventListener("abort", cancel);
          activeTurn.abort();
          await Promise.allSettled(activeMessages);
          activeTurn = undefined;
        }
      },
      setModel: (model: string) =>
        request("session/set_config_option", { sessionId, configId: "model", value: model }),
      setConfig: (configId: string, value: string | boolean) =>
        request("session/set_config_option", { sessionId, configId, value }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
