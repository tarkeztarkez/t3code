import {
  EventId,
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProviderSkill,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { toToolLifecycleItemType } from "@t3tools/shared/toolLifecycle";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  decodePiMessagesResponseDataExit,
  decodePiSessionStatsExit,
  decodePiStateResponseDataExit,
  parsePiApprovalTitle,
  parsePiUserInputTitle,
  parsePiModelSlug,
  PI_APPROVAL_TITLE_PREFIX,
  PI_BUNDLED_EXTENSIONS,
  PI_USER_INPUT_TITLE_PREFIX,
  PiRuntime,
  type PiApprovalRequestPayload,
  type PiCommand,
  type PiMessageContent,
  type PiRpcEvent,
  type PiRpcHandle,
  type PiSessionStats,
  type PiToolResult,
  PiRuntimeError,
  nonEmptyDetail,
  piRuntimeErrorDetail,
  toPiApprovalSelection,
} from "../piRuntime.ts";
import { PI_CODEX_CONVERSION_DEFAULT_CONFIG } from "../pi/default-config.ts";
import { discoverPiSkills, findReferencedPiSkills } from "../Drivers/PiSkills.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const encodeJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const PI_MCP_BRIDGE_TOKEN_ENV = "T3_MCP_BEARER_TOKEN";
const PI_SKILL_INVENTORY_CACHE_MS = 4_000;
const PI_RESUME_CURSOR_VERSION = 1 as const;
const PI_SUBAGENTS_FLEET_PREFIX = "T3_SUBAGENTS ";
const PI_NOTEBOOK_SUMMARY_MODEL = "gpt-5.6-luna";
const PI_NOTEBOOK_SUMMARY_MAX_CODE_CHARS = 20_000;
const PiSubagentFleet = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
    title: Schema.String,
    status: Schema.Literals([
      "queued",
      "starting",
      "running",
      "paused",
      "completed",
      "failed",
      "interrupted",
    ]),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    summary: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
);
const decodePiSubagentFleetExit = Schema.decodeUnknownExit(Schema.fromJsonString(PiSubagentFleet));
const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(PI_RESUME_CURSOR_VERSION),
  sessionId: Schema.String,
});
const decodePiResumeCursorExit = Schema.decodeUnknownExit(PiResumeCursor);

function parsePiResumeCursor(raw: unknown): { readonly sessionId: string } | undefined {
  const decoded = decodePiResumeCursorExit(raw);
  if (Exit.isFailure(decoded)) return undefined;
  const sessionId = decoded.value.sessionId.trim();
  return sessionId.length > 0 ? { sessionId } : undefined;
}

const PI_T3_BROWSER_SYSTEM_PROMPT = `
## T3 Code collaborative browser

T3 Code exposes its in-app collaborative browser through the configured MCP server named "t3-code".

For browser work, first try direct preview tools such as preview_status, preview_open, preview_navigate, and preview_snapshot if they are available.

If direct preview tools are not available, use the Pi MCP proxy tool:
- mcp({ search: "preview" }) to discover the T3 preview tools.
- mcp({ tool: "preview_status", args: "{}" }) before deciding browser automation is unavailable.
- mcp({ tool: "preview_open", args: "{}" }) if no automation-capable preview is attached.
- Use the discovered preview_navigate, preview_snapshot, and focused interaction tools through mcp({ tool, args }) for browser navigation, inspection, interaction, screenshots, and recordings.

Do not switch to Pi agent-browser, global Chrome automation, standalone Playwright, or another external browser merely because a preview MCP call fails. Inspect actionable preview MCP errors and retry with corrected arguments where appropriate.
`.trim();

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type PiMcpBridge =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Ready";
      readonly configPath: string;
      readonly bridgeDir: string;
      readonly providerSessionId: string;
      readonly environment: NodeJS.ProcessEnv;
    }
  | {
      readonly _tag: "Failed";
      readonly providerSessionId: string;
      readonly detail: string;
    };

type PiMcpBridgeWarning =
  | {
      readonly _tag: "ConfigFailed";
      readonly bridge: Extract<PiMcpBridge, { readonly _tag: "Failed" }>;
    }
  | { readonly _tag: "SpawnRetried"; readonly detail: string };

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiPendingDialog {
  readonly method: string;
  readonly title: string;
  readonly options: ReadonlyArray<string>;
  readonly question?: UserInputQuestion;
}

type PiExtensionUiRequestEvent = Extract<PiRpcEvent, { readonly type: "extension_ui_request" }>;

interface PiSessionContext {
  session: ProviderSession;
  readonly itemIdNamespace: string;
  readonly rpc: PiRpcHandle;
  readonly pendingApprovals: Map<string, PiApprovalRequestPayload>;
  readonly pendingDialogs: Map<string, PiPendingDialog>;
  readonly subagentStatuses: Map<string, string>;
  activeTurnId: TurnId | undefined;
  currentModelSlug: string | undefined;
  currentThinking: string | undefined;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  messageSequence: number;
  toolSequence: number;
  compactionSequence: number;
  readonly fallbackToolCallIds: Map<string, Array<string>>;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly command?: PiCommand;
  readonly extensionPaths?: ReadonlyArray<string>;
}

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly raw?: unknown;
};

function approvalRequestType(
  tool: string,
): "command_execution_approval" | "file_change_approval" | "unknown" {
  const lifecycle = toToolLifecycleItemType(tool);
  if (lifecycle === "command_execution") return "command_execution_approval";
  if (lifecycle === "file_change") return "file_change_approval";
  return "unknown";
}

function toolDetailFromArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  if (toolName === "bash" && "command" in args && typeof args.command === "string") {
    return args.command;
  }
  if ("path" in args && typeof args.path === "string") return args.path;
  if ("file_path" in args && typeof args.file_path === "string") return args.file_path;
  return undefined;
}

function notebookCodeFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || !("code" in args)) return undefined;
  const code = args.code;
  return typeof code === "string" && code.trim().length > 0 ? code.trim() : undefined;
}

