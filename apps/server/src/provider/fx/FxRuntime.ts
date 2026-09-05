// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
// @effect-diagnostics globalDate:off - Native protocol timestamps use wall time outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  UserInputQuestion,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ThreadId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type CanonicalRequestType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { loadContext } from "../../../../../scripts/fx/context.mjs";
import { createPromptSnapshot } from "../../../../../scripts/fx/cache.mjs";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import type { FxCodexAuth, FxCodexFetch } from "./FxCodexAuth.ts";
import { makeFxCodexTransport } from "./FxCodexTransport.ts";
import { openFxCodexProxy } from "./FxCodexProxy.ts";
import { openFxNativeSession } from "./FxNativeSession.ts";
import { makeFxTools, FX_TOOLS, FX_TOOL_INSTRUCTIONS, record, string } from "./FxTools.ts";
import { makeFxMcp, loadFxMcpServers, type FxMcpServer } from "./FxMcp.ts";
import { prepareFxRequest } from "./FxWire.ts";
import { fxReserveStatus } from "./FxReserve.ts";

export const FX_DRIVER = ProviderDriverKind.make("fx");
type EventInput<E = ProviderRuntimeEvent> = E extends ProviderRuntimeEvent
  ? Omit<E, "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt" | "turnId">
  : never;
const errorText = (error: unknown) => (error instanceof Error ? error.message : "fx failed");
async function save(path: string, value: unknown) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
const Manifest = Schema.Struct({
  sessionId: Schema.String,
  accountId: Schema.String,
  model: Schema.String,
  effort: Schema.optionalKey(Schema.String),
  reserve: Schema.optionalKey(
    Schema.Struct({ model: Schema.String, effort: Schema.optionalKey(Schema.String) }),
  ),
  turns: Schema.Array(Schema.Struct({ id: Schema.String })),
  snapshot: Schema.Struct({
    instructions: Schema.String,
    promptCacheKey: Schema.String,
    prefixHash: Schema.String,
  }),
});
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const decodeQuestions = Schema.decodeUnknownSync(Schema.Array(UserInputQuestion));

