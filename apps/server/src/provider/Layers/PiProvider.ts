import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ModelCapabilities,
  PiSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Data, Effect, Equal, Layer, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { buildServerProvider, parseGenericCliVersion } from "../providerSnapshot";
import { installPiCompatibilityExtension, installPiGlobally } from "../piClaudeCompatibility";
import { PiProvider } from "../Services/PiProvider";

const PROVIDER = "pi" as const;
const execFileAsync = promisify(execFile);
class PiProviderCommandError extends Data.TaggedError("PiProviderCommandError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly code?: string;
}> {}

function commandError(cause: unknown): PiProviderCommandError {
  return new PiProviderCommandError({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
    ...(cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? { code: cause.code }
      : {}),
  });
}
const PI_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function parsePiModels(output: string): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return output
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const match = /^(\S+)\s+(\S+)\s+/.exec(line.trim());
      if (!match) return [];
      const slug = `${match[1]}/${match[2]}`;
      if (seen.has(slug)) return [];
      seen.add(slug);
      return [{ slug, name: match[2]!, isCustom: false, capabilities: PI_CAPABILITIES }];
    });
}

const run = (binaryPath: string, args: ReadonlyArray<string>, timeout = 15_000) =>
  Effect.tryPromise({
    try: () => execFileAsync(binaryPath, [...args], { timeout, windowsHide: true }),
    catch: commandError,
  });

function isMissingCommand(error: PiProviderCommandError): boolean {
  return error.code === "ENOENT";
}

const checkPiProvider = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const piSettings = yield* settings.getSettings.pipe(Effect.map((value) => value.providers.pi));
  const checkedAt = new Date().toISOString();

  if (!piSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  let versionResult = yield* Effect.result(run(piSettings.binaryPath, ["--version"]));
  if (
    versionResult._tag === "Failure" &&
    piSettings.binaryPath === "pi" &&
    isMissingCommand(versionResult.failure)
  ) {
    yield* Effect.result(Effect.tryPromise({ try: installPiGlobally, catch: commandError }));
    versionResult = yield* Effect.result(run(piSettings.binaryPath, ["--version"]));
  }

  if (versionResult._tag === "Failure") {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Could not install or run Pi Coding Agent: ${versionResult.failure}`,
      },
    });
  }

  const extensionInstall = yield* Effect.result(
    Effect.tryPromise({
      try: installPiCompatibilityExtension,
      catch: String,
    }),
  );
  if (extensionInstall._tag === "Failure") {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: parseGenericCliVersion(versionResult.success.stdout),
        status: "error",
        auth: { status: "unknown" },
        message: `Pi is installed, but the Claude compatibility extension could not be installed: ${extensionInstall.failure}`,
      },
    });
  }
  const listed = yield* Effect.result(run(piSettings.binaryPath, ["--list-models"]));
  const discovered = listed._tag === "Success" ? parsePiModels(listed.success.stdout) : [];
  const known = new Set(discovered.map((model) => model.slug));
  const models = [
    ...discovered,
    ...piSettings.customModels
      .map((model) => model.trim())
      .filter((model) => model && !known.has(model))
      .map((slug) => ({ slug, name: slug, isCustom: true, capabilities: PI_CAPABILITIES })),
  ];

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parseGenericCliVersion(versionResult.success.stdout),
      status: "ready",
      auth: { status: "unknown" },
      message: "Pi is installed. Authentication is checked by the selected model provider.",
    },
  });
});

function initialSnapshot(settings: PiSettings): ServerProvider {
  return buildServerProvider({
    provider: PROVIDER,
    enabled: settings.enabled,
    checkedAt: new Date().toISOString(),
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Pi Coding Agent availability...",
    },
  });
}

export const PiProviderLive = Layer.effect(
  PiProvider,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    return yield* makeManagedServerProvider({
      getSettings: settings.getSettings.pipe(
        Effect.map((value) => value.providers.pi),
        Effect.orDie,
      ),
      streamSettings: settings.streamChanges.pipe(Stream.map((value) => value.providers.pi)),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot,
      checkProvider: checkPiProvider.pipe(Effect.provideService(ServerSettingsService, settings)),
      refreshInterval: "1 hour",
    });
  }),
);
