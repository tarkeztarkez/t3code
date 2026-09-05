// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
// @effect-diagnostics globalDate:off - Native protocol timestamps use wall time outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, test } from "vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { makeFxCodexAuth } from "./FxCodexAuth.ts";
import { makeFxRuntime } from "./FxRuntime.ts";

const binary = process.env.FX_NATIVE_BINARY;
const codeBinary = process.env.FX_ISOLATED_BINARY;
test.skipIf(!binary || !codeBinary)(
  "native T3 turns enforce approval, retain cache context, resume and roll back",
  async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-driver-test-"));
    const cwd = NodePath.join(home, "project");
    await NodeFSP.mkdir(cwd);
    await NodeFSP.mkdir(NodePath.join(home, ".codex"));
    await NodeFSP.writeFile(
      NodePath.join(home, ".codex/auth.json"),
      JSON.stringify({
        tokens: {
          access_token:
            "header." +
            Buffer.from(
              JSON.stringify({
                exp: Math.floor(Date.now() / 1000) + 3600,
                "https://api.openai.com/auth": {
                  chatgpt_account_id: "account",
                  chatgpt_user_id: "user",
                },
              }),
            ).toString("base64url") +
            ".signature",
          refresh_token: "refresh",
          account_id: "account",
        },
        last_refresh: new Date().toISOString(),
      }),
    );
    await NodeFSP.writeFile(NodePath.join(cwd, "AGENTS.md"), "KEEP_THIS_STABLE");
    const events: ProviderRuntimeEvent[] = [];
    const bodies: Record<string, unknown>[] = [];
    const waiters: {
      type: ProviderRuntimeEvent["type"];
      resolve: (event: ProviderRuntimeEvent) => void;
    }[] = [];
    const receipt = (type: ProviderRuntimeEvent["type"]) =>
      new Promise<ProviderRuntimeEvent>((resolve) => {
        waiters.push({ type, resolve });
      });
    const instanceId = ProviderInstanceId.make("fx-test");
    const threadId = ThreadId.make("fx-test-thread");
    let calls = 0;
    let quota: "off" | "denied" | "reserve" | "recovered" = "off";
    let toolCode = 'text(await tools.exec_command({cmd:"printf approved > result.txt"}));';
    const fakeFetch = async (url: string, init: RequestInit) => {
      if (url.endsWith("/oauth/token")) throw new Error("No real auth refresh is expected");
      if (url.endsWith("/wham/usage"))
        return Response.json({
          account_id: "account",
          user_id: "user",
          ...(quota === "denied"
            ? { rate_limit_upsell: { banner_type: "luna_reserve" } }
            : { rate_limit: { allowed: quota === "recovered" } }),
        });
      if (url.includes("/models"))
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
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      calls++;
      if (quota === "denied")
        return Response.json(
          { error: { code: "usage_limit_reached", message: "Fixture quota exhausted" } },
          { status: 429 },
        );
      const output =
        calls === 1 && quota === "off"
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", call_id: `call_${calls}`, name: "exec" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: JSON.stringify({ code: toolCode }),
              },
            ]
          : [
              { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
              { type: "response.output_text.delta", output_index: 0, delta: "Finished." },
            ];
      return new Response(
        [
          ...output,
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: {
                input_tokens: 512,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 256 },
              },
            },
          },
        ]
          .map((value) => `data: ${JSON.stringify(value)}`)
          .join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const runtime = makeFxRuntime({
      instanceId,
      home,
      storage: NodePath.join(home, "state"),
      binary: binary!,
      codeBinary: codeBinary!,
      workerPath: NodeURL.fileURLToPath(
        new URL("../../../../../scripts/fx/worker-core.mjs", import.meta.url),
      ),
      attachmentsDir: NodePath.join(home, "attachments"),
      environment: { PATH: process.env.PATH, FX_E2E_CODEX_CLIENT_VERSION: "0.153.1" },
      platform: "linux",
      arch: "x64",
      auth: makeFxCodexAuth({ homeDirectory: home, fetch: fakeFetch }),
      fetch: fakeFetch,
      mcpServers: {},
      emit: (event) => {
        events.push(event);
        const index = waiters.findIndex((w) => w.type === event.type);
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve(event);
      },
    });
    const input = {
      threadId,
      cwd,
      runtimeMode: "approval-required" as const,
      modelSelection: { instanceId, model: "gpt-5.4-mini" },
    };
    try {
      const session = await runtime.startSession(input);
      const approval = receipt("request.opened");
      const completion = receipt("turn.completed");
      await runtime.sendTurn({ threadId, input: "Write the file." });
      const request = await Promise.race([approval, completion]);
      expect(request, JSON.stringify(request)).toMatchObject({ type: "request.opened" });
      expect(await NodeFSP.stat(NodePath.join(cwd, "result.txt")).catch(() => null)).toBeNull();
      runtime.respond(threadId, request.requestId!, "accept");
      expect((await completion).payload).toMatchObject({ state: "completed" });
      expect(await NodeFSP.readFile(NodePath.join(cwd, "result.txt"), "utf8")).toBe("approved");
      expect(
        events.some(
          (event) => event.type === "content.delta" && event.payload.delta === "Finished.",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage.cachedInputTokens === 256,
        ),
      ).toBe(true);
      await runtime.stop(threadId);
      await NodeFSP.writeFile(NodePath.join(cwd, "AGENTS.md"), "CHANGED_AFTER_FIRST_TURN");
      await runtime.startSession({ ...input, resumeCursor: session.resumeCursor });
      const next = receipt("turn.completed");
      await runtime.sendTurn({ threadId, input: "Second turn." });
      expect((await next).payload).toMatchObject({ state: "completed" });
      expect(bodies.at(-1)?.instructions).toBe(bodies[0]?.instructions);
      expect(bodies.at(-1)?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
      expect(JSON.stringify(bodies)).not.toContain("CHANGED_AFTER_FIRST_TURN");
      expect(runtime.readThread(threadId).turns).toHaveLength(2);
      expect((await runtime.rollback(threadId, 1)).turns).toHaveLength(1);
      const afterRollback = receipt("turn.completed");
      await runtime.sendTurn({ threadId, input: "Replacement turn." });
      expect((await afterRollback).payload).toMatchObject({ state: "completed" });
      expect(JSON.stringify(bodies.at(-1)?.input)).not.toContain("Second turn.");
      expect(JSON.stringify(bodies.at(-1)?.input)).toContain("Write the file.");
      // A blocked question must settle when the turn is cancelled.
      calls = 0;
      toolCode =
        'text(await tools.request_user_input({questions:[{id:"q",header:"Choice",question:"Choose",options:[{label:"A",description:"First"}]}]}));';
      const question = receipt("user-input.requested");
      const cancelled = receipt("turn.completed");
      await runtime.sendTurn({ threadId, input: "Ask me." });
      expect(await Promise.race([question, cancelled])).toMatchObject({
        type: "user-input.requested",
      });
      await runtime.interrupt(threadId);
      expect((await cancelled).payload).toMatchObject({ state: "interrupted" });
      expect(events.findLastIndex((event) => event.type === "item.completed")).toBeLessThan(
        events.findLastIndex((event) => event.type === "turn.completed"),
      );
      quota = "denied";
      calls = 0;
      const exhausted = receipt("turn.completed");
      await runtime.sendTurn({
        threadId,
        input: "Quota test",
        modelSelection: { ...input.modelSelection, options: [{ id: "reasoning", value: "high" }] },
      });
      expect((await exhausted).payload).toMatchObject({ state: "failed" });
      expect(calls).toBe(1);
      expect(runtime.listSessions()[0]?.model).toBe("gpt-reserve");
      await runtime.stop(threadId);
      quota = "reserve";
      await runtime.startSession({ ...input, resumeCursor: session.resumeCursor });
      const reserveDone = receipt("turn.completed");
      await runtime.sendTurn({ threadId, input: "Continue with Reserve" });
      expect((await reserveDone).payload).toMatchObject({ state: "completed" });
      expect(bodies.at(-1)).toMatchObject({ model: "gpt-reserve", reasoning: { effort: "high" } });
      quota = "recovered";
      const recovered = receipt("turn.completed");
      await runtime.sendTurn({ threadId, input: "Ordinary usage is back" });
      expect((await recovered).payload).toMatchObject({ state: "completed" });
      expect(bodies.at(-1)).toMatchObject({ model: "gpt-5.4-mini", reasoning: { effort: "high" } });
    } finally {
      await runtime.close();
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
