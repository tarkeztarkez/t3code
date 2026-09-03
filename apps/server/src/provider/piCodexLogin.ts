// @effect-diagnostics nodeBuiltinImport:off - Pi's SDK accepts a native auth file path.
// @effect-diagnostics globalTimersInEffect:off - pending third-party OAuth logins need process-wide expiry.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { PiCodexLoginError, type PiCodexLoginStartResult } from "@t3tools/contracts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";

interface LoginRuntime {
  readonly login: (
    providerId: string,
    type: "oauth",
    interaction: {
      readonly signal: AbortSignal;
      readonly prompt: (prompt: { readonly type: string }) => Promise<string>;
      readonly notify: (event: unknown) => void;
    },
  ) => Promise<unknown>;
}

interface PendingLogin {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface DeviceCodeEvent {
  readonly type: "device_code";
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
}

function isDeviceCodeEvent(event: unknown): event is DeviceCodeEvent {
  if (event === null || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return (
    value.type === "device_code" &&
    typeof value.userCode === "string" &&
    value.userCode.trim().length > 0 &&
    typeof value.verificationUri === "string" &&
    value.verificationUri.trim().length > 0 &&
    typeof value.expiresInSeconds === "number" &&
    Number.isFinite(value.expiresInSeconds) &&
    value.expiresInSeconds > 0
  );
}

function loginError(cause: unknown): PiCodexLoginError {
  const message = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return new PiCodexLoginError({ message: message || "OpenAI login failed." });
}

export function makePiCodexLoginCoordinator(input: {
  readonly createRuntime: (authPath: string) => Promise<LoginRuntime>;
  readonly makeLoginId?: () => string;
}) {
  const pending = new Map<string, PendingLogin>();

  const start = (stateDir: string): Effect.Effect<PiCodexLoginStartResult, PiCodexLoginError> =>
    Effect.tryPromise({
      try: async () => {
        const loginId = input.makeLoginId?.() ?? NodeCrypto.randomUUID();
        const controller = new AbortController();
        let resolveDeviceCode!: (event: DeviceCodeEvent) => void;
        let rejectDeviceCode!: (cause: unknown) => void;
        const deviceCode = new Promise<DeviceCodeEvent>((resolve, reject) => {
          resolveDeviceCode = resolve;
          rejectDeviceCode = reject;
        });
        const runtime = await input.createRuntime(NodePath.join(stateDir, "pi", "auth.json"));
        const completion = runtime
          .login("openai-codex", "oauth", {
            signal: controller.signal,
            prompt: async (prompt) => {
              if (prompt.type === "select") return "device_code";
              throw new Error(`Unexpected OpenAI login prompt: ${prompt.type}`);
            },
            notify: (event) => {
              if (isDeviceCodeEvent(event)) resolveDeviceCode(event);
            },
          })
          .then(() => {
            rejectDeviceCode(new Error("OpenAI login finished without a device code."));
          })
          .catch((cause) => {
            rejectDeviceCode(cause);
            throw cause;
          });
        void completion.catch(() => undefined);
        const timeout = setTimeout(() => {
          controller.abort();
          pending.delete(loginId);
        }, 16 * 60_000);
        timeout.unref?.();
        pending.set(loginId, { controller, completion, timeout });
        const event = await deviceCode;
        return {
          loginId,
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresInSeconds: event.expiresInSeconds,
        };
      },
      catch: loginError,
    });

  const complete = (loginId: string): Effect.Effect<void, PiCodexLoginError> =>
    Effect.tryPromise({
      try: async () => {
        const login = pending.get(loginId);
        if (!login) throw new Error("OpenAI login expired or was cancelled.");
        try {
          await login.completion;
        } finally {
          clearTimeout(login.timeout);
          pending.delete(loginId);
        }
      },
      catch: loginError,
    });

  const cancel = (loginId: string): Effect.Effect<void, PiCodexLoginError> =>
    Effect.sync(() => {
      const login = pending.get(loginId);
      if (!login) return;
      clearTimeout(login.timeout);
      login.controller.abort();
      pending.delete(loginId);
    });

  return { start, complete, cancel } as const;
}

export const piCodexLoginCoordinator = makePiCodexLoginCoordinator({
  createRuntime: (authPath) =>
    ModelRuntime.create({
      authPath,
      modelsPath: null,
      modelsStorePath: NodePath.join(NodePath.dirname(authPath), "models-store.json"),
    }),
});