export function notebookToolSummaryPrompt(code: string): string {
  return [
    "Write one short past-tense activity label for this coding-agent notebook cell.",
    "Describe its purpose, not JavaScript mechanics. Use 3-10 words and at most 72 characters.",
    "Do not use quotes, markdown, a trailing period, or the words command, tool, or notebook.",
    "Return only the label.",
    "",
    code.slice(0, PI_NOTEBOOK_SUMMARY_MAX_CODE_CHARS),
  ].join("\n");
}

export function normalizeNotebookToolSummary(value: string): string | null {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/^['"`]+|['"`.]+$/gu, "")
    .trim();
  if (!firstLine) return null;
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 71).trimEnd()}…`;
}

function textFromContentBlocks(content: PiMessageContent | undefined): string {
  if (typeof content === "string") return content;
  return content?.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("") ?? "";
}

function toolResultText(result: PiToolResult | undefined): string | undefined {
  const text = textFromContentBlocks(result?.content);
  return text.length > 0 ? text : undefined;
}

function stripBearerPrefix(authorizationHeader: string): string {
  return authorizationHeader.replace(/^Bearer\s+/iu, "").trim();
}

function appendStderrDetail(detail: string, stderr: string): string {
  const trimmed = stripPiStartupTimings(stderr).trim();
  if (trimmed.length === 0) return detail;
  const separator = /[.!?]$/.test(detail.trim()) ? " stderr: " : ". stderr: ";
  return `${detail}${separator}${trimmed}`;
}

const PI_STARTUP_TIMING_HEADER = /^--- Startup Timings: (main|extensions) ---$/u;
const PI_STARTUP_TIMING_ENTRY = /^\s{2}(.+): (\d+)ms$/u;

type PiStartupTimingGroup = "main" | "extensions";

interface ParsedPiStartupTimings {
  readonly main: ReadonlyMap<string, number>;
  readonly extensions: ReadonlyMap<string, number>;
}

function parsePiStartupTimings(stderr: string): ParsedPiStartupTimings {
  const groups: Record<PiStartupTimingGroup, Map<string, number>> = {
    main: new Map(),
    extensions: new Map(),
  };
  let currentGroup: PiStartupTimingGroup | null = null;

  for (const rawLine of stderr.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    const header = PI_STARTUP_TIMING_HEADER.exec(line.trim());
    if (header) {
      currentGroup = header[1] as PiStartupTimingGroup;
      continue;
    }
    if (currentGroup === null) continue;
    if (/^-{3,}$/u.test(line.trim())) {
      currentGroup = null;
      continue;
    }
    const entry = PI_STARTUP_TIMING_ENTRY.exec(line);
    if (entry) groups[currentGroup].set(entry[1]!, Number(entry[2]));
  }

  return groups;
}

export function piStartupTimingAttributes(
  stderr: string,
  observedMs: number,
): Record<string, string | number> {
  const timings = parsePiStartupTimings(stderr);
  const attributes: Record<string, string | number> = {
    "pi.startup.observed_ms": observedMs,
  };
  for (const [label, durationMs] of timings.main) {
    const key = label
      .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
      .replace(/[^a-z\d]+/giu, "_")
      .toLowerCase();
    attributes[`pi.startup.main.${key}_ms`] = durationMs;
  }

  const extensionEntries = [...timings.extensions].filter(([label]) => label !== "TOTAL");
  const moduleImportMs = extensionEntries
    .filter(([label]) => label.endsWith(" module import"))
    .reduce((total, [, durationMs]) => total + durationMs, 0);
  const factoryMs = extensionEntries
    .filter(([label]) => label.endsWith(" factory"))
    .reduce((total, [, durationMs]) => total + durationMs, 0);
  const slowest = extensionEntries.reduce<readonly [string, number] | null>(
    (current, entry) => (current === null || entry[1] > current[1] ? entry : current),
    null,
  );
  const extensionsTotalMs = timings.extensions.get("TOTAL");
  if (extensionsTotalMs !== undefined) {
    attributes["pi.startup.extensions.total_ms"] = extensionsTotalMs;
    attributes["pi.startup.extensions.module_import_ms"] = moduleImportMs;
    attributes["pi.startup.extensions.factory_ms"] = factoryMs;
    attributes["pi.startup.extensions.count"] = extensionEntries.filter(([label]) =>
      label.endsWith(" module import"),
    ).length;
  }
  if (slowest) {
    const [label, durationMs] = slowest;
    const extensionPath = label.replace(/ (?:module import|factory)$/u, "");
    attributes["pi.startup.extensions.slowest"] =
      extensionPath.split(/[\\/]/u).at(-1) ?? extensionPath;
    attributes["pi.startup.extensions.slowest_path"] = extensionPath;
    attributes["pi.startup.extensions.slowest_ms"] = durationMs;
  }

  const mainTotalMs = timings.main.get("TOTAL");
  if (mainTotalMs !== undefined) {
    attributes["pi.startup.before_instrumentation_ms"] = Math.max(0, observedMs - mainTotalMs);
  }
  return attributes;
}

export function stripPiStartupTimings(stderr: string): string {
  return stderr
    .replace(/\n?--- Startup Timings: (?:main|extensions) ---[\s\S]*?\n-+\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function encodeJsonString(value: unknown): string {
  const encoded = encodeJsonStringExit(value);
  return Exit.isSuccess(encoded) ? encoded.value : "{}";
}

function mintToolItemId(context: PiSessionContext): string {
  context.toolSequence += 1;
  return namespacePiItemId(context, `pi-tool-${context.messageSequence}-${context.toolSequence}`);
}

function namespacePiItemId(context: PiSessionContext, itemId: string): string {
  return `${context.itemIdNamespace}:${itemId}`;
}

// Pi may include toolCallId on some lifecycle events and omit it on others for
// the same invocation, so starts enqueue their id per tool and id-less
// updates/ends resolve FIFO against the oldest in-flight invocation.
function fallbackToolCallItemId(
  context: PiSessionContext,
  event: PiRpcEvent,
  toolName: string,
): string {
  const key = toolName;
  const pending = context.fallbackToolCallIds.get(key);
  const explicitId =
    "toolCallId" in event &&
    typeof event.toolCallId === "string" &&
    event.toolCallId.trim().length > 0
      ? event.toolCallId.trim()
      : undefined;
  const explicit = explicitId ? namespacePiItemId(context, explicitId) : undefined;
  if (event.type === "tool_execution_start") {
    const itemId = explicit ?? mintToolItemId(context);
    if (pending) {
      pending.push(itemId);
    } else {
      context.fallbackToolCallIds.set(key, [itemId]);
    }
    return itemId;
  }
  if (explicit && pending?.includes(explicit)) {
    if (event.type === "tool_execution_end") {
      pending.splice(pending.indexOf(explicit), 1);
      if (pending.length === 0) context.fallbackToolCallIds.delete(key);
    }
    return explicit;
  }
  // An explicit id that was never queued means the start omitted toolCallId
  // and got a minted id; resolve FIFO so the lifecycle shares one item id.
  if (pending) {
    const oldest = event.type === "tool_execution_end" ? pending.shift() : pending[0];
    if (pending.length === 0) context.fallbackToolCallIds.delete(key);
    if (oldest !== undefined) return oldest;
  }
  return explicit ?? mintToolItemId(context);
}

function tokenUsageFromStats(stats: PiSessionStats): ThreadTokenUsageSnapshot | undefined {
  const { tokens, contextUsage } = stats;
  const asCount = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : undefined;
  const usedTokens = asCount(contextUsage?.tokens) ?? asCount(tokens?.total);
  if (usedTokens === undefined) return undefined;
  const maxTokens = asCount(contextUsage?.contextWindow);
  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(asCount(tokens?.input) !== undefined ? { inputTokens: asCount(tokens?.input) } : {}),
    ...(asCount(tokens?.cacheRead) !== undefined
      ? { cachedInputTokens: asCount(tokens?.cacheRead) }
      : {}),
    ...(asCount(tokens?.output) !== undefined ? { outputTokens: asCount(tokens?.output) } : {}),
    ...(asCount(stats.toolCalls) !== undefined ? { toolUses: asCount(stats.toolCalls) } : {}),
  };
}

function dialogQuestion(uiRequestId: string, dialog: PiPendingDialog): UserInputQuestion {
  if (dialog.question) return dialog.question;
  const options =
    dialog.method === "confirm"
      ? [
          { label: "Yes", description: "Confirm" },
          { label: "No", description: "Decline" },
        ]
      : dialog.options.map((option) => ({ label: option, description: option }));
  return {
    id: uiRequestId,
    header: "Pi",
    question: dialog.title,
    options,
    multiSelect: false,
  };
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return session;
}

function updateProviderSession(
  context: PiSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    let nextSession: ProviderSession = {
      ...context.session,
      ...patch,
      updatedAt,
    };
    if (options?.clearActiveTurnId) {
      const { activeTurnId, ...rest } = nextSession;
      void activeTurnId;
      nextSession = rest;
    }
    if (options?.clearLastError) {
      const { lastError, ...rest } = nextSession;
      void lastError;
      nextSession = rest;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const toRequestError = (cause: PiRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause,
  });

const stopPiContext = Effect.fn("stopPiContext")(function* (context: PiSessionContext) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* context.rpc
    .request({ type: "abort" }, { timeoutMs: 2_000 })
    .pipe(Effect.ignore({ log: true }));
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const serverConfig = yield* ServerConfig;
    const piRuntime = yield* PiRuntime;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const extensionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-" }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "makeTempDirectoryScoped",
            detail: "Failed to create Pi approval extension directory.",
            cause,
          }),
      ),
    );
    yield* Effect.forEach(
      PI_BUNDLED_EXTENSIONS,
      (extension) =>
        fs.writeFileString(path.join(extensionDir, extension.fileName), extension.source),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "writeFileString",
            detail: "Failed to write bundled Pi extensions.",
            cause,
          }),
      ),
    );
    const bundledExtensionPaths = PI_BUNDLED_EXTENSIONS.map((extension) =>
      path.join(extensionDir, extension.fileName),
    );
    const inventoryExtensionPaths = [
      path.join(extensionDir, "claude-compat.ts"),
      ...(options?.extensionPaths ?? []),
    ];
    const skillInventoryCache = new Map<
      string,
      { readonly checkedAt: number; readonly skills: ReadonlyArray<ServerProviderSkill> }
    >();
    const piAgentDir = path.join(serverConfig.stateDir, "pi");
    const userExtensionsPath = path.join(piAgentDir, "extensions");
    const codexConfigPath = path.join(piAgentDir, "pi-codex-conversion.json");
    yield* fs.makeDirectory(userExtensionsPath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "makeDirectory",
            detail: "Failed to create the Pi user extensions directory.",
            cause,
          }),
      ),
    );

    const codexConfigExists = yield* fs.exists(codexConfigPath);
    if (!codexConfigExists) {
      yield* fs.writeFileString(codexConfigPath, PI_CODEX_CONVERSION_DEFAULT_CONFIG);
    }

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: nowIso,
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "pi.rpc.event" as const, payload: input.raw } }
            : {}),
        })),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.gen(function* () {
              yield* Effect.ignoreCause(settlePendingRequestsAsCancelled(context));
              yield* Effect.ignoreCause(stopPiContext(context));
            }),
          { concurrency: "unbounded", discard: true },
        );
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const summarizeNotebookTool = Effect.fn("summarizeNotebookTool")(function* (
      context: PiSessionContext,
      turnId: TurnId | undefined,
      toolCallId: string,
      code: string,
    ) {
      const result = yield* piRuntime.runCommand({
        binaryPath: options?.command?.binaryPath ?? piSettings.binaryPath,
        ...(options?.command?.argsPrefix ? { argsPrefix: options.command.argsPrefix } : {}),
        args: [
          "--print",
          "--mode",
          "text",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--thinking",
          "minimal",
          "--provider",
          "openai-codex",
          "--model",
          PI_NOTEBOOK_SUMMARY_MODEL,
        ],
        stdin: notebookToolSummaryPrompt(code),
        ...(options?.environment ? { environment: options.environment } : {}),
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      });
      if (result.code !== 0) return;
      const summary = normalizeNotebookToolSummary(result.stdout);
      if (!summary) return;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "tool.summary",
        payload: { summary, precedingToolUseIds: [toolCallId] },
      });
    });
    const settlePendingRequestsAsCancelled = Effect.fn("settlePendingRequestsAsCancelled")(
      function* (context: PiSessionContext) {
        const threadId = context.session.threadId;
        const turnId = context.activeTurnId;
        for (const [requestId, approval] of context.pendingApprovals) {
          context.pendingApprovals.delete(requestId);
          yield* context.rpc.notify({
            type: "extension_ui_response",
            id: requestId,
            cancelled: true,
          });
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, requestId })),
            type: "request.resolved",
            payload: { requestType: approvalRequestType(approval.tool), decision: "cancel" },
          });
        }
        for (const [requestId] of context.pendingDialogs) {
          context.pendingDialogs.delete(requestId);
          yield* context.rpc.notify({
            type: "extension_ui_response",
            id: requestId,
            cancelled: true,
          });
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, requestId })),
            type: "user-input.resolved",
            payload: { answers: { [requestId]: "" } },
          });
        }
      },
    );
    const writeNativeEventBestEffort = (threadId: ThreadId, event: PiRpcEvent) =>
      nativeEventLogger
        ? Effect.flatMap(nowIso, (observedAt) =>
            nativeEventLogger.write(
              {
                observedAt,
                event: {
                  provider: PROVIDER,
                  threadId,
                  type: event.type,
                  payload: event,
                },
              },
              threadId,
            ),
          ).pipe(Effect.catchCause(() => Effect.void))
        : Effect.void;

    const makeMcpBridge = (
      threadId: ThreadId,
    ): Effect.Effect<PiMcpBridge, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
        if (!mcpSession) return { _tag: "Absent" } satisfies PiMcpBridge;

        const bridgeId = yield* randomUUIDv4;
        const bridgeDir = path.join(piAgentDir, "mcp", bridgeId);
        const configPath = path.join(bridgeDir, "mcp.json");
        const config = {
          settings: {
            toolPrefix: "none",
            disableProxyTool: false,
            directTools: false,
          },
          mcpServers: {
            "t3-code": {
              url: mcpSession.endpoint,
              auth: "bearer",
              bearerTokenEnv: PI_MCP_BRIDGE_TOKEN_ENV,
              lifecycle: "lazy",
              exposeResources: false,
            },
          },
        };

        const writeExit = yield* Effect.gen(function* () {
          yield* fs.makeDirectory(bridgeDir, { recursive: true });
          yield* fs.writeFileString(configPath, `${encodeJsonString(config)}\n`);
        }).pipe(Effect.exit);

        if (Exit.isFailure(writeExit)) {
          return {
            _tag: "Failed",
            providerSessionId: mcpSession.providerSessionId,
            detail: piRuntimeErrorDetail(Cause.squash(writeExit.cause)),
          } satisfies PiMcpBridge;
        }

        return {
          _tag: "Ready",
          configPath,
          bridgeDir,
          providerSessionId: mcpSession.providerSessionId,
          environment: {
            [PI_MCP_BRIDGE_TOKEN_ENV]: stripBearerPrefix(mcpSession.authorizationHeader),
          },
        } satisfies PiMcpBridge;
      });

    const emitMcpBridgeWarning = Effect.fn("emitMcpBridgeWarning")(function* (
      threadId: ThreadId,
      warning: PiMcpBridgeWarning,
    ) {
      if (warning._tag === "ConfigFailed") {
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "runtime.warning",
          payload: {
            message:
              "Pi MCP bridge could not be configured; preview browser tools unavailable for this session",
            detail: {
              providerSessionId: warning.bridge.providerSessionId,
              reason: warning.bridge.detail,
            },
          },
        });
        return;
      }

      yield* emit({
        ...(yield* buildEventBase({ threadId })),
        type: "runtime.warning",
        payload: {
          message:
            "Pi MCP bridge unavailable. Enable the bundled Pi integrations for preview browser support.",
          detail: { reason: warning.detail },
        },
      });
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: PiSessionContext,
      message: string,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) return;
      const turnId = context.activeTurnId;
      yield* settlePendingRequestsAsCancelled(context).pipe(Effect.ignore);
      sessions.delete(context.session.threadId);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "runtime.error",
        payload: { message, class: "transport_error" },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "session.exited",
        payload: { reason: message, recoverable: false, exitKind: "error" },
      }).pipe(Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const emitTokenUsage = Effect.fn("emitTokenUsage")(function* (context: PiSessionContext) {
      const statsExit = yield* Effect.exit(
        context.rpc.request({ type: "get_session_stats" }, { timeoutMs: 5_000 }),
      );
      if (statsExit._tag === "Failure") {
        return;
      }
      const statsDataExit = decodePiSessionStatsExit(statsExit.value.data);
      if (Exit.isFailure(statsDataExit)) {
        yield* Effect.logWarning("Dropped malformed Pi session stats response.");
        return;
      }
      const usage = tokenUsageFromStats(statsDataExit.value);
      if (!usage) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId })),
        type: "thread.token-usage.updated",
        payload: { usage },
      });
    });

    const handleExtensionUiRequest = Effect.fn("handleExtensionUiRequest")(function* (
      context: PiSessionContext,
      event: PiExtensionUiRequestEvent,
    ) {
      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      const uiRequestId = event.id;
      const method = event.method ?? "unknown";
      if (!uiRequestId) {
        return;
      }

      if (method === "notify") {
        const message = event.message ?? "";
        if (message.startsWith(PI_SUBAGENTS_FLEET_PREFIX)) {
          const decoded = decodePiSubagentFleetExit(
            message.slice(PI_SUBAGENTS_FLEET_PREFIX.length),
          );
          if (Exit.isFailure(decoded)) {
            yield* Effect.logWarning("Dropped malformed Pi subagent fleet update.");
            return;
          }
          for (const agent of decoded.value) {
            const previous = context.subagentStatuses.get(agent.id);
            if (previous === agent.status) continue;
            context.subagentStatuses.set(agent.id, agent.status);
            const linkage = {
              taskId: RuntimeTaskId.make(agent.id),
              taskType: "subagent",
              agentKind: "agent" as const,
              title: agent.title,
              ...(agent.parentId ? { parentAgentId: agent.parentId } : {}),
              ...(agent.model ? { model: agent.model } : {}),
              ...(agent.effort ? { effort: agent.effort } : {}),
              agentPath: agent.id,
              timelineBypass: true,
            };
            const terminal =
              agent.status === "completed" ||
              agent.status === "failed" ||
              agent.status === "interrupted";
            const base = yield* buildEventBase({ threadId, turnId, raw: event });
            if (previous === undefined) {
              yield* emit({
                ...base,
                type: "task.started",
                payload: { ...linkage, description: agent.title },
              });
            } else if (terminal) {
              yield* emit({
                ...base,
                type: "task.completed",
                payload: {
                  ...linkage,
                  status:
                    agent.status === "completed"
                      ? "completed"
                      : agent.status === "failed"
                        ? "failed"
                        : "stopped",
                  ...(agent.summary ? { summary: agent.summary } : {}),
                },
              });
            } else {
              yield* emit({
                ...base,
                type: "task.updated",
                payload: {
                  ...linkage,
                  status:
                    agent.status === "queued"
                      ? "pending"
                      : agent.status === "paused"
                        ? "idle"
                        : "running",
                  ...(agent.error ? { error: agent.error } : {}),
                },
              });
            }
          }
          return;
        }
        if (event.notifyType === "error") {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: { message: event.message ?? "Pi extension error." },
          });
        }
        return;
      }
      if (
        method === "setStatus" ||
        method === "setWidget" ||
        method === "setTitle" ||
        method === "set_editor_text"
      ) {
        return;
      }
      if (
        method !== "select" &&
        method !== "confirm" &&
        method !== "input" &&
        method !== "editor"
      ) {
        yield* context.rpc.notify({
          type: "extension_ui_response",
          id: uiRequestId,
          cancelled: true,
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw: event })),
          type: "runtime.warning",
          payload: { message: `Cancelled unsupported Pi extension ${method} dialog.` },
        });
        return;
      }

      const title = event.title ?? "";
      const approval = method === "select" ? parsePiApprovalTitle(title) : null;
      if (approval) {
        context.pendingApprovals.set(uiRequestId, approval);
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, requestId: uiRequestId, raw: event })),
          type: "request.opened",
          payload: {
            requestType: approvalRequestType(approval.tool),
            detail: approval.detail.length > 0 ? approval.detail : approval.tool,
          },
        });
        return;
      }
      if (method === "select" && title.startsWith(PI_APPROVAL_TITLE_PREFIX)) {
        yield* context.rpc.notify({
          type: "extension_ui_response",
          id: uiRequestId,
          cancelled: true,
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw: event })),
          type: "runtime.warning",
          payload: { message: "Cancelled malformed Pi approval dialog." },
        });
        return;
      }
      const structuredQuestion = method === "select" ? parsePiUserInputTitle(title) : null;
      if (structuredQuestion) {
        const dialog: PiPendingDialog = {
          method,
          title: structuredQuestion.question,
          options: structuredQuestion.options.map((option) => option.label),
          question: {
            id: structuredQuestion.id,
            header: structuredQuestion.header,
            question: structuredQuestion.question,
            options: structuredQuestion.options,
            multiSelect: false,
          },
        };
        context.pendingDialogs.set(uiRequestId, dialog);
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, requestId: uiRequestId, raw: event })),
          type: "user-input.requested",
          payload: { questions: [dialogQuestion(uiRequestId, dialog)] },
        });
        return;
      }
      if (method === "select" && title.startsWith(PI_USER_INPUT_TITLE_PREFIX)) {
        yield* context.rpc.notify({
          type: "extension_ui_response",
          id: uiRequestId,
          cancelled: true,
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw: event })),
          type: "runtime.warning",
          payload: { message: "Cancelled malformed Pi user-input dialog." },
        });
        return;
      }

      if (method === "input" || method === "editor") {
        yield* context.rpc.notify({
          type: "extension_ui_response",
          id: uiRequestId,
          cancelled: true,
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId, raw: event })),
          type: "runtime.warning",
          payload: {
            message: `Cancelled unsupported Pi extension ${method} dialog: ${title}`,
          },
        });
        return;
      }

      const rawOptions = Array.isArray(event.options)
        ? event.options.filter((option): option is string => typeof option === "string")
        : [];
      const dialog: PiPendingDialog = {
        method,
        title:
          title.length > 0
            ? `${title}${event.message ? `\n${event.message}` : ""}`
            : "Pi extension request",
        options: rawOptions,
      };
      context.pendingDialogs.set(uiRequestId, dialog);
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId, requestId: uiRequestId, raw: event })),
        type: "user-input.requested",
        payload: { questions: [dialogQuestion(uiRequestId, dialog)] },
      });
    });

    const handlePiEvent = Effect.fn("handlePiEvent")(function* (
      context: PiSessionContext,
      event: PiRpcEvent,
    ) {
      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(threadId, event);

      switch (event.type) {
        case "message_start": {
          context.messageSequence += 1;
          break;
        }

        case "message_update": {
          const delta = event.assistantMessageEvent;
          const deltaType = delta.type;
          if (deltaType !== "text_delta" && deltaType !== "thinking_delta") break;
          const text = delta.delta;
          if (!text) break;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: namespacePiItemId(context, `pi-msg-${context.messageSequence}`),
            })),
            type: "content.delta",
            payload: {
              streamKind: deltaType === "thinking_delta" ? "reasoning_text" : "assistant_text",
              delta: text,
              ...(typeof delta.contentIndex === "number"
                ? { contentIndex: delta.contentIndex }
                : {}),
            },
          });
          break;
        }

        case "message_end": {
          const message = event.message;
          if (message.role !== "assistant") break;
          context.lastStopReason = message.stopReason;
          context.lastErrorMessage = message.errorMessage;
          const text = textFromContentBlocks(message.content);
          if (text.length > 0) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId,
                turnId,
                itemId: namespacePiItemId(context, `pi-msg-${context.messageSequence}`),
                raw: event,
              })),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                detail: text,
              },
            });
          }
          break;
        }

        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end": {
          const toolName = event.toolName ?? "tool";
          const toolCallId = fallbackToolCallItemId(context, event, toolName);
          const isEnd = event.type === "tool_execution_end";
          const isError = isEnd && event.isError === true;
          const detail = isEnd
            ? toolResultText(event.result)
            : event.type === "tool_execution_update"
              ? toolResultText(event.partialResult)
              : toolDetailFromArgs(toolName, event.args);
          const payload = {
            itemType: toToolLifecycleItemType(toolName),
            status: isError
              ? ("failed" as const)
              : isEnd
                ? ("completed" as const)
                : ("inProgress" as const),
            title: toolName,
            ...(detail ? { detail } : {}),
            data: {
              tool: toolName,
              ...(event.args !== undefined ? { args: event.args } : {}),
              ...(isEnd && event.result !== undefined ? { result: event.result } : {}),
            },
          };
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: toolCallId, raw: event })),
            type:
              event.type === "tool_execution_start"
                ? "item.started"
                : isEnd
                  ? "item.completed"
                  : "item.updated",
            payload,
          });
          const notebookCode =
            event.type === "tool_execution_start" && toolName === "exec"
              ? notebookCodeFromArgs(event.args)
              : undefined;
          if (notebookCode) {
            yield* summarizeNotebookTool(context, turnId, toolCallId, notebookCode).pipe(
              Effect.timeout("30 seconds"),
              Effect.ignore({ log: true }),
              Effect.forkIn(context.sessionScope),
            );
          }
          break;
        }

        case "agent_end": {
          const endedTurnId = context.activeTurnId;
          if (!endedTurnId) break;
          yield* settlePendingRequestsAsCancelled(context);
          // interruptTurn may clear the turn while we settle; it already
          // emitted turn.aborted, so don't emit a second terminal event.
          if (context.activeTurnId !== endedTurnId) break;
          context.activeTurnId = undefined;
          const failed = context.lastStopReason === "error";
          const errorMessage = context.lastErrorMessage;
          context.lastStopReason = undefined;
          context.lastErrorMessage = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: endedTurnId })),
            type: "turn.completed",
            payload: failed
              ? {
                  state: "failed",
                  errorMessage: nonEmptyDetail(
                    errorMessage,
                    "Pi reported an error while completing the turn.",
                  ),
                }
              : { state: "completed" },
          });
          yield* emitTokenUsage(context);
          break;
        }

        case "extension_ui_request": {
          yield* handleExtensionUiRequest(context, event);
          break;
        }

        case "compaction_start": {
          context.compactionSequence += 1;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: namespacePiItemId(context, `pi-compaction-${context.compactionSequence}`),
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
          });
          break;
        }

        case "compaction_end": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: namespacePiItemId(context, `pi-compaction-${context.compactionSequence}`),
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: event.aborted === true ? "declined" : "completed",
              title: "Compacting context",
            },
          });
          if (event.aborted !== true) {
            yield* emit({
              ...(yield* buildEventBase({ threadId, turnId, raw: event })),
              type: "thread.state.changed",
              payload: { state: "compacted" },
            });
          }
          break;
        }

        case "auto_retry_start": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: {
              message: `Pi is retrying after a transient provider error (attempt ${String(event.attempt ?? "?")}).`,
              detail: event,
            },
          });
          break;
        }

        case "extension_error": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: {
              message: `Pi extension error: ${event.error ?? "unknown"}`,
              detail: event,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const readAttachmentImages = (input: {
      readonly threadId: ThreadId;
      readonly attachments: Parameters<PiAdapterShape["sendTurn"]>[0]["attachments"];
    }) =>
      Effect.forEach(input.attachments ?? [], (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return null;
          }
          const bytes = yield* fs.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "readAttachment",
                  detail: `Failed to read attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          );
          return {
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      ).pipe(Effect.map((images) => images.filter((image) => image !== null)));

    const listSkills: NonNullable<PiAdapterShape["listSkills"]> = Effect.fn("listPiSkills")(
      function* (cwd) {
        const cached = skillInventoryCache.get(cwd);
        const checkedAt = yield* Clock.currentTimeMillis;
        if (cached && checkedAt - cached.checkedAt < PI_SKILL_INVENTORY_CACHE_MS) {
          return cached.skills;
        }
        const skills = yield* discoverPiSkills({
          command: options?.command ?? { binaryPath: piSettings.binaryPath },
          cwd,
          ...(options?.environment ? { environment: options.environment } : {}),
          extensionPaths: inventoryExtensionPaths,
        }).pipe(
          Effect.provideService(PiRuntime, piRuntime),
          Effect.catch((cause) => {
            const detail = piRuntimeErrorDetail(cause);
            return Effect.logWarning("Unable to refresh Pi skills; using the last inventory.", {
              cwd,
              detail,
            }).pipe(Effect.as(cached?.skills ?? []));
          }),
        );
        skillInventoryCache.set(cwd, { checkedAt: yield* Clock.currentTimeMillis, skills });
        return skills;
      },
    );

    const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const directory = input.cwd ?? serverConfig.cwd;
        const skills = skillInventoryCache.get(directory)?.skills ?? [];
        const resumeSessionId = parsePiResumeCursor(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopPiContext(existing);
          sessions.delete(input.threadId);
        }

        const thinkingLevel = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        const userExtensionPaths = (yield* fs.readDirectory(userExtensionsPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "readDirectory",
                detail: "Failed to read the Pi user extensions directory.",
                cause,
              }),
          ),
        ))
          .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".js"))
          .map((entry) => path.join(userExtensionsPath, entry));
        const extensionPaths = [
          ...bundledExtensionPaths,
          ...(options?.extensionPaths ?? []),
          ...userExtensionPaths,
        ];
        const mcpBridge = yield* makeMcpBridge(input.threadId);
        const initialBridgeWarning =
          mcpBridge._tag === "Failed"
            ? ({ _tag: "ConfigFailed", bridge: mcpBridge } satisfies PiMcpBridgeWarning)
            : undefined;
        const makeBridgeCleanup = (bridge: Extract<PiMcpBridge, { readonly _tag: "Ready" }>) =>
          fs
            .remove(bridge.bridgeDir, { recursive: true, force: true })
            .pipe(Effect.catchCause(() => Effect.void));
        const spawnInput = (bridgeEnabled: boolean) => {
          const bridge = bridgeEnabled && mcpBridge._tag === "Ready" ? mcpBridge : undefined;
          const spawnEnvironment = bridge
            ? { ...(options?.environment ?? process.env), ...bridge.environment }
            : options?.environment;
          return {
            binaryPath: options?.command?.binaryPath ?? piSettings.binaryPath,
            ...(options?.command?.argsPrefix ? { argsPrefix: options.command.argsPrefix } : {}),
            cwd: directory,
            ...(spawnEnvironment ? { environment: spawnEnvironment } : {}),
            runtimeMode: input.runtimeMode,
            noExtensions: true,
            skillPaths: skills.map((skill) => skill.path),
            ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
            sessionName: `T3 Code ${input.threadId}`,
            ...(input.modelSelection ? { modelSlug: input.modelSelection.model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            extensionPaths,
            ...(bridge
              ? {
                  mcpConfigPath: bridge.configPath,
                  appendSystemPrompt: PI_T3_BROWSER_SYSTEM_PROMPT,
                }
              : {}),
          };
        };
        const startAttempt = (sessionScope: Scope.Closeable, bridgeEnabled: boolean) =>
          Effect.gen(function* () {
            const startupStartedAt = yield* Clock.currentTimeMillis;
            if (bridgeEnabled && mcpBridge._tag === "Ready") {
              yield* Scope.addFinalizer(sessionScope, makeBridgeCleanup(mcpBridge));
            }
            let rpc: PiRpcHandle | undefined;
            const startedExit = yield* Effect.exit(
              Effect.gen(function* () {
                rpc = yield* piRuntime.spawnSession(spawnInput(bridgeEnabled));
                const state = yield* rpc.request({ type: "get_state" }, { timeoutMs: 20_000 });
                const stateDataExit = decodePiStateResponseDataExit(state.data);
                if (Exit.isFailure(stateDataExit)) {
                  return yield* new PiRuntimeError({
                    operation: "get_state",
                    detail: "Pi returned malformed state data.",
                  });
                }
                yield* Effect.yieldNow;
                const startupStderr = yield* rpc.stderr;
                const startupFinishedAt = yield* Clock.currentTimeMillis;
                yield* Effect.annotateCurrentSpan(
                  piStartupTimingAttributes(startupStderr, startupFinishedAt - startupStartedAt),
                );
                return {
                  sessionScope,
                  rpc,
                  piSessionId: stateDataExit.value.sessionId,
                };
              }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
            );
            if (Exit.isFailure(startedExit)) {
              const stderr = rpc ? yield* rpc.stderr : "";
              return {
                _tag: "Failure" as const,
                cause: startedExit.cause,
                detail: appendStderrDetail(
                  piRuntimeErrorDetail(Cause.squash(startedExit.cause)),
                  stderr,
                ),
              };
            }
            return { _tag: "Success" as const, value: startedExit.value };
          });

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const firstAttempt = yield* startAttempt(sessionScope, mcpBridge._tag === "Ready");
          if (firstAttempt._tag === "Success") {
            return {
              ...firstAttempt.value,
              ...(initialBridgeWarning ? { bridgeWarning: initialBridgeWarning } : {}),
            };
          }

          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          if (mcpBridge._tag === "Ready") {
            const retryScope = yield* Scope.make();
            const retryAttempt = yield* startAttempt(retryScope, false);
            if (retryAttempt._tag === "Success") {
              return {
                ...retryAttempt.value,
                bridgeWarning: {
                  _tag: "SpawnRetried",
                  detail: firstAttempt.detail,
                } satisfies PiMcpBridgeWarning,
              };
            }
            yield* Scope.close(retryScope, Exit.void).pipe(Effect.ignore);
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: retryAttempt.detail,
              cause: retryAttempt.cause,
            });
          }

          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: firstAttempt.detail,
            cause: firstAttempt.cause,
          });
        });

        const createdAt = yield* nowIso;
        const stopped = yield* Ref.make(false);
        // No yields between this check and sessions.set below, so a concurrent
        // startSession for the same thread cannot register a second context.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          ...(started.piSessionId
            ? {
                resumeCursor: {
                  schemaVersion: PI_RESUME_CURSOR_VERSION,
                  sessionId: started.piSessionId,
                },
              }
            : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const context: PiSessionContext = {
          session,
          itemIdNamespace: `${input.threadId}:${started.piSessionId ?? createdAt}`,
          rpc: started.rpc,
          pendingApprovals: new Map(),
          pendingDialogs: new Map(),
          subagentStatuses: new Map(),
          activeTurnId: undefined,
          currentModelSlug: input.modelSelection?.model,
          currentThinking: thinkingLevel,
          lastStopReason: undefined,
          lastErrorMessage: undefined,
          messageSequence: 0,
          toolSequence: 0,
          compactionSequence: 0,
          fallbackToolCallIds: new Map(),
          stopped,
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);

        yield* Stream.fromQueue(started.rpc.events).pipe(
          Stream.runForEach((event) => handlePiEvent(context, event)),
          Effect.ignore,
          Effect.forkIn(started.sessionScope),
        );
        yield* started.rpc.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              const stderr = yield* started.rpc.stderr;
              yield* emitUnexpectedExit(
                context,
                appendStderrDetail(`Pi process exited unexpectedly (${code}).`, stderr),
              );
            }),
          ),
          Effect.forkIn(started.sessionScope),
        );

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { message: "Pi session started" },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: started.piSessionId ? { providerThreadId: started.piSessionId } : {},
        });
        if (started.bridgeWarning) {
          yield* emitMcpBridgeWarning(input.threadId, started.bridgeWarning);
        }

        return session;
      },
    );

    const expandSkillMentions = Effect.fn("expandPiSkillMentions")(function* (
      text: string,
      cwd: string,
    ) {
      if (!text.includes("$")) return text;
      const skills = yield* listSkills(cwd);
      const referenced = findReferencedPiSkills(text, skills);
      if (referenced.length === 0) return text;
      const loaded = yield* Effect.forEach(referenced, (skill) =>
        fs.readFileString(skill.path).pipe(
          Effect.exit,
          Effect.map((result) =>
            Exit.isSuccess(result) ? { skill, content: result.value } : null,
          ),
        ),
      );
      const sections = loaded.flatMap((entry) =>
        entry
          ? [
              `<skill name=${JSON.stringify(entry.skill.name)} path=${JSON.stringify(entry.skill.path)}>\n${entry.content}\n</skill>`,
            ]
          : [],
      );
      return sections.length > 0 ? `${sections.join("\n\n")}\n\n${text}` : text;
    });

    const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Pi model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const text = input.input?.trim();
      const images = yield* readAttachmentImages({
        threadId: input.threadId,
        attachments: input.attachments,
      });
      if ((!text || text.length === 0) && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text input or at least one image attachment.",
        });
      }
      const promptText = text
        ? yield* expandSkillMentions(text, context.session.cwd ?? serverConfig.cwd)
        : "";

      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`pi-turn-${yield* randomUUIDv4}`);
      if (modelSelection?.model && modelSelection.model !== context.currentModelSlug) {
        const parsedModel = parsePiModelSlug(modelSelection.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi model selection must use the 'provider/model' format.",
          });
        }
        yield* context.rpc
          .request({
            type: "set_model",
            provider: parsedModel.provider,
            modelId: parsedModel.modelId,
          })
          .pipe(Effect.mapError(toRequestError));
        // Commit immediately: Pi has switched even if a later RPC fails.
        context.currentModelSlug = modelSelection.model;
      }
      const thinkingLevel = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (thinkingLevel && thinkingLevel !== context.currentThinking) {
        yield* context.rpc
          .request({ type: "set_thinking_level", level: thinkingLevel })
          .pipe(Effect.mapError(toRequestError));
        context.currentThinking = thinkingLevel;
      }

      context.activeTurnId = turnId;
      context.lastStopReason = undefined;
      context.lastErrorMessage = undefined;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );
      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(thinkingLevel ? { effort: thinkingLevel } : {}),
          },
        });
      }

      yield* context.rpc
        .request({
          type: "prompt",
          message: promptText,
          ...(images.length > 0 ? { images } : {}),
          ...(steeringTurnId !== undefined ? { streamingBehavior: "steer" } : {}),
        })
        .pipe(
          Effect.mapError(toRequestError),
          Effect.tapError((requestError) =>
            steeringTurnId !== undefined
              ? Effect.void
              : Effect.gen(function* () {
                  const reason = nonEmptyDetail(requestError.detail, "Pi prompt request failed.");
                  context.activeTurnId = undefined;
                  yield* updateProviderSession(
                    context,
                    { status: "ready", lastError: reason },
                    { clearActiveTurnId: true },
                  );
                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                    type: "turn.aborted",
                    payload: { reason },
                  });
                }),
          ),
        );

      return { threadId: input.threadId, turnId };
    });

    const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        const abortedTurnId = turnId ?? context.activeTurnId;
        yield* settlePendingRequestsAsCancelled(context);
        yield* context.rpc
          .request({ type: "abort" }, { timeoutMs: 2_000 })
          .pipe(Effect.ignore({ log: true }));
        context.activeTurnId = undefined;
        context.lastStopReason = undefined;
        context.lastErrorMessage = undefined;
        yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        if (abortedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: abortedTurnId })),
            type: "turn.aborted",
            payload: { reason: "Interrupted by user." },
          });
        }
      },
    );

    const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
      function* (threadId, requestId, decision) {
        const context = ensureSessionContext(sessions, threadId);
        const approval = context.pendingApprovals.get(requestId);
        if (!approval) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        context.pendingApprovals.delete(requestId);
        const selection = toPiApprovalSelection(decision);
        yield* context.rpc.notify(
          selection === null
            ? { type: "extension_ui_response", id: requestId, cancelled: true }
            : { type: "extension_ui_response", id: requestId, value: selection },
        );
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: context.activeTurnId, requestId })),
          type: "request.resolved",
          payload: {
            requestType: approvalRequestType(approval.tool),
            decision,
          },
        });
      },
    );

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const dialog = context.pendingDialogs.get(requestId);
      if (!dialog) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      context.pendingDialogs.delete(requestId);
      const rawAnswer = answers[dialog.question?.id ?? requestId];
      const answer = Array.isArray(rawAnswer)
        ? rawAnswer.find((value): value is string => typeof value === "string")
        : typeof rawAnswer === "string"
          ? rawAnswer
          : undefined;
      yield* context.rpc.notify(
        answer === undefined
          ? { type: "extension_ui_response", id: requestId, cancelled: true }
          : dialog.method === "confirm"
            ? { type: "extension_ui_response", id: requestId, confirmed: answer === "Yes" }
            : { type: "extension_ui_response", id: requestId, value: answer },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId: context.activeTurnId, requestId })),
        type: "user-input.resolved",
        payload: { answers: { [requestId]: answer ?? "" } },
      });
    });

    const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        yield* settlePendingRequestsAsCancelled(context);
        const stopped = yield* stopPiContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
        });
      },
    );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
      const context = ensureSessionContext(sessions, threadId);
      const response = yield* context.rpc
        .request({ type: "get_messages" })
        .pipe(Effect.mapError(toRequestError));
      const dataExit = decodePiMessagesResponseDataExit(response.data);
      if (Exit.isFailure(dataExit)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_messages",
          detail: "Pi returned malformed message history.",
        });
      }
      const messages = dataExit.value.messages;

      const turns: Array<PiTurnSnapshot> = [];
      for (const message of messages) {
        if (message.role === "user") {
          turns.push({ id: TurnId.make(`pi-snapshot-turn-${turns.length}`), items: [message] });
          continue;
        }
        if (turns.length === 0) {
          turns.push({ id: TurnId.make(`pi-snapshot-turn-${turns.length}`), items: [] });
        }
        turns[turns.length - 1]?.items.push(message);
      }
      return { threadId, turns };
    });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `Pi does not support rolling back thread ${threadId} turns in place. Fork the session from Pi's own UI instead.`,
        }),
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.gen(function* () {
              yield* Effect.ignoreCause(settlePendingRequestsAsCancelled(context));
              yield* Effect.ignoreCause(stopPiContext(context));
            }),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      listSkills,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies PiAdapterShape;
  });
}
