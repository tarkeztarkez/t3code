import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { makePiToolSummaryGenerator } from "./PiAdapter.ts";

let agentDir: string;

beforeEach(async () => {
  agentDir = await Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.makeTempDirectory({ prefix: "t3-summary-test-" }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(agentDir, { recursive: true, force: true }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

const input = { toolName: "exec", args: { code: "text(1)" } };

it("reports a missing summary model", async () => {
  vi.spyOn(ModelRuntime.prototype, "getModel").mockReturnValue(undefined);
  const generate = makePiToolSummaryGenerator({ PI_CODING_AGENT_DIR: agentDir });
  await expect(generate(input)).rejects.toThrow(
    "Pi tool summary model not found: openai-codex/gpt-5.6-luna",
  );
});

it.each(["error", "aborted"] as const)("reports %s response details", async (stopReason) => {
  vi.spyOn(ModelRuntime.prototype, "completeSimple").mockResolvedValue({
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    content: [],
    stopReason,
    errorMessage: "OAuth auth derivation failed: Cannot find module openai-codex.js",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const generate = makePiToolSummaryGenerator({ PI_CODING_AGENT_DIR: agentDir });
  await expect(generate(input)).rejects.toThrow(
    `Pi tool summary failed for openai-codex/gpt-5.6-luna (${stopReason}): OAuth auth derivation failed: Cannot find module openai-codex.js`,
  );
});
