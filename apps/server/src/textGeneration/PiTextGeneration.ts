import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { TextGenerationError, type ModelSelection, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import {
  parsePiModelSlug,
  type PiCommand,
  type PiRpcHandle,
  PiRuntime,
  PiRuntimeError,
  piRuntimeErrorDetail,
} from "../provider/piRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

type PiTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const PI_UTILITY_IDLE_TIMEOUT = "5 minutes";
const PI_UTILITY_GENERATION_TIMEOUT = "2 minutes";

interface PiUtilityProcess {
  readonly cwd: string;
  readonly rpc: PiRpcHandle;
  readonly scope: Scope.Closeable;
  used: boolean;
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment?: NodeJS.ProcessEnv,
  bundledCommand?: PiCommand,
) {
  const piRuntime = yield* PiRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const utilityMutex = yield* Semaphore.make(1);
  const ownerScope = yield* Scope.Scope;
  let utilityProcess: PiUtilityProcess | undefined;
  let idleFiber: Fiber.Fiber<void, never> | undefined;

  const cancelIdleClose = Effect.fn("PiTextGeneration.cancelIdleClose")(function* () {
    const fiber = idleFiber;
    idleFiber = undefined;
    if (fiber) yield* Fiber.interrupt(fiber);
  });

  const closeUtilityProcess = Effect.fn("PiTextGeneration.closeUtilityProcess")(function* () {
    const current = utilityProcess;
    utilityProcess = undefined;
    if (current) yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() => cancelIdleClose().pipe(Effect.andThen(closeUtilityProcess())));

  const scheduleIdleClose = () =>
    Effect.gen(function* () {
      yield* cancelIdleClose();
      idleFiber = yield* Effect.sleep(PI_UTILITY_IDLE_TIMEOUT).pipe(
        Effect.flatMap(() =>
          utilityMutex.withPermits(1)(
            Effect.sync(() => {
              idleFiber = undefined;
            }).pipe(Effect.andThen(closeUtilityProcess())),
          ),
        ),
        Effect.forkIn(ownerScope),
      );
    });

  const startUtilityProcess = Effect.fn("PiTextGeneration.startUtilityProcess")(function* (
    cwd: string,
    modelSlug: string,
  ) {
    const scope = yield* Scope.make();
    const rpcExit = yield* piRuntime
      .spawnSession({
        ...(bundledCommand ?? { binaryPath: piSettings.binaryPath }),
        cwd,
        environment: resolvedEnvironment,
        runtimeMode: "auto",
        modelSlug,
        thinkingLevel: "off",
        noSession: true,
        noTools: true,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
      })
      .pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
    if (Exit.isFailure(rpcExit)) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      return yield* Effect.failCause(rpcExit.cause);
    }
    const rpc = rpcExit.value;
    return yield* rpc.request({ type: "get_state" }, { timeoutMs: 20_000 }).pipe(
      Effect.as({ cwd, rpc, scope, used: false } satisfies PiUtilityProcess),
      Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    );
  });

  const getUtilityProcess = Effect.fn("PiTextGeneration.getUtilityProcess")(function* (
    cwd: string,
    modelSlug: string,
  ) {
    if (utilityProcess?.cwd === cwd) return utilityProcess;
    yield* closeUtilityProcess();
    const started = yield* startUtilityProcess(cwd, modelSlug);
    utilityProcess = started;
    return started;
  });

  const waitForUtilityResult = Effect.fn("PiTextGeneration.waitForUtilityResult")(function* (
    rpc: PiRpcHandle,
  ) {
    while (true) {
      const event = yield* Queue.take(rpc.events);
      if (event.type !== "agent_end") continue;
      const response = yield* rpc.request({ type: "get_messages" });
      if (!response.data || typeof response.data !== "object" || !("messages" in response.data)) {
        return yield* new PiRuntimeError({
          operation: "get_messages",
          detail: "Pi utility session returned malformed messages.",
        });
      }
      const messages = (response.data as { readonly messages?: ReadonlyArray<unknown> }).messages;
      const assistant = messages
        ?.filter(
          (
            message,
          ): message is {
            readonly role: string;
            readonly content?: unknown;
            readonly stopReason?: unknown;
            readonly errorMessage?: unknown;
          } => typeof message === "object" && message !== null && "role" in message,
        )
        .findLast((message) => message.role === "assistant");
      if (assistant?.stopReason === "error" && typeof assistant.errorMessage === "string") {
        return yield* new PiRuntimeError({
          operation: "prompt",
          detail: assistant.errorMessage,
        });
      }
      const content = assistant?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter(
            (block): block is { readonly type: "text"; readonly text: string } =>
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              block.type === "text" &&
              "text" in block &&
              typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("");
      }
      return "";
    }
  });

  const runUtilityPrompt = Effect.fn("PiTextGeneration.runUtilityPrompt")(function* (input: {
    readonly cwd: string;
    readonly prompt: string;
    readonly modelSlug: string;
  }) {
    return yield* utilityMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        const utility = yield* getUtilityProcess(input.cwd, input.modelSlug);
        if (utility.used) yield* utility.rpc.request({ type: "new_session" });
        const parsedModel = parsePiModelSlug(input.modelSlug)!;
        yield* utility.rpc.request({
          type: "set_model",
          provider: parsedModel.provider,
          modelId: parsedModel.modelId,
        });
        yield* utility.rpc.request({ type: "set_thinking_level", level: "off" });
        utility.used = true;
        yield* utility.rpc.request({ type: "prompt", message: input.prompt });
        const result = yield* waitForUtilityResult(utility.rpc).pipe(
          Effect.timeout(PI_UTILITY_GENERATION_TIMEOUT),
        );
        yield* scheduleIdleClose();
        return result;
      }).pipe(
        Effect.tapError(() => closeUtilityProcess()),
        Effect.withSpan("PiTextGeneration.utilityPrompt"),
      ),
    );
  });

  const runPiJson = Effect.fn("runPiJson")(function* <S extends Schema.Top>(input: {
    readonly operation: PiTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }) {
    const parsedModel = parsePiModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Pi model selection must use the 'provider/model' format.",
      });
    }

    const rawText = yield* runUtilityPrompt({
      cwd: input.cwd,
      prompt: input.prompt,
      modelSlug: `${parsedModel.provider}/${parsedModel.modelId}`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: piRuntimeErrorDetail(cause),
            cause,
          }),
      ),
    );
    const trimmedText = rawText.trim();
    if (trimmedText.length === 0) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "Pi returned empty output.",
      });
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(trimmedText)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
