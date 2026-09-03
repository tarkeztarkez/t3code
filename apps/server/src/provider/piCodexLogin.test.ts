import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePiCodexLoginCoordinator } from "./piCodexLogin.ts";

describe("Pi Codex login", () => {
  it.effect("uses Pi's device-code login and waits for it to persist credentials", () =>
    Effect.gen(function* () {
      let finishLogin!: () => void;
      let selectedMethod: string | undefined;
      const coordinator = makePiCodexLoginCoordinator({
        makeLoginId: () => "login-1",
        createRuntime: async (authPath) => {
          expect(authPath).toMatch(/state[/\\]pi[/\\]auth\.json$/);
          return {
            login: async (_providerId, _type, interaction) => {
              selectedMethod = await interaction.prompt({ type: "select" });
              interaction.notify({
                type: "device_code",
                userCode: "ABCD-EFGH",
                verificationUri: "https://auth.openai.com/codex/device",
                expiresInSeconds: 900,
              });
              await new Promise<void>((resolve) => (finishLogin = resolve));
            },
          };
        },
      });

      const login = yield* coordinator.start("/tmp/state");

      expect(selectedMethod).toBe("device_code");
      expect(login).toEqual({
        loginId: "login-1",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 900,
      });

      finishLogin();
      yield* coordinator.complete(login.loginId);
    }),
  );

  it.effect("aborts a cancelled login", () =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      const coordinator = makePiCodexLoginCoordinator({
        makeLoginId: () => "login-2",
        createRuntime: async () => ({
          login: async (_providerId, _type, interaction) => {
            signal = interaction.signal;
            interaction.notify({
              type: "device_code",
              userCode: "ABCD-EFGH",
              verificationUri: "https://auth.openai.com/codex/device",
              expiresInSeconds: 900,
            });
            await new Promise<void>((_resolve, reject) =>
              interaction.signal.addEventListener("abort", () => reject(new Error("cancelled"))),
            );
          },
        }),
      });

      const login = yield* coordinator.start("/tmp/state");
      yield* coordinator.cancel(login.loginId);

      expect(signal?.aborted).toBe(true);
    }),
  );
});
