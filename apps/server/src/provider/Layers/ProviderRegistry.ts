/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect";

import { ServerConfig } from "../../config";
import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import { PiProviderLive } from "./PiProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { CursorProviderShape } from "../Services/CursorProvider";
import { CursorProvider } from "../Services/CursorProvider";
import type { PiProviderShape } from "../Services/PiProvider";
import { PiProvider } from "../Services/PiProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import {
  hydrateCachedProvider,
  PROVIDER_CACHE_IDS,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  cursorProvider: CursorProviderShape,
  piProvider: PiProviderShape,
): Effect.Effect<readonly [ServerProvider, ServerProvider, ServerProvider, ServerProvider]> =>
  Effect.all(
    [
      codexProvider.getSnapshot,
      claudeProvider.getSnapshot,
      cursorProvider.getSnapshot,
      piProvider.getSnapshot,
    ],
    {
      concurrency: "unbounded",
    },
  );

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0 ||
  model.capabilities?.supportsFastMode === true ||
  model.capabilities?.supportsThinkingToggle === true ||
  (model.capabilities?.contextWindowOptions.length ?? 0) > 0 ||
  (model.capabilities?.promptInjectedEffortLevels.length ?? 0) > 0;

const mergeProviderModels = (
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  if (nextModels.length === 0 && previousModels.length > 0) {
    return previousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return [...mergedModels, ...previousModels.filter((model) => !nextSlugs.has(model.slug))];
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(previousProvider.models, nextProvider.models),
      };

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const cursorProvider = yield* CursorProvider;
    const piProvider = yield* PiProvider;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const fallbackProviders = yield* loadProviders(
      codexProvider,
      claudeProvider,
      cursorProvider,
      piProvider,
    );
    const cachePathByProvider = new Map(
      PROVIDER_CACHE_IDS.map(
        (provider) =>
          [
            provider,
            resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              provider,
            }),
          ] as const,
      ),
    );
    const fallbackByProvider = new Map(
      fallbackProviders.map((provider) => [provider.provider, provider] as const),
    );
    const cachedProviders = yield* Effect.forEach(
      PROVIDER_CACHE_IDS,
      (provider) => {
        const filePath = cachePathByProvider.get(provider)!;
        const fallbackProvider = fallbackByProvider.get(provider)!;
        return readProviderStatusCache(filePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.map((cachedProvider) =>
            cachedProvider === undefined
              ? undefined
              : hydrateCachedProvider({
                  cachedProvider,
                  fallbackProvider,
                }),
          ),
        );
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(cachedProviders);

    const persistProvider = (provider: ServerProvider) =>
      writeProviderStatusCache({
        filePath: cachePathByProvider.get(provider.provider)!,
        provider,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const [previousProviders, providers] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [provider.provider, provider] as const),
          );

          for (const provider of nextProviders) {
            mergedProviders.set(
              provider.provider,
              mergeProviderSnapshot(mergedProviders.get(provider.provider), provider),
            );
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          return [[previousProviders, providers] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        yield* Effect.forEach(nextProviders, persistProvider, {
          concurrency: "unbounded",
          discard: true,
        });
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
      }

      return providers;
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      return yield* upsertProviders([provider], options);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex":
          return yield* codexProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        case "claudeAgent":
          return yield* claudeProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        case "cursor":
          return yield* cursorProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        case "pi":
          return yield* piProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        default:
          return yield* Effect.all(
            [
              codexProvider.refresh.pipe(
                Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
              ),
              claudeProvider.refresh.pipe(
                Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
              ),
              cursorProvider.refresh.pipe(
                Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
              ),
              piProvider.refresh.pipe(Effect.flatMap((nextProvider) => syncProvider(nextProvider))),
            ],
            {
              concurrency: "unbounded",
              discard: true,
            },
          ).pipe(Effect.andThen(Ref.get(providersRef)));
      }
    });

    yield* Stream.runForEach(codexProvider.streamChanges, (provider) =>
      syncProvider(provider),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(claudeProvider.streamChanges, (provider) =>
      syncProvider(provider),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(cursorProvider.streamChanges, (provider) =>
      syncProvider(provider),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(piProvider.streamChanges, (provider) => syncProvider(provider)).pipe(
      Effect.forkScoped,
    );

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(PiProviderLive),
);
