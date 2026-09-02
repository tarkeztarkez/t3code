import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import {
  PiRuntime,
  PiRuntimeError,
  type PiRpcEvent,
  type PiRpcHandle,
  type PiRuntimeShape,
  type SpawnPiRpcInput,
} from "../piRuntime.ts";
import { withBundledPiEnvironment } from "../bundledPi.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  withWindowsPiPaths,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const piSettings = (overrides: Record<string, unknown> = {}) =>
  decodePiSettings({ autoInstall: false, installCodexConversion: false, ...overrides });

const runtimeMock = {
  state: {
    calls: [] as Array<{ binaryPath: string; args: ReadonlyArray<string> }>,
    spawnInputs: [] as Array<SpawnPiRpcInput>,
    requests: [] as Array<Record<string, unknown>>,
    closeCalls: 0,
    versionResult: { stdout: "pi 0.84.3\n", stderr: "", code: 0 },
    packageList: `User packages:\n  npm:@howaboua/pi-codex-conversion\n  npm:pi-mcp-adapter\n`,
    modelsData: {
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
        },
        {
          provider: "anthropic",
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          reasoning: false,
        },
        {
          provider: "openai-codex",
          id: "gpt-5-codex",
          name: "GPT-5 Codex",
          reasoning: true,
        },
      ],
    } as unknown,
    versionError: null as PiRuntimeError | null,
    npmError: null as PiRuntimeError | null,
    modelsError: null as PiRuntimeError | null,
  },
  reset() {
    this.state.calls.length = 0;
    this.state.spawnInputs.length = 0;
    this.state.requests.length = 0;
    this.state.closeCalls = 0;
    this.state.versionResult = { stdout: "pi 0.84.3\n", stderr: "", code: 0 };
    this.state.packageList = `User packages:\n  npm:@howaboua/pi-codex-conversion\n  npm:pi-mcp-adapter\n`;
    this.state.modelsData = {
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
        },
        {
          provider: "anthropic",
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          reasoning: false,
        },
        {
          provider: "openai-codex",
          id: "gpt-5-codex",
          name: "GPT-5 Codex",
          reasoning: true,
        },
      ],
    };
    this.state.versionError = null;
    this.state.npmError = null;
    this.state.modelsError = null;
  },
};

const PiRuntimeTestDouble: PiRuntimeShape = {
  spawnSession: (input) =>
    Effect.gen(function* () {
      runtimeMock.state.spawnInputs.push(input);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls += 1;
        }),
      );
      const events = yield* Queue.unbounded<PiRpcEvent>();
      const handle: PiRpcHandle = {
        request: (command) =>
          Effect.gen(function* () {
            runtimeMock.state.requests.push(command);
            if (command.type === "get_available_models") {
              if (runtimeMock.state.modelsError) return yield* runtimeMock.state.modelsError;
              return {
                type: "response",
                command: "get_available_models",
                success: true,
                data: runtimeMock.state.modelsData,
              };
            }
            return yield* new PiRuntimeError({
              operation: "request",
              detail: `Unexpected Pi RPC command: ${String(command.type)}`,
            });
          }),
        notify: () => Effect.void,
        events,
        exitCode: Effect.never,
        stderr: Effect.succeed(""),
      };
      return handle;
    }),
  runCommand: (input) =>
    Effect.gen(function* () {
      runtimeMock.state.calls.push({ binaryPath: input.binaryPath, args: input.args });
      const command = input.args[0];
      if (input.binaryPath === "npm" && command === "--version") {
        if (runtimeMock.state.npmError) return yield* runtimeMock.state.npmError;
        return { stdout: "11.0.0\n", stderr: "", code: 0 };
      }
      if (command === "--version") {
        if (runtimeMock.state.versionError) return yield* runtimeMock.state.versionError;
        return runtimeMock.state.versionResult;
      }
      if (input.binaryPath === "npm" && command === "install") {
        runtimeMock.state.versionError = null;
        return { stdout: "installed\n", stderr: "", code: 0 };
      }
      if (command === "list") {
        return { stdout: runtimeMock.state.packageList, stderr: "", code: 0 };
      }
      if (command === "install" || command === "remove") {
        return { stdout: "ok\n", stderr: "", code: 0 };
      }
      return yield* new PiRuntimeError({
        operation: "runCommand",
        detail: `Unexpected Pi command: ${input.args.join(" ")}`,
      });
    }),
};

const PiProviderTestLayer = Layer.succeed(PiRuntime, PiRuntimeTestDouble);