export function makeFxRuntime(options: {
  instanceId: ProviderInstanceId;
  home: string;
  storage: string;
  binary: string;
  codeBinary: string;
  workerPath: string;
  attachmentsDir: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  auth: FxCodexAuth;
  fetch: FxCodexFetch;
  mcpServers: Readonly<Record<string, FxMcpServer>>;
  emit: (event: ProviderRuntimeEvent) => void;
}) {
  type State = {
    session: ProviderSession;
    dir: string;
    manifest: typeof Manifest.Type;
    native: Awaited<ReturnType<typeof openFxNativeSession>>;
    tools: Awaited<ReturnType<typeof makeFxTools>>;
    proxy: Awaited<ReturnType<typeof openFxCodexProxy>>;
    mcp: ReturnType<typeof makeFxMcp>;
    requests: Map<
      string,
      {
        requestType: CanonicalRequestType | undefined;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >;
    grants: Set<string>;
    turn?: { id: TurnId; controller: AbortController; task: Promise<void>; items: Set<string> };
    effort?: string;
    plan: boolean;
    closing: boolean;
    quota?: boolean;
    upstreamFailure?: string;
  };
  const sessions = new Map<ThreadId, State>();
  const starting = new Map<ThreadId, Promise<ProviderSession>>();
  const get = (id: ThreadId) => {
    const state = sessions.get(id);
    if (!state) throw new Error("Unknown fx session");
    return state;
  };
  const emit = (state: State, event: EventInput) =>
    options.emit({
      ...event,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: FX_DRIVER,
      providerInstanceId: options.instanceId,
      threadId: state.session.threadId,
      createdAt: new Date().toISOString(),
      ...(state.turn ? { turnId: state.turn.id } : {}),
    } as ProviderRuntimeEvent);
  const ask = (
    state: State,
    signal: AbortSignal,
    event: (requestId: RuntimeRequestId) => EventInput,
  ) => {
    signal.throwIfAborted();
    const id = RuntimeRequestId.make(NodeCrypto.randomUUID());
    const opened = event(id);
    const requestType = opened.type === "request.opened" ? opened.payload.requestType : undefined;
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        state.requests.delete(id);
        if (requestType)
          emit(state, {
            type: "request.resolved",
            requestId: id,
            payload: { requestType, decision: "cancel" },
          });
        else emit(state, { type: "user-input.resolved", requestId: id, payload: { answers: {} } });
        reject(new Error("Request cancelled"));
      };
      state.requests.set(id, {
        requestType,
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      emit(state, opened);
    });
  };
  const notification = (state: State, method: string, params: unknown) => {
    if (!state.turn || method !== "session/update") return;
    const update = record(record(params).update);
    if (
      update.sessionUpdate !== "agent_message_chunk" &&
      update.sessionUpdate !== "agent_thought_chunk"
    )
      return;
    const content = record(update.content);
    if (content.type !== "text" || typeof content.text !== "string") return;
    const thinking = update.sessionUpdate === "agent_thought_chunk";
    const id = RuntimeItemId.make(`${state.turn.id}:${thinking ? "reasoning" : "assistant"}`);
    if (!state.turn.items.has(id)) {
      state.turn.items.add(id);
      emit(state, {
        type: "item.started",
        itemId: id,
        payload: { itemType: thinking ? "reasoning" : "assistant_message", status: "inProgress" },
      });
    }
    emit(state, {
      type: "content.delta",
      itemId: id,
      payload: { streamKind: thinking ? "reasoning_text" : "assistant_text", delta: content.text },
    });
  };
  const reopen = (state: State, resumeSessionId?: string) =>
    openFxNativeSession({
      binaryPath: options.binary,
      cwd: state.session.cwd!,
      nativeHome: NodePath.join(state.dir, "native"),
      model: state.session.model!,
      proxyUrl: state.proxy.baseUrl,
      environment: options.environment,
      instructions: state.manifest.snapshot.instructions,
      tools: FX_TOOLS,
      promptCacheKey: state.manifest.snapshot.promptCacheKey,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      onNotification: (method, params) => notification(state, method, params),
      onToolCall: async (name, input, signal) => {
        const id = RuntimeItemId.make(NodeCrypto.randomUUID());
        emit(state, {
          type: "item.started",
          itemId: id,
          payload: {
            itemType: "dynamic_tool_call",
            title: name,
            status: "inProgress",
            data: { toolName: name, input },
          },
        });
        try {
          const result = await state.tools.call(name, input, signal);
          emit(state, {
            type: "item.completed",
            itemId: id,
            payload: {
              itemType: "dynamic_tool_call",
              title: name,
              status: result.isError ? "failed" : "completed",
              data: { toolName: name, output: result.content },
            },
          });
          return result;
        } catch (error) {
          emit(state, {
            type: "item.completed",
            itemId: id,
            payload: {
              itemType: "dynamic_tool_call",
              title: name,
              status: "failed",
              detail: errorText(error),
            },
          });
          return { content: errorText(error), isError: true };
        }
      },
      // Tool effects are authorized separately in the host, after decoding code.
      onPermission: async (params) => {
        const choices = record(params).options;
        const choice = Array.isArray(choices)
          ? choices.find((c) => record(c).kind === "allow_once")
          : undefined;
        return choice
          ? { outcome: { outcome: "selected", optionId: record(choice).optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
    });
  const startSession = async (input: ProviderSessionStartInput): Promise<ProviderSession> => {
    const pending = starting.get(input.threadId);
    if (pending) return pending;
    const existing = sessions.get(input.threadId);
    if (existing) return existing.session;
    const task = (async () => {
      if (!input.cwd) throw new Error("fx requires a working directory");
      const credential = await options.auth.credentials();
      const dir = NodePath.join(
        options.storage,
        NodeCrypto.createHash("sha256").update(input.threadId).digest("hex"),
      );
      await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
      const path = NodePath.join(dir, "session.json");
      const saved = await NodeFSP.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      let manifest = saved ? decodeManifest(JSON.parse(saved)) : undefined;
      if (manifest && manifest.accountId !== credential.accountId)
        throw new Error("The Codex account changed. Start a new thread for the new account.");
      if (input.resumeCursor && !manifest)
        throw new Error("The fx conversation is missing in this environment. Start a new thread.");
      const model = manifest?.reserve
        ? manifest.model
        : (input.modelSelection?.model ?? manifest?.model ?? "gpt-5.4");
      const mcp = makeFxMcp({
        servers: await loadFxMcpServers(
          options.home,
          input.cwd,
          options.environment.PI_CODING_AGENT_DIR ?? NodePath.join(options.home, ".pi/agent"),
          options.mcpServers,
        ),
        cwd: input.cwd,
        environment: options.environment,
        bridge: () => readMcpProviderSession(input.threadId),
      });
      let state: State;
      const tools = await makeFxTools({
        cwd: input.cwd,
        home: options.home,
        storage: dir,
        executable: options.codeBinary,
        workerPath: options.workerPath,
        environment: options.environment,
        platform: options.platform,
        arch: options.arch,
        authorize: async (name, value, signal) => {
          if (["request_user_input", "update_plan"].includes(name)) return;
          if (state.session.runtimeMode === "full-access" && !state.plan) return;
          if (name === "view_image") return;
          if (
            state.session.runtimeMode === "auto-accept-edits" &&
            name === "apply_patch" &&
            !state.plan
          )
            return;
          const key = JSON.stringify([name, value]);
          if (state.grants.has(key) && !state.plan) return;
          const decision = await ask(state, signal, (requestId) => ({
            type: "request.opened",
            requestId,
            payload: {
              requestType:
                name === "apply_patch" ? "file_change_approval" : "exec_command_approval",
              detail: `${state.plan ? "Plan mode: " : ""}${name}`,
              args: value,
              options: [
                { decision: "accept", label: "Allow once" },
                { decision: "acceptForSession", label: "Allow this exact action for this session" },
                { decision: "decline", label: "Decline" },
              ],
            },
          }));
          if (!["accept", "acceptForSession"].includes(String(decision)))
            throw new Error("User declined this tool action");
          if (decision === "acceptForSession") state.grants.add(key);
        },
        invoke: async (name, value, signal) => {
          if (name === "mcp") return mcp.call(value, signal);
          if (name === "request_user_input") {
            const questions = decodeQuestions(record(value).questions);
            if (!questions.length || questions.length > 8)
              throw new Error("Ask between one and eight questions");
            return ask(state, signal, (requestId) => ({
              type: "user-input.requested",
              requestId,
              payload: { questions },
            })).then((answers) => ({ answers }));
          }
          const data = record(value);
          if (!Array.isArray(data.plan)) throw new Error("Expected a plan array");
          const plan = data.plan.map((step) => {
            const p = record(step);
            const status = p.status === "in_progress" ? "inProgress" : p.status;
            if (status !== "inProgress" && status !== "pending" && status !== "completed")
              throw new Error("Invalid plan status");
            return { step: string(p.step), status } as const;
          });
          emit(state, {
            type: "turn.plan.updated",
            payload: {
              plan,
              ...(typeof data.explanation === "string" ? { explanation: data.explanation } : {}),
            },
          });
          return { updated: true };
        },
      });
      try {
        if (!manifest) {
          const context = await loadContext({
            cwd: input.cwd,
            home: options.home,
            agentDir:
              options.environment.PI_CODING_AGENT_DIR ?? NodePath.join(options.home, ".pi/agent"),
          });
          const snapshot = createPromptSnapshot({
            accountId: credential.accountId,
            threadId: input.threadId,
            tools: FX_TOOLS,
            instructions: `You are fx, a coding agent in T3 Code. Working directory: ${input.cwd}\n${FX_TOOL_INSTRUCTIONS}\n${tools.instructions}\n${context.prompt}`,
          });
          manifest = { sessionId: "", accountId: credential.accountId, model, turns: [], snapshot };
        }
        const proxy = await openFxCodexProxy(
          makeFxCodexTransport({
            auth: options.auth,
            accountId: credential.accountId,
            fetch: options.fetch,
          }),
          {
            prepare: async (body) => {
              const value = record(JSON.parse(body));
              if (state?.effort)
                value.reasoning = { ...record(value.reasoning ?? {}), effort: state.effort };
              return prepareFxRequest(JSON.stringify(value), tools.expandImages);
            },
            onStatus: (status) => {
              if (state && status === 429) state.quota = true;
              if (state?.turn && status >= 400)
                state.upstreamFailure = `Codex request failed with HTTP ${status}.`;
            },
            onEvent: (event) => {
              const value = record(event);
              if (
                state?.turn &&
                (value.type === "response.failed" ||
                  value.type === "error" ||
                  value.type === "response.incomplete")
              )
                state.upstreamFailure = `Codex returned ${value.type}.`;
              if (
                state &&
                (value.type === "response.failed" || value.type === "error") &&
                /usage_limit_reached|rate_limit_exceeded|quota_exceeded/.test(JSON.stringify(value))
              )
                state.quota = true;
              if (value.type !== "response.completed" || !state?.turn) return;
              const usage = record(record(value.response).usage);
              if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number")
                return;
              const cached = record(usage.input_tokens_details ?? {}).cached_tokens;
              emit(state, {
                type: "thread.token-usage.updated",
                payload: {
                  usage: {
                    usedTokens: usage.input_tokens + usage.output_tokens,
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
                  },
                },
              });
            },
          },
        );
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: FX_DRIVER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          model,
          createdAt: now,
          updatedAt: now,
        };
        // Callback closures are installed before opening ACP, but no tool can
        // run until sendTurn installs the active turn below.
        const partial = {
          session,
          dir,
          manifest,
          tools,
          proxy,
          mcp,
          requests: new Map(),
          grants: new Set<string>(),
          ...(manifest.effort ? { effort: manifest.effort } : {}),
          plan: false,
          closing: false,
        };
        state = { ...partial, native: undefined as unknown as State["native"] };
        try {
          state.native = await reopen(state, manifest.sessionId || undefined);
        } catch (error) {
          await proxy.close();
          throw error;
        }
        state.manifest = { ...manifest, sessionId: state.native.sessionId, model };
        state.session = { ...session, resumeCursor: { sessionId: state.native.sessionId } };
        await save(path, state.manifest);
        sessions.set(input.threadId, state);
        emit(state, { type: "session.started", payload: { resume: state.session.resumeCursor } });
        if (input.runtimeMode === "auto")
          emit(state, {
            type: "config.warning",
            payload: {
              summary:
                "fx asks for approval in Auto mode. It does not run a second paid model as a safety reviewer. Use Full access only when you trust the workspace.",
            },
          });
        return state.session;
      } catch (error) {
        await Promise.allSettled([tools.close(), mcp.close()]);
        throw error;
      }
    })();
    starting.set(input.threadId, task);
    try {
      return await task;
    } finally {
      starting.delete(input.threadId);
    }
  };
  const interrupt = async (id: ThreadId) => {
    const state = get(id);
    state.turn?.controller.abort();
    await state.turn?.task;
  };
  const stop = async (id: ThreadId) => {
    await starting.get(id)?.catch(() => undefined);
    const state = sessions.get(id);
    if (!state) return;
    state.closing = true;
    await interrupt(id);
    for (const request of state.requests.values()) request.reject(new Error("Session closed"));
    state.requests.clear();
    await Promise.allSettled([
      state.native.close(),
      state.tools.close(),
      state.proxy.close(),
      state.mcp.close(),
    ]);
    sessions.delete(id);
    emit(state, { type: "session.exited", payload: { reason: "Session closed" } });
  };
  return {
    startSession,
    async sendTurn(input: ProviderSendTurnInput) {
      const state = get(input.threadId);
      if (state.turn || state.closing) throw new Error("fx is busy or closing");
      const id = TurnId.make(NodeCrypto.randomUUID());
      const controller = new AbortController();
      const turn = { id, controller, task: Promise.resolve(), items: new Set<string>() };
      state.turn = turn;
      state.session = { ...state.session, status: "running", activeTurnId: id };
      emit(state, {
        type: "turn.started",
        payload: { model: input.modelSelection?.model ?? state.session.model! },
      });
      turn.task = (async () => {
        let failure: string | undefined;
        try {
          state.quota = false;
          delete state.upstreamFailure;
          if (state.native.isClosed()) {
            await state.native.close();
            state.native = await reopen(state, state.manifest.sessionId);
          }
          let model = input.modelSelection?.model;
          let restoredEffort: string | undefined;
          const previous = state.manifest.reserve;
          if (previous && (!model || model === previous.model || model === "gpt-reserve")) {
            const status = await fxReserveStatus(
              options.auth,
              options.fetch,
              state.manifest.accountId,
              previous.model,
            ).catch(() => undefined);
            if (status?.ordinaryUsageRecovered) {
              model = previous.model;
              restoredEffort = previous.effort;
              const { reserve: _reserve, ...manifest } = state.manifest;
              state.manifest = manifest;
              emit(state, {
                type: "model.rerouted",
                payload: {
                  fromModel: "gpt-reserve",
                  toModel: model,
                  reason: "Ordinary Codex usage recovered.",
                },
              });
            } else model = "gpt-reserve";
          } else if (previous) {
            const { reserve: _reserve, ...manifest } = state.manifest;
            state.manifest = manifest;
          }
          if (model && model !== state.session.model) {
            await state.native.setModel(model);
            state.session = { ...state.session, model };
            delete state.effort;
          }
          if (restoredEffort) state.effort = restoredEffort;
          const effort = input.modelSelection?.options?.find(
            (option) => option.id === "reasoning" || option.id === "reasoningEffort",
          )?.value;
          if (typeof effort === "string") state.effort = effort;
          state.plan = input.interactionMode === "plan";
          const backup = NodePath.join(state.dir, "turns", id);
          await NodeFSP.cp(NodePath.join(state.dir, "native/.fx"), backup, {
            recursive: true,
            mode: NodeFS.constants.COPYFILE_FICLONE,
          });
          const { effort: _oldEffort, ...manifest } = state.manifest;
          state.manifest = {
            ...manifest,
            ...(state.effort ? { effort: state.effort } : {}),
            model: state.session.model!,
            turns: [...state.manifest.turns, { id }],
          };
          await save(NodePath.join(state.dir, "session.json"), state.manifest);
          const prompt: unknown[] = [];
          if (input.input) prompt.push({ type: "text", text: input.input });
          for (const attachment of input.attachments ?? []) {
            const path = resolveAttachmentPath({
              attachmentsDir: options.attachmentsDir,
              attachment,
            });
            if (!path) throw new Error("Invalid attachment path");
            if (attachment.type === "image")
              prompt.push({
                type: "image",
                mimeType: attachment.mimeType,
                data: (await NodeFSP.readFile(path)).toString("base64"),
              });
            else prompt.push({ type: "text", text: `Attached file ${attachment.name}: ${path}` });
          }
          if (!prompt.length) throw new Error("A prompt or attachment is required");
          const result = record(await state.native.prompt(prompt, controller.signal));
          if (result.stopReason !== "end_turn" && result.stopReason !== "cancelled")
            failure = `fx stopped: ${String(result.stopReason)}`;
        } catch (error) {
          failure = errorText(error);
        } finally {
          await state.tools.cancelCell();
          failure ??= state.upstreamFailure;
          if (state.quota && !controller.signal.aborted && state.session.model !== "gpt-reserve") {
            const status = await fxReserveStatus(
              options.auth,
              options.fetch,
              state.manifest.accountId,
              state.session.model!,
            ).catch(() => undefined);
            if (status?.entryAllowed) {
              const previous = state.session.model!;
              try {
                await state.native.setModel("gpt-reserve");
                state.manifest = {
                  ...state.manifest,
                  model: "gpt-reserve",
                  reserve: { model: previous, ...(state.effort ? { effort: state.effort } : {}) },
                };
                state.session = { ...state.session, model: "gpt-reserve" };
                await save(NodePath.join(state.dir, "session.json"), state.manifest);
                emit(state, {
                  type: "model.rerouted",
                  payload: {
                    fromModel: previous,
                    toModel: "gpt-reserve",
                    reason:
                      "Codex authorized Luna Reserve. Send a message to continue with its separate limited allowance. No request was retried or credits redeemed.",
                  },
                });
                failure =
                  "Codex quota exhausted. Luna Reserve is available. Send a message to continue.";
              } catch {
                failure = "Codex quota exhausted. Select another model to continue.";
              }
            }
          }
          for (const itemId of turn.items)
            emit(state, {
              type: "item.completed",
              itemId: RuntimeItemId.make(itemId),
              payload: {
                itemType: itemId.endsWith(":reasoning") ? "reasoning" : "assistant_message",
                status: failure ? "failed" : "completed",
              },
            });
          emit(state, {
            type: "turn.completed",
            payload: {
              state: controller.signal.aborted ? "interrupted" : failure ? "failed" : "completed",
              ...(failure && !controller.signal.aborted ? { errorMessage: failure } : {}),
            },
          });
          const { activeTurnId: _active, ...session } = state.session;
          state.session = { ...session, status: "ready", updatedAt: new Date().toISOString() };
          delete state.turn;
        }
      })();
      return { threadId: input.threadId, turnId: id, resumeCursor: state.session.resumeCursor };
    },
    interrupt,
    respond(
      id: ThreadId,
      requestId: string,
      decision: ProviderApprovalDecision | ProviderUserInputAnswers,
    ) {
      const state = get(id);
      const pending = state.requests.get(requestId);
      if (!pending) throw new Error("Unknown or cancelled fx request");
      if ((typeof decision === "string") !== !!pending.requestType || decision === "acceptAlways")
        throw new Error("Unsupported response for this fx request");
      state.requests.delete(requestId);
      if (typeof decision === "string")
        emit(state, {
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: pending.requestType!, decision },
        });
      else
        emit(state, {
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: decision },
        });
      pending.resolve(decision);
    },
    readThread(id: ThreadId) {
      return {
        threadId: id,
        turns: get(id).manifest.turns.map((t) => ({ id: TurnId.make(t.id), items: [] })),
      };
    },
    async rollback(id: ThreadId, count: number) {
      const state = get(id);
      if (
        state.turn ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > state.manifest.turns.length
      )
        throw new Error("Invalid fx rollback");
      const keep = state.manifest.turns.length - count;
      const target = state.manifest.turns[keep]!;
      const source = NodePath.join(state.dir, "turns", target.id);
      const nativeDir = NodePath.join(state.dir, "native/.fx");
      const restored = NodePath.join(state.dir, "native/.restore");
      await NodeFSP.cp(source, restored, {
        recursive: true,
        mode: NodeFS.constants.COPYFILE_FICLONE,
      });
      await state.native.close();
      await NodeFSP.rename(nativeDir, NodePath.join(state.dir, "native/.previous"));
      try {
        await NodeFSP.rename(restored, nativeDir);
        state.native = await reopen(state, state.manifest.sessionId);
      } catch (error) {
        await NodeFSP.rm(nativeDir, { recursive: true, force: true });
        await NodeFSP.rename(NodePath.join(state.dir, "native/.previous"), nativeDir);
        state.native = await reopen(state, state.manifest.sessionId);
        throw error;
      }
      state.manifest = { ...state.manifest, turns: state.manifest.turns.slice(0, keep) };
      await save(NodePath.join(state.dir, "session.json"), state.manifest);
      await NodeFSP.rm(NodePath.join(state.dir, "native/.previous"), {
        recursive: true,
        force: true,
      });
      return {
        threadId: id,
        turns: state.manifest.turns.map((t) => ({ id: TurnId.make(t.id), items: [] })),
      };
    },
    listSessions: () => [...sessions.values()].map((s) => s.session),
    hasSession: (id: ThreadId) => sessions.has(id),
    stop,
    async close() {
      await Promise.allSettled(starting.values());
      await Promise.allSettled([...sessions.keys()].map(stop));
      await options.auth.drain();
    },
  };
}
