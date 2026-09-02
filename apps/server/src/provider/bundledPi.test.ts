import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { bundledPiCommand } from "./bundledPi.ts";
import { runPiCommand } from "./piRuntime.ts";

it.effect("runs the Pi version shipped with T3 Code", () =>
  Effect.gen(function* () {
    const command = yield* bundledPiCommand;
    const result = yield* runPiCommand({ ...command, args: ["--version"] });

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trim(), "0.84.4");
  }).pipe(Effect.provide(NodeServices.layer)),
);
