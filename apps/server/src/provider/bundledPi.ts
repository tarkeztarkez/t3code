// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import type { PiCommand } from "./piRuntime.ts";

const bundledPiRpcEntryPath = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
);

export const bundledPiCommand: Effect.Effect<PiCommand> = Effect.map(
  HostProcessExecutablePath,
  (binaryPath) => ({
    binaryPath,
    argsPrefix: [NodePath.join(NodePath.dirname(bundledPiRpcEntryPath), "cli.js")],
  }),
);
