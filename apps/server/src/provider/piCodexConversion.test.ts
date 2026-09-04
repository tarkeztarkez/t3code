import { resolveCodexCacheKeepalivePlan } from "@howaboua/pi-codex-conversion/dist/adapter/activation/cache-keepalive.js";
import { normalizeCodexConversionConfig } from "@howaboua/pi-codex-conversion/dist/adapter/activation/config.js";
import { resolveCodexRuntimePlan } from "@howaboua/pi-codex-conversion/dist/adapter/activation/runtime-plan.js";
import { supportsResponsesLiteModel } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex/responses-lite-model.js";
import { describe, expect, it } from "vitest";

import { PI_CODEX_CONVERSION_DEFAULT_CONFIG } from "./pi/default-config.ts";

const config = normalizeCodexConversionConfig(JSON.parse(PI_CODEX_CONVERSION_DEFAULT_CONFIG));
const sol = {
  id: "gpt-5.6-sol",
  name: "Sol",
  provider: "openai-codex",
  api: "openai-codex-responses" as const,
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};
const astra = { ...sol, id: "gpt-6-astra" };

describe("bundled Astra Codex conversion", () => {
  it.each(["code", "notebook", "normal"] as const)("matches Sol in %s mode", (mode) => {
    const plan = resolveCodexRuntimePlan({ model: astra }, config, mode);
    expect(plan).toEqual(resolveCodexRuntimePlan({ model: sol }, config, mode));
    expect(plan.kind).toBe(mode);
    expect(plan.transport).toBe(mode === "normal" ? "responses" : "responses-lite");
  });

  it("uses notebook tools with the shipped defaults", () => {
    expect(resolveCodexRuntimePlan({ model: astra }, config).toolNames).toEqual([
      "exec",
      "wait",
      "notebook",
    ]);
  });

  it("recognizes qualified Astra IDs without enabling unknown models", () => {
    expect(supportsResponsesLiteModel("openai-codex/GPT-6-ASTRA")).toBe(true);
    expect(supportsResponsesLiteModel("gpt-6-unknown")).toBe(false);
    expect(supportsResponsesLiteModel(undefined)).toBe(false);
  });

  it("matches Sol's keepalive interval and respects disabling it", () => {
    const plan = resolveCodexCacheKeepalivePlan(astra.id, config.openai);
    expect(plan).toEqual(resolveCodexCacheKeepalivePlan(sol.id, config.openai));
    expect(plan?.intervalMs).toBe(25 * 60 * 1_000);
    expect(
      resolveCodexCacheKeepalivePlan(astra.id, { ...config.openai, cacheKeepalive: false }),
    ).toBeUndefined();
  });
});