it("isolates bundled Pi from the user's existing Pi agent directory", () => {
  const environment = withBundledPiEnvironment(
    { PI_CODING_AGENT_DIR: "/home/alice/.pi/agent" },
    "/home/alice/.t3/userdata",
  );

  NodeAssert.equal(environment.PI_CODING_AGENT_DIR, "/home/alice/.t3/userdata/pi");
  NodeAssert.equal(environment.PI_CODEX_CACHE_KEEPALIVE, "1");
});

beforeEach(() => {
  runtimeMock.reset();
});

it.effect("adds Windows Node and npm directories to Pi's PATH", () =>
  Effect.sync(() => {
    const environment = withWindowsPiPaths({
      OS: "Windows_NT",
      APPDATA: "C:\\Users\\Kacper\\AppData\\Roaming",
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Windows\\System32",
    });

    NodeAssert.equal(
      environment.PATH,
      "C:\\Users\\Kacper\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
  }),
);

it.effect(
  "buildInitialPiProviderSnapshot returns a disabled snapshot when settings.enabled is false",
  () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(piSettings({ enabled: false }));
      NodeAssert.equal(snapshot.enabled, false);
      NodeAssert.equal(snapshot.status, "disabled");
      NodeAssert.equal(snapshot.badgeLabel, "Early Access");
      NodeAssert.match(snapshot.message ?? "", /disabled/);
    }),
);

it.effect("buildInitialPiProviderSnapshot returns a pending snapshot by default", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialPiProviderSnapshot(piSettings());
    NodeAssert.equal(snapshot.enabled, true);
    NodeAssert.equal(snapshot.status, "warning");
    NodeAssert.equal(snapshot.badgeLabel, "Early Access");
    NodeAssert.match(snapshot.message ?? "", /not been checked/);
  }),
);

it.effect("buildInitialPiProviderSnapshot includes configured custom models", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialPiProviderSnapshot(
      piSettings({ customModels: ["custom/pi-model"] }),
    );

    NodeAssert.equal(snapshot.status, "warning");
    NodeAssert.ok(snapshot.models.some((model) => model.slug === "custom/pi-model"));
  }),
);

