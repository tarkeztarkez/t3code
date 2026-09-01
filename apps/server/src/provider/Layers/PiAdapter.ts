import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EventId,
  RuntimeItemId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors";
import { PiRpcProcess } from "../piRpcProcess";
import { PI_COMPAT_EXTENSION_PATH } from "../piClaudeCompatibility";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter";

const PROVIDER = "pi" as const;

interface PiSessionContext {
  session: ProviderSession;
  readonly rpc: PiRpcProcess;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId?: TurnId;
  assistantItemId?: string;
  settle: (() => void) | undefined;
  stopped: boolean;
}

function responseData(response: Record<string, unknown>): Record<string, unknown> {
  return response.data && typeof response.data === "object"
    ? (response.data as Record<string, unknown>)
    : {};
}

function modelRef(slug: string): { provider: string; modelId: string } {
  const separator = slug.indexOf("/");
  return separator > 0
    ? { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) }
    : { provider: "anthropic", modelId: slug };
}

function makePiAdapter() {
  return Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    const stamp = () => ({
      eventId: EventId.make(crypto.randomUUID()),
      createdAt: new Date().toISOString(),
    });
    const emit = (event: ProviderRuntimeEvent) => {
      runFork(PubSub.publish(events, event));
    };
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const handleEvent = (threadId: ThreadId, event: Record<string, unknown>) => {
      const context = sessions.get(threadId);
      if (!context || context.stopped) return;
      const turnId = context.activeTurnId;
      const raw = { source: "pi.rpc" as const, method: String(event.type), payload: event };

      if (
        event.type === "extension_ui_request" &&
        event.method === "setStatus" &&
        event.statusKey === "t3-codex-usage" &&
        typeof event.statusText === "string"
      ) {
        try {
          emit({
            type: "account.rate-limits.updated",
            ...stamp(),
            provider: PROVIDER,
            threadId,
            payload: { rateLimits: JSON.parse(event.statusText) },
            raw,
          });
        } catch {
          // Ignore malformed extension status messages.
        }
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (update?.type === "text_start") {
          context.assistantItemId = crypto.randomUUID();
          emit({
            type: "item.started",
            ...stamp(),
            provider: PROVIDER,
            threadId,
            turnId,
            itemId: RuntimeItemId.make(context.assistantItemId),
            payload: { itemType: "assistant_message", status: "inProgress" },
            raw,
          });
        } else if (update?.type === "text_delta" && typeof update.delta === "string") {
          emit({
            type: "content.delta",
            ...stamp(),
            provider: PROVIDER,
            threadId,
            turnId,
            ...(context.assistantItemId
              ? { itemId: RuntimeItemId.make(context.assistantItemId) }
              : {}),
            payload: { streamKind: "assistant_text", delta: update.delta },
            raw,
          });
        } else if (update?.type === "text_end" && context.assistantItemId) {
          emit({
            type: "item.completed",
            ...stamp(),
            provider: PROVIDER,
            threadId,
            turnId,
            itemId: RuntimeItemId.make(context.assistantItemId),
            payload: { itemType: "assistant_message", status: "completed" },
            raw,
          });
        }
      } else if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        const id = String(event.toolCallId ?? crypto.randomUUID());
        const toolName = String(event.toolName ?? "tool");
        const completed = event.type === "tool_execution_end";
        emit({
          type: completed
            ? "item.completed"
            : event.type === "tool_execution_start"
              ? "item.started"
              : "item.updated",
          ...stamp(),
          provider: PROVIDER,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(id),
          payload: {
            itemType:
              toolName === "bash"
                ? "command_execution"
                : toolName === "write" || toolName === "edit"
                  ? "file_change"
                  : "dynamic_tool_call",
            status: completed ? (event.isError === true ? "failed" : "completed") : "inProgress",
            title: toolName,
            data: event,
          },
          raw,
        });
      } else if (event.type === "agent_settled") {
        context.settle?.();
        context.settle = undefined;
      }
    };

    const stopInternal = (context: PiSessionContext) =>
      Effect.sync(() => {
        if (context.stopped) return;
        context.stopped = true;
        context.rpc.stop();
        sessions.delete(context.session.threadId);
        emit({
          type: "session.exited",
          ...stamp(),
          provider: PROVIDER,
          threadId: context.session.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (input.provider && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopInternal(existing);

        const settings = yield* settingsService.getSettings.pipe(
          Effect.map((value) => value.providers.pi),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const cwd = resolve(input.cwd);
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const resume = input.resumeCursor as { sessionFile?: unknown } | undefined;
        const args = [
          "--mode",
          "rpc",
          "--no-extensions",
          "--extension",
          PI_COMPAT_EXTENSION_PATH,
          "--name",
          String(input.threadId),
        ];
        if (model) args.push("--model", model);
        if (typeof resume?.sessionFile === "string") args.push("--session", resume.sessionFile);

        const rpc = new PiRpcProcess(settings.binaryPath, args, cwd, (event) =>
          handleEvent(input.threadId, event),
        );
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(model ? { model } : {}),
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };
        const context: PiSessionContext = {
          session,
          rpc,
          turns: [],
          settle: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, context);
        const state = yield* Effect.tryPromise({
          try: () => rpc.command({ type: "get_state" }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });
        const sessionFile = responseData(state).sessionFile;
        context.session = {
          ...session,
          ...(typeof sessionFile === "string" ? { resumeCursor: { sessionFile } } : {}),
        };
        emit({
          type: "session.started",
          ...stamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { message: "Pi RPC session started", resume: context.session.resumeCursor },
        });
        emit({
          type: "thread.started",
          ...stamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: typeof sessionFile === "string" ? sessionFile : undefined },
        });
        return context.session;
      });

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const text = input.input?.trim() ?? "";
        if (!text && !input.attachments?.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const selection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        if (selection?.model && selection.model !== context.session.model) {
          yield* Effect.tryPromise({
            try: () => context.rpc.command({ type: "set_model", ...modelRef(selection.model) }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_model",
                detail: String(cause),
                cause,
              }),
          });
        }
        if (selection?.options?.effort) {
          yield* Effect.tryPromise({
            try: () =>
              context.rpc.command({ type: "set_thinking_level", level: selection.options!.effort }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_thinking_level",
                detail: String(cause),
                cause,
              }),
          });
        }
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        for (const attachment of input.attachments ?? []) {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) continue;
          const bytes = yield* Effect.tryPromise({
            try: () => readFile(path),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "read_attachment",
                detail: String(cause),
                cause,
              }),
          });
          images.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        const turnId = TurnId.make(crypto.randomUUID());
        context.activeTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: new Date().toISOString(),
          ...(selection ? { model: selection.model } : {}),
        };
        emit({
          type: "turn.started",
          ...stamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            model: selection?.model ?? context.session.model,
            effort: selection?.options?.effort,
          },
        });
        const settled = new Promise<void>((resolve) => {
          context.settle = resolve;
        });
        yield* Effect.tryPromise({
          try: () =>
            context.rpc.command({
              type: "prompt",
              message: text || "Describe the attached image.",
              ...(images.length ? { images } : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: String(cause),
              cause,
            }),
        });
        yield* Effect.tryPromise({
          try: () => settled,
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: String(cause),
              cause,
            }),
        });
        context.turns.push({ id: turnId, items: [{ input: text }] });
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
        };
        emit({
          type: "turn.completed",
          ...stamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed" },
        });
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      });

    const unsupported = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "Pi does not expose interactive approval requests.",
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(events)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        requireSession(threadId).pipe(
          Effect.flatMap((context) =>
            Effect.tryPromise({
              try: () => context.rpc.command({ type: "abort" }).then(() => undefined),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "abort",
                  detail: String(cause),
                  cause,
                }),
            }),
          ),
        ),
      respondToRequest: () => unsupported("respondToRequest"),
      respondToUserInput: () => unsupported("respondToUserInput"),
      stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopInternal)),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => ({ ...context.session }))),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((context) => ({ threadId, turns: context.turns })),
        ),
      rollbackThread: (threadId, numTurns) =>
        requireSession(threadId).pipe(
          Effect.map((context) => {
            context.turns.splice(Math.max(0, context.turns.length - numTurns));
            return { threadId, turns: context.turns };
          }),
        ),
      stopAll: () => Effect.forEach(sessions.values(), stopInternal, { discard: true }),
      streamEvents: Stream.fromPubSub(events),
    } satisfies PiAdapterShape;
  });
}

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive() {
  return Layer.effect(PiAdapter, makePiAdapter());
}
