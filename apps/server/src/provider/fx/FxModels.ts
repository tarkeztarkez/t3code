// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ServerProviderModel } from "@t3tools/contracts";
import { record } from "./FxTools.ts";

// Model labels/IDs may be overridden; credentials and endpoint overrides may
// not. fx remains a Codex-subscription provider with a fixed trusted transport.
export async function mergeFxModels(
  models: readonly ServerProviderModel[],
  agentDir: string,
): Promise<ServerProviderModel[]> {
  const path = NodePath.join(agentDir, "models.json");
  const size = await NodeFSP.stat(path).then(
    (stat) => stat.size,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (size === undefined) return [...models];
  if (size > 1024 * 1024) throw new Error("models.json exceeds 1 MiB");
  const root = record(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  const provider = record(record(root.providers ?? {})["openai-codex"] ?? {});
  const overrides = Array.isArray(provider.models) ? provider.models : [];
  const result = new Map(models.map((model) => [model.slug, model]));
  for (const entry of overrides) {
    const model = record(entry);
    if (typeof model.id !== "string" || !model.id.trim() || model.id.length > 200)
      throw new Error("Invalid Codex model ID in models.json");
    const previous = result.get(model.id);
    result.set(model.id, {
      ...previous,
      slug: model.id,
      name:
        typeof model.name === "string" && model.name.trim()
          ? model.name
          : (previous?.name ?? model.id),
      isCustom: !previous || previous.isCustom,
      capabilities:
        model.reasoning === false ? { optionDescriptors: [] } : (previous?.capabilities ?? null),
    });
  }
  return [...result.values()];
}
