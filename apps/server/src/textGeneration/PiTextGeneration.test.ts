import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import {
  PiRuntime,
  PiRuntimeError,
  type PiCommandResult,
  type PiRpcEvent,
  type PiRuntimeShape,
  type SpawnPiRpcInput,
} from "../provider/piRuntime.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";
import type * as TextGeneration from "./TextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const isTextGenerationError = Schema.is(TextGenerationError);

const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "anthropic/claude-haiku-4-5",
};

const runtimeMock = {
  state: {
    calls: [] as Array<Record<string, unknown>>,
    spawnInputs: [] as Array<SpawnPiRpcInput>,
    results: [] as Array<PiCommandResult>,
    error: null as PiRuntimeError | null,
    assistantError: null as string | null,
  },
  reset() {
    this.state.calls.length = 0;
    this.state.spawnInputs.length = 0;
    this.state.results.length = 0;
    this.state.error = null;
    this.state.assistantError = null;
  },
};

const PiRuntimeTestDouble: PiRuntimeShape = {
  spawnSession: (input) =>
    Effect.gen(function* () {
      runtimeMock.state.spawnInputs.push(input);
      const events = yield* Queue.unbounded<PiRpcEvent>();
      let currentOutput = "";
      return {
        request: (command: Record<string, unknown>) =>
          Effect.gen(function* () {
            runtimeMock.state.calls.push(command);
            if (runtimeMock.state.error) return yield* runtimeMock.state.error;
            if (command.type === "prompt") {
              const result = runtimeMock.state.results.shift() ?? {
                stdout: "{}",
                stderr: "",
                code: 0,
              };
              if (result.code !== 0) {
                return yield* new PiRuntimeError({
                  operation: "prompt",
                  detail: result.stderr.trim() || result.stdout.trim(),
                });
              }
              currentOutput = result.stdout;
              yield* Queue.offer(events, { type: "agent_end" });
            }
            if (command.type === "get_messages") {
              return {
                type: "response" as const,
                command: "get_messages",
                success: true as const,
                data: {
                  messages: [
                    {
                      role: "assistant",
                      content: currentOutput,
                      ...(runtimeMock.state.assistantError
                        ? {
                            stopReason: "error",
                            errorMessage: runtimeMock.state.assistantError,
                          }
                        : {}),
                    },
                  ],
                },
              };
            }
            return {
              type: "response" as const,
              command: String(command.type),
              success: true as const,
              data: command.type === "get_state" ? { sessionId: "utility-session" } : undefined,
            };
          }),
        notify: () => Effect.void,
        events,
        exitCode: Effect.never,
        stderr: Effect.succeed(""),
      };
    }),
  runCommand: () =>
    Effect.fail(
      new PiRuntimeError({
        operation: "runCommand",
        detail: "Reusable text generation must not launch one-shot Pi commands.",
      }),
    ),
};

const PiTextGenerationTestLayer = Layer.succeed(PiRuntime, PiRuntimeTestDouble);

function queueJson(value: unknown) {
  runtimeMock.state.results.push({
    stdout: `Sure.\n${JSON.stringify(value)}\nDone.`,
    stderr: "",
    code: 0,
  });
}

