import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const moduleUrl = (path) =>
  NodeURL.pathToFileURL(require.resolve(`@howaboua/pi-codex-conversion/dist/${path}.js`)).href;
const { createExecSessionManager } = await import(moduleUrl("tools/exec/session-manager"));
const { executePatchWithRust } = await import(moduleUrl("tools/apply-patch/executor"));

// Reuse implementations, not Pi's extension factory or agent runtime. Each host
// owns its shell sessions. Production approval routing is not implemented here.
export function createFixtureTools(cwd) {
  const sessions = createExecSessionManager({ maxSessionBufferChars: 1024 * 1024 });
  return {
    tools: {
      exec_command: (input, signal) => sessions.exec(input, cwd, signal),
      write_stdin: (input, signal) => sessions.write(input, signal),
      apply_patch: (patchText, signal) => executePatchWithRust({ cwd, patchText, signal }),
    },
    close: () => sessions.shutdown(),
  };
}
