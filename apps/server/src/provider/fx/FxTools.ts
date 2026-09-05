// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
// @effect-diagnostics globalTimers:off - Native subprocess deadlines must fire independently of the Effect clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { parse } from "smol-toml";
import { directToolYieldTime } from "@howaboua/pi-codex-conversion/dist/tools/code-mode/tool-source.js";
import { createExecSessionManager } from "@howaboua/pi-codex-conversion/dist/tools/exec/session-manager.js";
import { executePatchWithRust } from "@howaboua/pi-codex-conversion/dist/tools/apply-patch/executor.js";
import { getBundledToolBinaryPath } from "@howaboua/pi-codex-conversion/dist/tools/native/binary.js";
import { runBundledTool } from "@howaboua/pi-codex-conversion/dist/tools/native/runner.js";
import { imageContentFromViewImageOutput } from "@howaboua/pi-codex-conversion/dist/tools/view-image/output.js";
import { executeCode } from "../../../../../scripts/fx/runtime.mjs";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}
const optionalString = Schema.optionalKey(Schema.String);
const decodeStrings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const decodeYield = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const optionalNumber = Schema.optionalKey(
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
);
const execInput = Schema.decodeUnknownSync(
  Schema.Struct({
    cmd: Schema.String,
    workdir: optionalString,
    shell: optionalString,
    tty: Schema.optionalKey(Schema.Boolean),
    login: Schema.optionalKey(Schema.Boolean),
    yield_time_ms: optionalNumber,
    max_output_tokens: optionalNumber,
  }),
);
const stdinInput = Schema.decodeUnknownSync(
  Schema.Struct({
    session_id: Schema.Int,
    chars: optionalString,
    yield_time_ms: optionalNumber,
    max_output_tokens: optionalNumber,
  }),
);

export const FX_TOOLS = [
  {
    name: "exec",
    description:
      'Execute disposable JavaScript. Await tools and print selected results with text(value). No OS bindings or persistent globals. Supports // @exec: {"yield_time_ms": 30000, "max_output_tokens": 10000}. Use wait for yielded cells.',
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Resume or terminate a yielded exec cell.",
    inputSchema: {
      type: "object",
      properties: {
        cell_id: { type: "string" },
        yield_time_ms: { type: "integer", minimum: 0, maximum: 300000 },
        max_output_tokens: { type: "integer", minimum: 1, maximum: 100000 },
        terminate: { type: "boolean" },
      },
      required: ["cell_id"],
      additionalProperties: false,
    },
  },
] as const;
export const FX_TOOL_INSTRUCTIONS = `Use exec to compose host tools. Each cell is fresh JavaScript with tools, text, image, generatedImage and ALL_TOOLS. No imports, console, Node, Deno, filesystem or network bindings. Await every tool call. Bare values are discarded. Only deferred custom tools appear in ALL_TOOLS. Do not invent tools or enable example tools.
Printed output is capped at 60 KiB per cell for native delivery. Filter large tool results in JavaScript before calling text().
tools.exec_command({cmd, workdir?, shell?, tty?, login?, yield_time_ms?, max_output_tokens?}) runs shell commands. Use tty:true for input and persistent processes. tools.write_stdin({session_id, chars?, yield_time_ms?, max_output_tokens?}) resumes them.
tools.apply_patch(patch) applies the standard *** Begin Patch / *** End Patch format. tools.view_image({path, detail?}) returns an image handle. Call image(handle) to show it to the model. generatedImage(handle) is an alias. Text files belong in exec_command, not view_image.
tools.request_user_input({questions:[{id,header,question,options:[{label,description}]}]}) asks the user and waits. tools.update_plan({plan:[{step,status}],explanation?}) updates the plan. Status is pending, in_progress or completed.
tools.mcp({search?,describe?,tool?,args?,server?,connect?}) discovers or calls configured MCP tools. Search and describe before calling an unfamiliar tool. MCP calls also work inside JavaScript compositions. Custom tools accept one string and return one string. Read their exact usage in ALL_TOOLS before calling them. Subagents and Notebook Mode are unavailable.`;