it.layer(PiProviderTestLayer)("checkPiProviderStatus", (it) => {
  it.effect("skips runtime probes when Pi is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(piSettings({ enabled: false }));

      NodeAssert.equal(snapshot.enabled, false);
      NodeAssert.equal(snapshot.status, "disabled");
      NodeAssert.deepEqual(runtimeMock.state.calls, []);
    }),
  );

  it.effect("reports a missing binary from the runtime error detail", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionError = new PiRuntimeError({
        operation: "runCommand",
        detail: "spawn pi ENOENT",
      });

      const snapshot = yield* checkPiProviderStatus(piSettings({ binaryPath: "pi" }));

      NodeAssert.equal(snapshot.enabled, true);
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.message, "Pi CLI (`pi`) is not installed or not on PATH.");
    }),
  );

  it.effect("installs Pi and Codex Conversion when both are missing", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionError = new PiRuntimeError({
        operation: "runCommand",
        detail: "spawn pi ENOENT",
      });
      runtimeMock.state.packageList = "User packages:\n";

      const snapshot = yield* checkPiProviderStatus(decodePiSettings({ binaryPath: "pi" }));

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.deepEqual(
        runtimeMock.state.calls.map((call) => [call.binaryPath, ...call.args]),
        [
          ["pi", "--version"],
          ["npm", "install", "--global", "@earendil-works/pi-coding-agent@latest"],
          ["pi", "--version"],
        ],
      );
    }),
  );

  it.effect("installs Node with winget before Pi when npm is missing on Windows", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionError = new PiRuntimeError({
        operation: "runCommand",
        detail: "spawn pi ENOENT",
      });
      runtimeMock.state.npmError = new PiRuntimeError({
        operation: "runCommand",
        detail: "spawn npm ENOENT",
      });

      const snapshot = yield* checkPiProviderStatus(
        piSettings({ binaryPath: "pi", autoInstall: true }),
        {
          OS: "Windows_NT",
          APPDATA: "C:\\Users\\Kacper\\AppData\\Roaming",
          ProgramFiles: "C:\\Program Files",
          PATH: "C:\\Windows\\System32",
        },
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.deepEqual(
        runtimeMock.state.calls.slice(0, 5).map((call) => [call.binaryPath, ...call.args]),
        [
          ["pi", "--version"],
          ["npm", "--version"],
          [
            "winget",
            "install",
            "--id",
            "OpenJS.NodeJS.LTS",
            "--exact",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
          ],
          ["npm", "install", "--global", "@earendil-works/pi-coding-agent@latest"],
          ["pi", "--version"],
        ],
      );
    }),
  );

  it.effect("reports model discovery failures after a successful version probe", () =>
    Effect.gen(function* () {
      runtimeMock.state.modelsError = new PiRuntimeError({
        operation: "runCommand",
        detail: "model list failed",
      });

      const snapshot = yield* checkPiProviderStatus(piSettings({ binaryPath: "pi" }));

      NodeAssert.equal(snapshot.enabled, true);
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.version, "0.84.3");
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute Pi CLI health check: model list failed",
      );
      NodeAssert.deepEqual(
        runtimeMock.state.calls.map((call) => call.args),
        [["--version"]],
      );
      NodeAssert.deepEqual(
        runtimeMock.state.spawnInputs.map((input) => input.noSession),
        [true],
      );
      NodeAssert.deepEqual(
        runtimeMock.state.spawnInputs.map((input) => input.noTools),
        [true],
      );
      NodeAssert.deepEqual(
        runtimeMock.state.requests.map((command) => command.type),
        ["get_available_models"],
      );
    }),
  );

  it.effect("does not list models when Pi version output cannot be parsed", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionResult = { stdout: "pi dev build\n", stderr: "", code: 0 };

      const snapshot = yield* checkPiProviderStatus(piSettings({ binaryPath: "pi" }));

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.version, null);
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute Pi CLI health check: Unable to determine Pi version from `pi --version` output.",
      );
      NodeAssert.deepEqual(
        runtimeMock.state.calls.map((call) => call.args),
        [["--version"]],
      );
    }),
  );

  it.effect("discovers models from RPC and exposes mapped thinking capabilities", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(piSettings({ binaryPath: "pi" }));
      const slugs = snapshot.models.map((model) => model.slug);

      NodeAssert.equal(snapshot.enabled, true);
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.version, "0.84.3");
      NodeAssert.equal(snapshot.badgeLabel, "Early Access");
      NodeAssert.deepEqual(slugs, [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-sonnet-5",
        "openai-codex/gpt-5-codex",
      ]);
      NodeAssert.equal(runtimeMock.state.closeCalls, 1);

      const model = snapshot.models.find((entry) => entry.slug === "anthropic/claude-sonnet-5");
      const thinking = model?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "thinking" && descriptor.type === "select",
      );
      NodeAssert.ok(thinking && thinking.type === "select");
      NodeAssert.equal(thinking.currentValue, "medium");
      NodeAssert.deepEqual(
        thinking.options.map((option) => option.id),
        ["off", "minimal", "low", "medium", "high"],
      );

      const codexModel = snapshot.models.find((entry) => entry.slug === "openai-codex/gpt-5-codex");
      const codexThinking = codexModel?.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "thinking" && descriptor.type === "select",
      );
      NodeAssert.ok(codexThinking && codexThinking.type === "select");
      NodeAssert.ok(codexThinking.options.some((option) => option.id === "xhigh"));
    }),
  );

  it.effect("returns a warning when model discovery succeeds with no models", () =>
    Effect.gen(function* () {
      runtimeMock.state.modelsData = { models: [] };

      const snapshot = yield* checkPiProviderStatus(piSettings({ binaryPath: "pi" }));

      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.match(snapshot.message ?? "", /reported no models/);
    }),
  );

  it.effect("keeps custom Pi models in error and success snapshots", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionError = new PiRuntimeError({
        operation: "runCommand",
        detail: "spawn pi ENOENT",
      });
      const errorSnapshot = yield* checkPiProviderStatus(
        piSettings({ binaryPath: "pi", customModels: ["custom/pi-model"] }),
      );
      runtimeMock.state.versionError = null;
      runtimeMock.state.calls.length = 0;

      const successSnapshot = yield* checkPiProviderStatus(
        piSettings({ binaryPath: "pi", customModels: ["custom/pi-model"] }),
      );

      NodeAssert.ok(errorSnapshot.models.some((model) => model.slug === "custom/pi-model"));
      NodeAssert.ok(successSnapshot.models.some((model) => model.slug === "custom/pi-model"));
      NodeAssert.ok(
        successSnapshot.models.some((model) => model.slug === "anthropic/claude-sonnet-5"),
      );
    }),
  );
});