function withPiTextGeneration<A, E, R>(
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const textGeneration = yield* makePiTextGeneration(
      decodePiSettings({ binaryPath: "fake-pi" }),
      { T3_TEST_ENV: "1" },
    );
    return yield* effectFn(textGeneration);
  });
}

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(PiTextGenerationTestLayer)("PiTextGeneration", (it) => {
  it.effect("generates commit messages through the Pi utility session", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({
          subject: "Add Pi text generation coverage",
          body: "Exercise every Pi text generation method.",
          branch: "pi-text-generation-coverage",
        });

        const commit = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/pi-text-generation",
          stagedSummary: "M apps/server/src/textGeneration/PiTextGeneration.ts",
          stagedPatch: "diff --git a/PiTextGeneration.ts b/PiTextGeneration.ts",
          includeBranch: true,
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.deepEqual(commit, {
          subject: "Add Pi text generation coverage",
          body: "Exercise every Pi text generation method.",
          branch: "feature/pi-text-generation-coverage",
        });
        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 1);
        NodeAssert.deepEqual(runtimeMock.state.spawnInputs[0], {
          binaryPath: "fake-pi",
          cwd: process.cwd(),
          environment: { T3_TEST_ENV: "1" },
          runtimeMode: "auto",
          modelSlug: "anthropic/claude-haiku-4-5",
          thinkingLevel: "off",
          noSession: true,
          noTools: true,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noContextFiles: true,
        });
        const prompt = runtimeMock.state.calls.find((call) => call.type === "prompt");
        NodeAssert.match(String(prompt?.message), /Staged files:/);
      }),
    ),
  );

  it.effect("generates PR content through the Pi utility session", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ title: "Add Pi provider tests", body: "Covers provider and adapter flows." });

        const pr = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/pi-text-generation",
          commitSummary: "Add Pi tests",
          diffSummary: "Server test additions",
          diffPatch: "diff --git a/PiProvider.test.ts b/PiProvider.test.ts",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.deepEqual(pr, {
          title: "Add Pi provider tests",
          body: "Covers provider and adapter flows.",
        });
        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 1);
        const prompt = runtimeMock.state.calls.find((call) => call.type === "prompt");
        NodeAssert.match(String(prompt?.message), /source control change request content/);
      }),
    ),
  );

  it.effect("generates branch names through the Pi utility session", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ branch: "pi-provider-tests" });

        const branch = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add coverage for Pi provider",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.deepEqual(branch, { branch: "pi-provider-tests" });
        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 1);
        const prompt = runtimeMock.state.calls.find((call) => call.type === "prompt");
        NodeAssert.match(String(prompt?.message), /branch names/);
      }),
    ),
  );

  it.effect("generates thread titles through the Pi utility session", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ title: "Debug Pi provider setup" });

        const title = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Why is Pi provider setup failing?",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.deepEqual(title, { title: "Debug Pi provider setup" });
        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 1);
        const prompt = runtimeMock.state.calls.find((call) => call.type === "prompt");
        NodeAssert.match(String(prompt?.message), /recognize this T3 Code thread/);
      }),
    ),
  );

  it.effect("passes nested provider model slugs to Pi without truncating model ids", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ title: "Review nested model slug" });

        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Title this",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openrouter/qwen/qwen3-coder",
          },
        });

        const setModel = runtimeMock.state.calls.find((call) => call.type === "set_model");
        NodeAssert.equal(setModel?.provider, "openrouter");
        NodeAssert.equal(setModel?.modelId, "qwen/qwen3-coder");
      }),
    ),
  );

  it.effect("reuses the utility process with a fresh session", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ title: "First title" });
        queueJson({ title: "Second title" });

        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "First request",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Second request",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 1);
        NodeAssert.equal(
          runtimeMock.state.calls.filter((call) => call.type === "new_session").length,
          1,
        );
      }),
    ),
  );

  it.effect("restarts the utility process when the working directory changes", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ title: "First project" });
        queueJson({ title: "Second project" });

        yield* textGeneration.generateThreadTitle({
          cwd: "/tmp/pi-project-one",
          message: "First request",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });
        yield* textGeneration.generateThreadTitle({
          cwd: "/tmp/pi-project-two",
          message: "Second request",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.deepEqual(
          runtimeMock.state.spawnInputs.map((input) => input.cwd),
          ["/tmp/pi-project-one", "/tmp/pi-project-two"],
        );
      }),
    ),
  );

  it.effect("closes the utility process after five idle minutes", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        queueJson({ title: "Before idle" });
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Before idle",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        yield* TestClock.adjust("5 minutes");

        queueJson({ title: "After idle" });
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "After idle",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });
        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("discards the utility process after an RPC error", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.error = new PiRuntimeError({
          operation: "set_model",
          detail: "temporary RPC failure",
        });
        yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Fail this request",
            modelSelection: DEFAULT_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        runtimeMock.state.error = null;
        queueJson({ title: "Recovered" });
        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Retry this request",
          modelSelection: DEFAULT_MODEL_SELECTION,
        });

        NodeAssert.deepEqual(result, { title: "Recovered" });
        NodeAssert.equal(runtimeMock.state.spawnInputs.length, 2);
      }),
    ),
  );

  it.effect("surfaces assistant API errors from the utility session", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.assistantError = "Provider credits exhausted";
        runtimeMock.state.results.push({ stdout: "", stderr: "", code: 0 });

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Title this request",
            modelSelection: DEFAULT_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        NodeAssert.ok(isTextGenerationError(error));
        NodeAssert.equal(error.detail, "Provider credits exhausted");
      }),
    ),
  );

  it.effect("rejects model selections that are not provider/model slugs", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Title this",
            modelSelection: {
              instanceId: ProviderInstanceId.make("pi"),
              model: "claude-haiku-4-5",
            },
          })
          .pipe(Effect.flip);

        NodeAssert.ok(isTextGenerationError(error));
        NodeAssert.equal(error.detail, "Pi model selection must use the 'provider/model' format.");
      }),
    ),
  );

  it.effect("surfaces invalid Pi JSON output as text generation errors", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.results.push({
          stdout: "not json",
          stderr: "",
          code: 0,
        });

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Title this",
            modelSelection: DEFAULT_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        NodeAssert.ok(isTextGenerationError(error));
        NodeAssert.equal(error.detail, "Pi returned invalid structured output.");
      }),
    ),
  );

  it.effect("surfaces empty Pi stdout as text generation errors", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.results.push({
          stdout: " \n",
          stderr: "",
          code: 0,
        });

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Title this",
            modelSelection: DEFAULT_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        NodeAssert.ok(isTextGenerationError(error));
        NodeAssert.equal(error.detail, "Pi returned empty output.");
      }),
    ),
  );

  it.effect("surfaces non-zero Pi exits as text generation errors", () =>
    withPiTextGeneration((textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.results.push({
          stdout: "",
          stderr: "Pi auth failed",
          code: 2,
        });

        const error = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Make a branch",
            modelSelection: DEFAULT_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        NodeAssert.ok(isTextGenerationError(error));
        NodeAssert.equal(error.detail, "Pi auth failed");
      }),
    ),
  );
});
