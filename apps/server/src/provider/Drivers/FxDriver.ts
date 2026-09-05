import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import {
  FxSettings,
  TextGenerationError,
  type ServerProvider,
  type ProviderRuntimeEvent,
  type ModelSelection,
} from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { ServerConfig } from "../../config.ts";
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildBranchNamePrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { makeFxCodexAuth } from "../fx/FxCodexAuth.ts";
import { makeFxCodexTransport } from "../fx/FxCodexTransport.ts";
import { makeFxRuntime, FX_DRIVER } from "../fx/FxRuntime.ts";
import { openFxNativeSession } from "../fx/FxNativeSession.ts";
import { openFxCodexProxy } from "../fx/FxCodexProxy.ts";
import { prepareFxRequest } from "../fx/FxWire.ts";
import { record, string } from "../fx/FxTools.ts";
import { createPromptSnapshot } from "../../../../../scripts/fx/cache.mjs";
import { loadContext } from "../../../../../scripts/fx/context.mjs";
import { mergeFxModels } from "../fx/FxModels.ts";

// Refresh token rotation is serialized across fx instances using the same home.
const authManagers = new Map<string, { auth: ReturnType<typeof makeFxCodexAuth>; users: number }>();
const decodeFxSettings = Schema.decodeSync(FxSettings);
const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );
export type FxDriverEnv = ServerConfig;
export const FxDriver: ProviderDriver<FxSettings, FxDriverEnv> = {
  driverKind: FX_DRIVER,
  metadata: { displayName: "fx" },
  configSchema: FxSettings,
  defaultConfig: () => decodeFxSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const platform = yield* HostProcessPlatform;
      const arch = yield* HostProcessArchitecture;
      const environment = mergeProviderInstanceEnvironment(input.environment);
      const home = NodePath.resolve(
        environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir(),
      );
      const releaseDir = NodeURL.fileURLToPath(new URL("./fx/", import.meta.url)).replace(
        /([\\/]app\.asar)(?=[\\/])/,
        "$1.unpacked",
      );
      const developmentDir = NodeURL.fileURLToPath(
        new URL("../../../../../.fx-build/runtime/", import.meta.url),
      );
      const runtimeDir =
        environment.T3_FX_RUNTIME_DIR ??
        ((yield* Effect.promise(() => exists(releaseDir))) ? releaseDir : developmentDir);
      const binary =
        input.config.binaryPath ||
        NodePath.join(runtimeDir, platform === "win32" ? "fx.exe" : "fx");
      const codeBinary =
        input.config.codeBinaryPath ||
        NodePath.join(runtimeDir, platform === "win32" ? "fx-code-worker.exe" : "fx-code-worker");
      const workerPath = NodePath.join(runtimeDir, "worker-core.mjs");
      const authKey = yield* Effect.promise(() =>
        NodeFSP.realpath(NodePath.join(home, ".codex/auth.json")).catch(() =>
          NodePath.join(home, ".codex/auth.json"),
        ),
      );
      let shared = authManagers.get(authKey);
      if (!shared) {
        shared = { auth: makeFxCodexAuth({ homeDirectory: home, fetch }), users: 0 };
        authManagers.set(authKey, shared);
      }
      shared.users++;
      const manager = shared;
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const snapshots = yield* PubSub.unbounded<ServerProvider>();
      const storage = NodePath.join(server.stateDir, "fx", input.instanceId);
      const runtime = makeFxRuntime({
        instanceId: input.instanceId,
        home,
        storage,
        binary,
        codeBinary,
        workerPath,
        attachmentsDir: server.attachmentsDir,
        environment,
        platform,
        arch,
        auth: manager.auth,
        fetch,
        mcpServers: input.config.mcpServers,
        emit: (event) => {
          PubSub.publishUnsafe(events, event);
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await runtime.close();
          manager.users--;
          await manager.auth.drain();
          if (manager.users === 0) authManagers.delete(authKey);
        }),
      );
      const capabilities = {
        optionDescriptors: [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: "Reasoning",
            options: ["low", "medium", "high", "xhigh"].map((value) => ({
              value,
              label: value,
              isDefault: value === "medium",
            })),
          }),
        ],
      };
      const base: ServerProvider = {
        instanceId: input.instanceId,
        driver: FX_DRIVER,
        displayName: input.displayName ?? "fx",
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: `fx:${home}` },
        showInteractionModeToggle: true,
        enabled: input.enabled && input.config.enabled,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: new Date().toISOString(),
        models: [],
        slashCommands: [],
        skills: [],
      };
      let snapshot = base;
      const check = async (): Promise<ServerProvider> => {
        const installed = (await Promise.all([binary, codeBinary, workerPath].map(exists))).every(
          Boolean,
        );
        let next: ServerProvider = {
          ...base,
          checkedAt: new Date().toISOString(),
          installed,
          version: installed ? "0.0.7" : null,
        };
        if (!installed)
          next = {
            ...next,
            status: "error",
            message:
              "Native fx or its isolated worker is missing. Build the bundled fx runtime or configure its executable paths.",
          };
        else {
          try {
            const credential = await manager.auth.credentials();
            const transport = makeFxCodexTransport({
              auth: manager.auth,
              accountId: credential.accountId,
              fetch,
            });
            const response = await transport.models({
              clientVersion: "0.134.0",
              signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw new Error("Codex model catalog is unavailable");
            const data = record(await response.json());
            const models = (Array.isArray(data.models) ? data.models : []).flatMap((entry) => {
              const model = record(entry);
              const slug = typeof model.slug === "string" ? model.slug : model.id;
              if (typeof slug !== "string" || model.visibility === "hidden") return [];
              const efforts = Array.isArray(model.supported_reasoning_levels)
                ? model.supported_reasoning_levels.flatMap((level) => {
                    const effort = record(level).effort;
                    return typeof effort === "string"
                      ? [
                          {
                            value: effort,
                            label: effort,
                            isDefault: effort === model.default_reasoning_level,
                          },
                        ]
                      : [];
                  })
                : [];
              return [
                {
                  slug,
                  name: typeof model.display_name === "string" ? model.display_name : slug,
                  isCustom: false,
                  isDefault: slug === "gpt-5.4",
                  capabilities: efforts.length
                    ? {
                        optionDescriptors: [
                          buildSelectOptionDescriptor({
                            id: "reasoning",
                            label: "Reasoning",
                            options: efforts,
                          }),
                        ],
                      }
                    : capabilities,
                },
              ];
            });
            const merged = await mergeFxModels(
              models,
              environment.PI_CODING_AGENT_DIR ?? NodePath.join(home, ".pi/agent"),
            );
            next = {
              ...next,
              status: "ready",
              auth: { status: "authenticated", type: "Codex subscription" },
              models: merged.length
                ? merged
                : [
                    {
                      slug: "gpt-5.4",
                      name: "GPT-5.4",
                      isCustom: false,
                      isDefault: true,
                      capabilities,
                    },
                  ],
            };
          } catch (error) {
            next = {
              ...next,
              status: "error",
              auth: { status: "unknown" },
              message: error instanceof Error ? error.message : "Codex authentication failed",
            };
          }
        }
        snapshot = next;
        PubSub.publishUnsafe(snapshots, next);
        return next;
      };
      const attempt = <T>(method: string, run: () => Promise<T>) =>
        Effect.tryPromise({
          try: run,
          catch: (error) =>
            new ProviderAdapterRequestError({
              provider: "fx",
              method,
              detail: error instanceof Error ? error.message : "fx failed",
            }),
        });
      const generate = async (
        cwd: string,
        selection: ModelSelection,
        prompt: string,
        signal: AbortSignal,
      ) => {
        const credential = await manager.auth.credentials();
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-generate-"));
        const proxy = await openFxCodexProxy(
          makeFxCodexTransport({ auth: manager.auth, accountId: credential.accountId, fetch }),
          { prepare: (body) => prepareFxRequest(body) },
        );
        let native: Awaited<ReturnType<typeof openFxNativeSession>> | undefined;
        let text = "";
        try {
          const snapshot = createPromptSnapshot({
            accountId: credential.accountId,
            threadId: `text-generation:${input.instanceId}`,
            instructions: "Return only the requested JSON object. Do not execute tools.",
            tools: [],
          });
          native = await openFxNativeSession({
            binaryPath: binary,
            cwd,
            nativeHome: root,
            model: selection.model,
            proxyUrl: proxy.baseUrl,
            environment,
            instructions: snapshot.instructions,
            promptCacheKey: snapshot.promptCacheKey,
            tools: [],
            onToolCall: async () => ({
              content: "Tools are unavailable for text generation",
              isError: true,
            }),
            onNotification: (method, params) => {
              if (method !== "session/update") return;
              const update = record(record(params).update);
              if (update.sessionUpdate === "agent_message_chunk") {
                const block = record(update.content);
                if (block.type === "text") text += string(block.text);
                if (text.length > 100000) throw new Error("Generated text exceeds limit");
              }
            },
          });
          await native.prompt([{ type: "text", text: prompt }], signal);
          const start = text.indexOf("{");
          const end = text.lastIndexOf("}");
          return JSON.parse(text.slice(start, end + 1)) as unknown;
        } finally {
          await native?.close();
          await proxy.close();
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      };
      const json = <A>(
        operation: string,
        cwd: string,
        selection: ModelSelection,
        built: { prompt: string; outputSchema: Schema.Codec<A, unknown> },
      ) =>
        Effect.tryPromise({
          try: async (signal) =>
            // Shared prompt builders choose their result schema per request.
            // oxlint-disable-next-line t3code/no-inline-schema-compile
            Schema.decodeUnknownSync(built.outputSchema)(
              await generate(
                cwd,
                selection,
                built.prompt,
                AbortSignal.any([signal, AbortSignal.timeout(180000)]),
              ),
            ),
          catch: () =>
            new TextGenerationError({
              operation,
              detail: "fx could not generate the requested JSON.",
            }),
        });
      const textGeneration: TextGenerationShape = {
        generateCommitMessage: (value) =>
          json(
            "generateCommitMessage",
            value.cwd,
            value.modelSelection,
            buildCommitMessagePrompt(value),
          ).pipe(
            Effect.map((result) => ({ ...result, subject: sanitizeCommitSubject(result.subject) })),
          ),
        generatePrContent: (value) =>
          json(
            "generatePrContent",
            value.cwd,
            value.modelSelection,
            buildPrContentPrompt(value),
          ).pipe(Effect.map((result) => ({ ...result, title: sanitizePrTitle(result.title) }))),
        generateBranchName: (value) =>
          json(
            "generateBranchName",
            value.cwd,
            value.modelSelection,
            buildBranchNamePrompt(value),
          ).pipe(Effect.map((result) => ({ branch: sanitizeBranchFragment(result.branch) }))),
        generateThreadTitle: (value) =>
          json(
            "generateThreadTitle",
            value.cwd,
            value.modelSelection,
            buildThreadTitlePrompt(value),
          ).pipe(Effect.map((result) => ({ title: sanitizeThreadTitle(result.title) }))),
      };
      // Checking credentials happens on refresh, not from a background paid turn.
      yield* Effect.promise(check);
      return {
        instanceId: input.instanceId,
        driverKind: FX_DRIVER,
        continuationIdentity: { driverKind: FX_DRIVER, continuationKey: `fx:${home}` },
        displayName: input.displayName,
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: base.enabled,
        snapshot: {
          maintenanceCapabilities: { provider: FX_DRIVER, packageName: null, update: null },
          getSnapshot: Effect.sync(() => snapshot),
          refresh: Effect.promise(check),
          streamChanges: Stream.fromPubSub(snapshots),
        },
        adapter: {
          provider: FX_DRIVER,
          capabilities: { sessionModelSwitch: "in-session" },
          startSession: (value) => attempt("startSession", () => runtime.startSession(value)),
          sendTurn: (value) => attempt("sendTurn", () => runtime.sendTurn(value)),
          interruptTurn: (id) => attempt("interruptTurn", () => runtime.interrupt(id)),
          respondToRequest: (id, requestId, decision) =>
            attempt("respondToRequest", async () => runtime.respond(id, requestId, decision)),
          respondToUserInput: (id, requestId, answers) =>
            attempt("respondToUserInput", async () => runtime.respond(id, requestId, answers)),
          stopSession: (id) => attempt("stopSession", () => runtime.stop(id)),
          listSessions: () => Effect.sync(runtime.listSessions),
          listSkills: (cwd) =>
            attempt("listSkills", async () =>
              (
                await loadContext({
                  cwd,
                  home,
                  agentDir: environment.PI_CODING_AGENT_DIR ?? NodePath.join(home, ".pi/agent"),
                })
              ).skills.map((skill) => ({ ...skill, enabled: true })),
            ),
          hasSession: (id) => Effect.sync(() => runtime.hasSession(id)),
          readThread: (id) => attempt("readThread", async () => runtime.readThread(id)),
          rollbackThread: (id, count) =>
            attempt("rollbackThread", () => runtime.rollback(id, count)),
          stopAll: () => attempt("stopAll", runtime.close),
          streamEvents: Stream.fromPubSub(events),
        },
        textGeneration,
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (error) =>
          new ProviderDriverError({
            driver: FX_DRIVER,
            instanceId: input.instanceId,
            detail: String(error),
          }),
      ),
    ),
};
