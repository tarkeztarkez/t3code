// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
// @effect-diagnostics preferSchemaOverJson:off - Protocol fixtures intentionally build wire JSON outside production codecs.
// @effect-diagnostics globalDateInEffect:off - Fixture OAuth timestamps must match the native process clock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { layerTest } from "../../config.ts";
import { FxDriver } from "./FxDriver.ts";

it.effect.skipIf(!process.env.FX_NATIVE_BINARY || !process.env.FX_ISOLATED_BINARY)(
  "fx materializes a selectable instance and native text generation with fake credentials",
  () =>
    Effect.gen(function* () {
      const { home, getCalls } = yield* Effect.promise(async () => {
        const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-instance-"));
        await NodeFSP.mkdir(NodePath.join(home, ".codex"));
        await NodeFSP.mkdir(NodePath.join(home, ".pi/agent/skills/test"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(home, ".pi/agent/skills/test/SKILL.md"),
          "---\nname: fixture\ndescription: Test skill\n---\nDo not use real credentials.",
        );
        await NodeFSP.writeFile(
          NodePath.join(home, ".codex/auth.json"),
          JSON.stringify({
            tokens: {
              access_token: "fixture",
              refresh_token: "fixture-refresh",
              account_id: "fixture-account",
            },
            last_refresh: new Date().toISOString(),
          }),
        );
        await NodeFSP.writeFile(
          NodePath.join(home, ".pi/agent/models.json"),
          JSON.stringify({
            providers: {
              "openai-codex": {
                baseUrl: "https://untrusted.invalid",
                models: [
                  { id: "gpt-6-astra", name: "Custom Astra" },
                  { id: "custom-codex", name: "Custom model" },
                ],
              },
            },
          }),
        );
        let calls = 0;
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
          expect(url).toMatch(/^https:\/\/chatgpt.com\/backend-api\/codex\//);
          expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture");
          if (url.includes("/models"))
            return Response.json({
              models: [
                {
                  slug: "gpt-6-astra",
                  display_name: "Astra",
                  supported_reasoning_levels: [{ effort: "low" }],
                },
              ],
            });
          calls++;
          const body = JSON.parse(String(init.body));
          expect(new Headers(init.headers).get("x-openai-internal-codex-responses-lite")).toBe(
            "true",
          );
          expect(body.input[0]).toMatchObject({ type: "additional_tools", tools: [] });
          expect(body.input[1].content[0].text).toBe(
            "Return only the requested JSON object. Do not execute tools.",
          );
          return new Response(
            [
              { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
              {
                type: "response.output_text.delta",
                output_index: 0,
                delta: '{"title":"Native fx works"}',
              },
              {
                type: "response.completed",
                response: { status: "completed", usage: { input_tokens: 100, output_tokens: 8 } },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        });

        return { home, getCalls: () => calls };
      });
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const instanceId = ProviderInstanceId.make("fx-fixture");
            const instance = yield* FxDriver.create({
              instanceId,
              displayName: undefined,
              enabled: true,
              environment: [
                {
                  name: "PI_CODING_AGENT_DIR",
                  value: NodePath.join(home, ".pi/agent"),
                  sensitive: false,
                },
                { name: "HOME", value: home, sensitive: false },
                {
                  name: "T3_FX_RUNTIME_DIR",
                  value: NodePath.dirname(process.env.FX_NATIVE_BINARY!),
                  sensitive: false,
                },
              ],
              config: {
                ...FxDriver.defaultConfig(),
                binaryPath: process.env.FX_NATIVE_BINARY!,
                codeBinaryPath: process.env.FX_ISOLATED_BINARY!,
              },
            });
            const snapshot = yield* instance.snapshot.getSnapshot;
            expect(snapshot).toMatchObject({
              driver: "fx",
              instanceId,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
            });
            expect(snapshot.models.find((model) => model.slug === "gpt-6-astra")?.name).toBe(
              "Custom Astra",
            );
            expect((yield* instance.snapshot.refresh).models).toEqual(snapshot.models);
            expect(yield* instance.adapter.listSkills!(home)).toContainEqual(
              expect.objectContaining({ name: "fixture", enabled: true }),
            );
            expect(
              yield* instance.textGeneration.generateThreadTitle({
                cwd: home,
                message: "Check the native fx integration",
                modelSelection: { instanceId, model: "gpt-6-astra" },
              }),
            ).toEqual({ title: "Native fx works" });
          }),
        ).pipe(
          Effect.provide(
            layerTest(home, NodePath.join(home, "state")).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        expect(getCalls()).toBe(1);
        expect(
          yield* Effect.promise(() => NodeFSP.stat(NodePath.join(home, ".fx")).catch(() => null)),
        ).toBeNull();
      } finally {
        vi.unstubAllGlobals();
        yield* Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true }));
      }
    }),
  30000,
);
