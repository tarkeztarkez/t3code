import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { test, expect } from "vitest";
import { makeFxTools } from "./FxTools.ts";
import { prepareFxRequest } from "./FxWire.ts";

const executable = process.env.FX_ISOLATED_BINARY;
test.skipIf(!executable)(
  "Code Mode yields, cancels, loads live custom definitions and expands image handles",
  async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-tools-"));
    const dir = NodePath.join(home, ".pi/codex-conversion-custom-tools");
    await NodeFSP.mkdir(dir, { recursive: true });
    const gate = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const tools = await makeFxTools({
      home,
      cwd: home,
      storage: NodePath.join(home, "storage"),
      executable: executable!,
      workerPath: NodeURL.fileURLToPath(
        new URL("../../../../../scripts/fx/worker-core.mjs", import.meta.url),
      ),
      environment: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" },
      platform: "linux",
      arch: "x64",
      authorize: async () => {},
      invoke: async (name, _input, signal) => {
        if (name === "mcp")
          return { content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] };
        entered.resolve();
        signal.addEventListener("abort", () => gate.reject(new Error("cancelled")), { once: true });
        return gate.promise;
      },
    });
    const signal = new AbortController().signal;
    try {
      await expect(
        tools.call("exec", { code: '// @exec: {"max_output_tokens":0}\ntext("bad");' }, signal),
      ).rejects.toThrow("Invalid exec limits");
      const yielded = await tools.call(
        "exec",
        { code: '// @exec: {"yield_time_ms":0}\ntext(await tools.request_user_input({}));' },
        signal,
      );
      const id = JSON.parse(yielded.content).cell_id as string;
      expect(typeof id).toBe("string");
      await entered.promise;
      await expect(tools.call("exec", { code: "text(1)" }, signal)).rejects.toThrow("yielded cell");
      gate.resolve("answer");
      expect((await tools.call("wait", { cell_id: id }, signal)).content).toBe("answer");
      expect(
        (
          await tools.call(
            "exec",
            { code: "text(typeof globalThis.remembered); globalThis.remembered=1;" },
            signal,
          )
        ).content,
      ).toBe("undefined");
      expect(
        (await tools.call("exec", { code: "text(typeof globalThis.remembered);" }, signal)).content,
      ).toBe("undefined");
      const custom =
        'usage = "await tools.echo(\\\"text\\\")"\ncommand = "' +
        process.execPath.replaceAll("\\", "\\\\") +
        '"\nargs = ["-e", "process.stdout.write(process.argv[1])"]\n';
      await NodeFSP.writeFile(NodePath.join(dir, "echo.toml"), custom);
      expect(
        (
          await tools.call(
            "exec",
            { code: 'text(ALL_TOOLS.map(t=>t.name)); text(await tools.echo("live"));' },
            signal,
          )
        ).content,
      ).toContain("live");
      await NodeFSP.writeFile(NodePath.join(dir, "echo.toml"), 'command = "missing-usage"');
      expect(
        (await tools.call("exec", { code: 'text(await tools.echo("x"));' }, signal)).isError,
      ).toBe(true);
      const image = await tools.call("exec", { code: "image(await tools.mcp({}));" }, signal);
      expect(image.content).not.toContain("iVBOR");
      const body = {
        model: "gpt-6-astra",
        instructions: "stable",
        input: [{ type: "function_call_output", call_id: "x", output: image.content }],
        tools: [],
      };
      const wire = await prepareFxRequest(JSON.stringify(body), tools.expandImages);
      expect(wire.body).toContain("data:image/png;base64,iVBORw0KGgo=");
      expect(wire.lite).toBe(true);
      const spinning = await tools.call(
        "exec",
        { code: '// @exec: {"yield_time_ms":0}\nwhile(true){}' },
        signal,
      );
      const stopped = await tools.call(
        "wait",
        { cell_id: JSON.parse(spinning.content).cell_id, terminate: true },
        signal,
      );
      expect(stopped.isError).toBe(true);
      expect((await tools.call("exec", { code: "text(42)" }, signal)).content).toBe("42");
    } finally {
      await tools.close();
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);
