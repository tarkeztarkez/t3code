import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  decodePiCommandsResponseDataExit,
  PiRuntime,
  PiRuntimeError,
  piRuntimeErrorDetail,
  type PiCommand,
  type PiCommandInfo,
} from "../piRuntime.ts";

export function parsePiCommandSkills(
  commands: ReadonlyArray<PiCommandInfo>,
): ReadonlyArray<ServerProviderSkill> {
  const skills = new Map<string, ServerProviderSkill>();
  for (const command of commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const name = command.name.slice("skill:".length).trim();
    const path = command.path?.trim();
    if (!name || !path) continue;
    const description = command.description?.trim();
    const scope = command.location?.trim();
    skills.set(name, {
      name,
      path,
      enabled: true,
      ...(description ? { description, shortDescription: description } : {}),
      ...(scope ? { scope } : {}),
    });
  }
  return [...skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export function findReferencedPiSkills(
  text: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  const referenced = new Map<string, ServerProviderSkill>();
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2];
    if (!name) continue;
    const skill = skillsByName.get(name);
    if (skill) referenced.set(name, skill);
  }
  return [...referenced.values()];
}

export const discoverPiSkills = Effect.fn("discoverPiSkills")(function* (input: {
  readonly command: PiCommand;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly extensionPaths?: ReadonlyArray<string>;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, PiRuntimeError, PiRuntime> {
  const piRuntime = yield* PiRuntime;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const rpc = yield* piRuntime.spawnSession({
        ...input.command,
        cwd: input.cwd,
        ...(input.environment ? { environment: input.environment } : {}),
        runtimeMode: "full-access",
        noSession: true,
        noTools: true,
        ...(input.extensionPaths ? { extensionPaths: input.extensionPaths } : {}),
      });
      const response = yield* rpc.request({ type: "get_commands" }, { timeoutMs: 20_000 });
      if (!response.success) {
        return yield* new PiRuntimeError({
          operation: "get_commands",
          detail: response.error?.trim() || "Pi rejected the get_commands request.",
        });
      }
      const decoded = decodePiCommandsResponseDataExit(response.data);
      if (Exit.isFailure(decoded)) {
        return yield* new PiRuntimeError({
          operation: "get_commands",
          detail: "Pi returned malformed command inventory data.",
        });
      }
      return parsePiCommandSkills(decoded.value.commands);
    }),
  ).pipe(
    Effect.tapError((cause) =>
      Effect.logDebug("Pi skill discovery failed.", { detail: piRuntimeErrorDetail(cause) }),
    ),
  );
});
