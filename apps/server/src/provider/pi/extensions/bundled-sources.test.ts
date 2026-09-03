import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runPiCommand } from "../../piRuntime.ts";
import { PI_SUBAGENTS_EXTENSION_SOURCE } from "./bundled-sources.ts";

it.effect("merges configured Pi subagents with the bundled profiles", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-subagents-" });
    const agentDir = path.join(tempDir, "agent");
    const extensionPath = path.join(tempDir, "pi-subagents.ts");

    yield* fileSystem.makeDirectory(path.join(agentDir, "pi-subagents"), { recursive: true });
    yield* fileSystem.writeFileString(extensionPath, PI_SUBAGENTS_EXTENSION_SOURCE);
    yield* fileSystem.writeFileString(
      path.join(agentDir, "pi-subagents", "agents.json"),
      '{"agents":[{"name":"sol-low","model":"openrouter/custom/override","reasoning_effort":"high"},{"name":"extra","model":"openrouter/custom/extra","reasoning_effort":"medium"}]}',
    );

    const script = `const extension = await import("${extensionPath}"); console.log([...extension.__testing.loadNamedAgents().values()].map(({name, model, reasoning_effort}) => [name, model, reasoning_effort].join("|")).join("\\n"));`;
    const result = yield* runPiCommand({
      binaryPath: "bun",
      args: ["-e", script],
      cwd: path.dirname(import.meta.filename),
      environment: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });

    assert.equal(result.stderr, "");
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      [
        "sol-low|openrouter/custom/override|high",
        "sol-medium|openai-codex/gpt-5.6-sol|medium",
        "sol-high|openai-codex/gpt-5.6-sol|high",
        "terra-low|openai-codex/gpt-5.6-terra|low",
        "terra-medium|openai-codex/gpt-5.6-terra|medium",
        "terra-high|openai-codex/gpt-5.6-terra|high",
        "luna-low|openai-codex/gpt-5.6-luna|low",
        "luna-medium|openai-codex/gpt-5.6-luna|medium",
        "luna-high|openai-codex/gpt-5.6-luna|high",
        "extra|openrouter/custom/extra|medium",
        "",
      ].join("\n"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
