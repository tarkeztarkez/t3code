import { afterEach, describe, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { executeCode } from "./runtime.mjs";
import { createFixtureTools } from "./tools.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
const engines = [["bun", process.execPath]];
if (process.env.FX_QUICKJS_BINARY) engines.push(["quickjs", process.env.FX_QUICKJS_BINARY]);
else console.warn("QuickJS cases omitted. Set FX_QUICKJS_BINARY for parity verification.");

for (const [engine, executable] of engines)
  describe(engine, () => {
    const run = (options) => executeCode({ engine, executable, ...options });
    test("composes async tools, preserves Unicode, and reports tool errors", async () => {
      const result = await run({
        code: `
      const rows = await Promise.all([tools.echo({text: "żółć 🌒"}), tools.echo({text: "second"})]);
      text(rows);
      try { await tools.missing({}); } catch (error) { text(error.message); }
    `,
        tools: { echo: async (value) => value },
      });
      expect(result.output).toEqual([
        [{ text: "żółć 🌒" }, { text: "second" }],
        "Error: Unknown tool: missing",
      ]);
    });
    test("discards globals between executions", async () => {
      await run({ code: "globalThis.previous = 42;" });
      expect((await run({ code: "text(typeof previous);" })).output).toEqual(["undefined"]);
    });
    test("kills an infinite loop at the execution deadline", async () => {
      await expect(run({ code: "while (true) {}", timeoutMs: 200 })).rejects.toThrow("deadline");
    });
    test("aborts host tools when the caller cancels", async () => {
      const controller = new AbortController();
      let hostAborted = false;
      await expect(
        run({
          code: "await tools.block({});",
          signal: controller.signal,
          tools: {
            block: (_input, signal) =>
              new Promise((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    hostAborted = true;
                    resolve(null);
                  },
                  { once: true },
                );
                controller.abort(new Error("User cancelled"));
              }),
          },
        }),
      ).rejects.toThrow("User cancelled");
      expect(hostAborted).toBe(true);
    });
    test("rejects oversized output", async () => {
      await expect(run({ code: 'text("x".repeat(2 * 1024 * 1024));' })).rejects.toThrow(
        "exceeds 1 MiB",
      );
    });
    test("rejects forgotten awaits instead of orphaning tools", async () => {
      await expect(
        run({ code: "tools.echo({});", tools: { echo: () => new Promise(() => {}) } }),
      ).rejects.toThrow("unawaited tools");
    });
    test("uses the bundled native shell and patch implementations", async () => {
      const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-tools-"));
      directories.push(cwd);
      const host = createFixtureTools(cwd);
      try {
        const patch = "*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch";
        await run({
          code: `text(await tools.apply_patch(${JSON.stringify(patch)}));`,
          tools: host.tools,
        });
        expect(await NodeFSP.readFile(NodePath.join(cwd, "example.txt"), "utf8")).toBe("hello\n");
        const result = await run({
          code: 'text(await tools.exec_command({cmd: "cat example.txt"}));',
          tools: host.tools,
        });
        expect(result.output[0].output).toBe("hello\n");
        expect(result.output[0].exit_code).toBe(0);
      } finally {
        await host.close();
      }
    });
  });