type HostCall = (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
export async function makeFxTools(options: {
  cwd: string;
  home: string;
  storage: string;
  executable: string;
  workerPath: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  authorize: HostCall;
  invoke: HostCall;
}) {
  const shells = createExecSessionManager({
    env: options.environment,
    maxSessionBufferChars: 1024 * 1024,
  });
  const imagesDir = NodePath.join(options.storage, "images");
  await NodeFSP.mkdir(imagesDir, { recursive: true, mode: 0o700 });
  const catalog: { name: string; usage: string; description: string; output: string }[] = [];
  const custom = new Map<
    string,
    { command: string; args: string[]; stdin: boolean; yieldMs?: number; error?: string }
  >();
  const promoted = new Map<string, string>();
  const refreshCustom = async () => {
    custom.clear();
    catalog.length = 0;
    promoted.clear();
    for (const dir of [
      NodePath.join(
        options.environment.PI_CODING_AGENT_DIR ?? NodePath.join(options.home, ".pi/agent"),
        "codex-conversion-custom-tools",
      ),
      NodePath.join(options.cwd, ".pi/codex-conversion-custom-tools"),
    ]) {
      const entries = await NodeFSP.readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries.filter((n) => n.endsWith(".toml")).sort()) {
        const name = entry.slice(0, -5);
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name))
          throw new Error(`Invalid custom tool name: ${name}`);
        custom.delete(name);
        promoted.delete(name);
        const previous = catalog.findIndex((t) => t.name === name);
        if (previous >= 0) catalog.splice(previous, 1);
        try {
          const path = NodePath.join(dir, entry);
          if ((await NodeFSP.stat(path)).size > 64 * 1024)
            throw new Error("Custom tool definition exceeds 64 KiB");
          const value = parse(await NodeFSP.readFile(path, "utf8"));
          if (
            Object.keys(value).some(
              (k) =>
                ![
                  "usage",
                  "description",
                  "output",
                  "command",
                  "args",
                  "input",
                  "defer_loading",
                  "yield_time_ms",
                ].includes(k),
            )
          )
            throw new Error("Unknown custom tool field");
          let command = string(value.command);
          let args = value.args === undefined ? [] : decodeStrings(value.args).slice();
          if (command.includes("/") || command.includes("\\"))
            command = NodePath.resolve(dir, command);
          if (NodePath.isAbsolute(command) && /\.(?:cjs|mjs|js)$/i.test(command)) {
            args = [command, ...args];
            command = process.execPath;
          }
          if (value.input !== undefined && value.input !== "arg" && value.input !== "stdin")
            throw new Error("Invalid custom tool input mode");
          if (value.defer_loading !== undefined && typeof value.defer_loading !== "boolean")
            throw new Error("Invalid defer_loading");
          const usage = string(value.usage);
          const yieldMs =
            value.yield_time_ms === undefined ? undefined : decodeYield(value.yield_time_ms);
          custom.set(name, {
            command,
            args,
            stdin: value.input === "stdin",
            ...(yieldMs === undefined ? {} : { yieldMs }),
          });
          if (value.defer_loading === false) promoted.set(name, usage);
          else
            catalog.push({
              name,
              usage,
              description: value.description === undefined ? "" : string(value.description),
              output: value.output === undefined ? "" : string(value.output),
            });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid custom tool";
          custom.set(name, { command: "", args: [], stdin: false, error: message });
          catalog.push({
            name,
            usage: `await tools.${name}(input)`,
            description: message,
            output: "Configuration error",
          });
        }
      }
    }
  };
  await refreshCustom();
  const capturedPromotions = new Map(promoted);
  const invoke: HostCall = async (name, input, signal) => {
    await options.authorize(name, input, signal);
    switch (name) {
      case "exec_command":
        return shells.exec(execInput(input), options.cwd, signal);
      case "write_stdin":
        return shells.write(stdinInput(input), signal);
      case "apply_patch":
        return executePatchWithRust({ cwd: options.cwd, patchText: string(input), signal });
      case "view_image": {
        const value = record(input);
        const binary = getBundledToolBinaryPath("view_image", {
          platform: options.platform,
          arch: options.arch,
        });
        if (!binary) throw new Error("No bundled view_image executable for this host");
        const path = string(value.path);
        const detail = value.detail === "original" ? "original" : "high";
        const result = await runBundledTool({
          binary,
          args: [JSON.stringify({ path, detail })],
          cwd: options.cwd,
          signal,
          maxBuffer: 32 * 1024 * 1024,
        });
        if (result.status !== 0) throw new Error(result.stderr || "view_image failed");
        const image = imageContentFromViewImageOutput(result.stdout);
        if (!image) throw new Error("view_image expected an image");
        const id = NodeCrypto.createHash("sha256").update(image.data).digest("hex");
        await NodeFSP.writeFile(NodePath.join(imagesDir, `${id}.json`), JSON.stringify(image), {
          mode: 0o600,
        });
        return { id };
      }
      case "request_user_input":
      case "update_plan":
      case "mcp": {
        const result = await options.invoke(name, input, signal);
        if (
          name !== "mcp" ||
          !result ||
          typeof result !== "object" ||
          !("content" in result) ||
          !Array.isArray(result.content)
        )
          return result;
        const content = await Promise.all(
          result.content.map(async (block) => {
            const item = record(block);
            if (item.type !== "image") return item;
            const data = string(item.data);
            if (data.length > 24 * 1024 * 1024) throw new Error("MCP image exceeds limit");
            const id = NodeCrypto.createHash("sha256").update(data).digest("hex");
            await NodeFSP.writeFile(NodePath.join(imagesDir, `${id}.json`), JSON.stringify(item), {
              mode: 0o600,
            });
            return { type: "image", id };
          }),
        );
        return { ...result, content };
      }
      default: {
        const tool = custom.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        if (tool.error) throw new Error(tool.error);
        const value = string(input);
        const result = await runBundledTool({
          binary: tool.command,
          args: tool.stdin ? tool.args : [...tool.args, value],
          ...(tool.stdin ? { stdin: value } : {}),
          cwd: options.cwd,
          env: options.environment,
          signal,
          maxBuffer: 50 * 1024,
        });
        if (result.status !== 0)
          throw new Error(result.stderr || `Custom tool exited with ${result.status}`);
        return result.stdout.trim() || result.stderr.trim() || "(no output)";
      }
    }
  };
  type Cell = {
    id: string;
    controller: AbortController;
    done: Promise<void>;
    output: unknown[];
    error?: string;
    settled: boolean;
    detach: () => void;
  };
  let cell: Cell | undefined;
  const observe = async (current: Cell, yieldMs: number, maxTokens: number) => {
    if (
      !Number.isSafeInteger(yieldMs) ||
      yieldMs < 0 ||
      yieldMs > 300000 ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > 100000
    )
      throw new Error("Invalid exec/wait limits");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      current.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, yieldMs);
      }),
    ]);
    clearTimeout(timer);
    if (!current.settled)
      return { content: JSON.stringify({ cell_id: current.id, status: "running" }) };
    cell = undefined;
    current.detach();
    const imageIds: string[] = [];
    const output = current.output
      .map((value) => {
        if (value && typeof value === "object" && "fxImage" in value) {
          imageIds.push(string(record(value.fxImage).id));
          return "[Image]";
        }
        return typeof value === "string" ? value : JSON.stringify(value);
      })
      .join("\n");
    let text = (current.error ?? output).slice(0, maxTokens * 4);
    if (Buffer.byteLength(text) > 60 * 1024)
      text =
        Buffer.from(text)
          .subarray(0, 60 * 1024)
          .toString("utf8") + "\n[Output truncated. Filter the result before printing.]";
    return {
      content: imageIds.length
        ? JSON.stringify({ t3_fx_images: imageIds, text })
        : text || "(no output)",
      ...(current.error ? { isError: true } : {}),
    };
  };
  const cancelCell = async () => {
    if (!cell) return;
    const current = cell;
    current.controller.abort();
    await current.done;
    current.detach();
    cell = undefined;
  };
  return {
    instructions: [...capturedPromotions.values()].join("\n"),
    cancelCell,
    async call(name: string, input: unknown, signal: AbortSignal) {
      const value = record(input);
      if (name === "wait") {
        if (!cell || value.cell_id !== cell.id) throw new Error("Unknown or completed exec cell");
        if (value.terminate === true) cell.controller.abort();
        return observe(
          cell,
          Number(value.yield_time_ms ?? 10000),
          Number(value.max_output_tokens ?? 10000),
        );
      }
      if (name !== "exec") throw new Error("Only exec and wait are exposed");
      if (cell) throw new Error("Resume or terminate the yielded cell with wait first");
      const code = string(value.code);
      const pragma = /^\s*\/\/ @exec:\s*(\{[^\n]*\})\r?\n/.exec(code);
      const controls = pragma ? record(JSON.parse(pragma[1]!)) : {};
      await refreshCustom();
      for (const [name, usage] of promoted)
        if (!capturedPromotions.has(name))
          catalog.push({ name, usage, description: "", output: "" });
      const forced = directToolYieldTime(
        code,
        [...custom].map(([name, tool]) => ({
          name,
          command: tool.command,
          args: tool.args,
          input: tool.stdin ? "stdin" : "arg",
          usage: "",
          sourcePath: "",
          deferLoading: true,
          yieldTimeMs: tool.yieldMs,
        })),
      );
      const yieldMs = Math.min(300000, forced ?? Number(controls.yield_time_ms ?? 30000));
      const maxTokens = Number(controls.max_output_tokens ?? 10000);
      if (
        !Number.isSafeInteger(yieldMs) ||
        yieldMs < 0 ||
        !Number.isSafeInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 100000
      )
        throw new Error("Invalid exec limits");
      signal.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const current: Cell = {
        id: NodeCrypto.randomUUID(),
        controller,
        output: [],
        settled: false,
        done: Promise.resolve(),
        detach: () => signal.removeEventListener("abort", abort),
      };
      cell = current;
      current.done = executeCode({
        engine: "quickjs-isolated",
        executable: options.executable,
        workerPath: options.workerPath,
        code,
        catalog,
        timeoutMs: 24 * 60 * 60 * 1000,
        signal: controller.signal,
        tools: Object.fromEntries(
          [
            "exec_command",
            "write_stdin",
            "apply_patch",
            "view_image",
            "request_user_input",
            "update_plan",
            "mcp",
            ...custom.keys(),
          ].map((name) => [
            name,
            (input: unknown, signal: AbortSignal) => invoke(name, input, signal),
          ]),
        ),
      })
        .then(
          (result) => {
            current.output = result.output;
          },
          (error) => {
            current.error = error instanceof Error ? error.message : "Execution failed";
          },
        )
        .finally(() => {
          current.settled = true;
        });
      return observe(current, yieldMs, maxTokens);
    },
    async expandImages(id: string): Promise<unknown> {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid image reference");
      const image = record(
        JSON.parse(await NodeFSP.readFile(NodePath.join(imagesDir, `${id}.json`), "utf8")),
      );
      return {
        type: "input_image",
        image_url: `data:${string(image.mimeType)};base64,${string(image.data)}`,
        detail: image.detail,
      };
    },
    async close() {
      await cancelCell();
      await shells.shutdown();
    },
  };
}
