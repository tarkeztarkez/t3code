// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vitest";
import { executeCode } from "../../../../../scripts/fx/runtime.mjs";

import { makeFxCodexAuth, type FxCodexFetch } from "./FxCodexAuth.ts";
import { makeFxCodexTransport } from "./FxCodexTransport.ts";
import { openFxCodexProxy } from "./FxCodexProxy.ts";
import { openFxNativeSession } from "./FxNativeSession.ts";

const binary = process.env.FX_NATIVE_BINARY;
const codeBinary = process.env.FX_ISOLATED_BINARY;
it.skipIf(!binary || !codeBinary)(
  "runs native fx through host auth, tools, token recovery, and conversation resume",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-native-"));
    const home = NodePath.join(root, "host");
    const nativeHome = NodePath.join(root, "native");
    const cwd = NodePath.join(root, "workspace");
    await NodeFSP.mkdir(NodePath.join(home, ".codex"), { recursive: true });
    await NodeFSP.mkdir(cwd);
    await NodeFSP.writeFile(
      NodePath.join(cwd, "AGENTS.md"),
      "NATIVE_CONTEXT_SHOULD_NOT_REPLACE_HOST_SNAPSHOT",
    );
    const authPath = NodePath.join(home, ".codex/auth.json");
    await NodeFSP.writeFile(
      authPath,
      JSON.stringify({
        tokens: { access_token: "initial", refresh_token: "refresh", account_id: "account-a" },
      }),
    );
    let refreshes = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const textRequests: string[] = [];
    const events: unknown[] = [];
    let toolCalls = 0;
    const sse = (events: unknown[]) =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    const auth = makeFxCodexAuth({
      homeDirectory: home,
      fetch: async () => {
        refreshes++;
        return Response.json({ access_token: "renewed", refresh_token: "rotated" });
      },
    });
    const upstream: FxCodexFetch = async (url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("chatgpt-account-id")).toBe("account-a");
      if (new URL(url).pathname.endsWith("/models"))
        return Response.json({
          models: [
            {
              slug: "gpt-5.4-mini",
              visibility: "list",
              supported_in_api: true,
              priority: 1,
              supported_reasoning_levels: [{ effort: "low" }],
              additional_speed_tiers: [],
              input_modalities: ["text", "image"],
              context_window: 272000,
            },
          ],
        });
      textRequests.push(init.body as string);
      if (headers.get("authorization") === "Bearer initial")
        return new Response("", { status: 401 });
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1)
        return sse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", call_id: "call_1", name: "exec" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: '{"code":"text(1)"}',
          },
          {
            type: "response.completed",
            response: { status: "completed", usage: { input_tokens: 100, output_tokens: 5 } },
          },
        ]);
      return sse([
        { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
        { type: "response.output_text.delta", output_index: 0, delta: "Done." },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 110,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 64 },
            },
          },
        },
      ]);
    };
    const proxy = await openFxCodexProxy(
      makeFxCodexTransport({ auth, accountId: "account-a", fetch: upstream }),
    );
    let session: Awaited<ReturnType<typeof openFxNativeSession>> | undefined;
    const options = {
      binaryPath: binary!,
      cwd,
      nativeHome,
      model: "gpt-5.4-mini",
      proxyUrl: proxy.baseUrl,
      promptCacheKey: "a".repeat(64),
      instructions: "Use exec once, then answer in English.",
      environment: { FX_E2E_CODEX_CLIENT_VERSION: "0.153.1" },
      tools: [
        {
          name: "exec",
          description: "Execute JavaScript",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      ],
      onNotification: (_method: string, params: unknown) => {
        events.push(params);
      },
      onToolCall: async (name: string, input: unknown, signal: AbortSignal) => {
        expect(name).toBe("exec");
        expect(input).toEqual({ code: "text(1)" });
        toolCalls++;
        const result = await executeCode({
          engine: "quickjs-isolated",
          executable: codeBinary!,
          code: (input as { code: string }).code,
          signal,
        });
        expect(result.output).toEqual([1]);
        return { content: JSON.stringify(result.output) };
      },
      onPermission: async (params: unknown) => {
        const options = (params as { options: Array<{ kind: string; optionId: string }> }).options;
        return {
          outcome: {
            outcome: "selected",
            optionId: options.find((option) => option.kind === "allow_once")!.optionId,
          },
        };
      },
    };
    try {
      session = await openFxNativeSession(options);
      await session.prompt([{ type: "text", text: "Run exec and answer." }]);
      expect(toolCalls).toBe(1);
      expect(refreshes).toBe(1);
      expect(textRequests[0]).toBe(textRequests[1]);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      expect(bodies.every((body) => body.prompt_cache_key === options.promptCacheKey)).toBe(true);
      expect(JSON.stringify(events)).toContain("Done.");
      const sessionId = session.sessionId;
      await session.close();
      session = await openFxNativeSession({ ...options, resumeSessionId: sessionId });
      await session.prompt([{ type: "text", text: "Continue." }]);
      expect(session.sessionId).toBe(sessionId);
      expect(bodies.at(-1)?.prompt_cache_key).toBe(options.promptCacheKey);
      expect(bodies.at(-1)?.instructions).toBe(bodies[0]?.instructions);
      expect(bodies[0]?.instructions).toBe(options.instructions);
      expect(JSON.stringify(bodies)).not.toContain(
        "NATIVE_CONTEXT_SHOULD_NOT_REPLACE_HOST_SNAPSHOT",
      );
      expect(JSON.stringify(bodies.at(-1)?.input)).toContain("Run exec and answer.");
      const files = await NodeFSP.readdir(NodePath.join(nativeHome, ".fx"));
      expect(files).not.toContain("chatgpt-auth.json");
      expect(await NodeFSP.readFile(authPath, "utf8")).toContain("rotated");
    } finally {
      await session?.close();
      await proxy.close();
      await auth.drain();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
