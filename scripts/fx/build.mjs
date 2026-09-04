import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [engine, target] = process.argv.slice(2);
const sources = JSON.parse(
  await NodeFSP.readFile(new URL("./sources.json", import.meta.url), "utf8"),
);
if (!Object.hasOwn(sources, engine) || !target)
  throw new Error("Usage: bun scripts/fx/build.mjs fx|quickjs NEW_DIRECTORY");
const cwd = NodePath.resolve(target);
// Never reset or modify an existing checkout or installation.
await NodeFSP.mkdir(cwd, { mode: 0o700 });
function run(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status}`);
}
const source = sources[engine];
run("git", ["init"]);
run("git", ["remote", "add", "origin", source.repository]);
run("git", ["fetch", "--depth", "1", "origin", source.commit]);
run("git", ["checkout", "--detach", source.commit]);
if (engine === "fx") {
  run("git", [
    "apply",
    "--check",
    NodeURL.fileURLToPath(new URL("./native.patch", import.meta.url)),
  ]);
  run("git", ["apply", NodeURL.fileURLToPath(new URL("./native.patch", import.meta.url))]);
  run("zig", ["build", "-Doptimize=ReleaseFast"]);
} else {
  const workerSource = NodeURL.fileURLToPath(
    new URL("./code-worker.c", import.meta.url),
  ).replaceAll("\\", "/");
  await NodeFSP.appendFile(
    NodePath.join(cwd, "CMakeLists.txt"),
    `\nadd_executable(fx-code-worker ${JSON.stringify(workerSource)})\ntarget_link_libraries(fx-code-worker PRIVATE qjs)\n`,
  );
  run("cmake", ["-S", ".", "-B", "build", "-DCMAKE_BUILD_TYPE=Release"]);
  run("cmake", ["--build", "build", "--target", "qjs_exe", "fx-code-worker", "-j", "4"]);
}
console.log(
  JSON.stringify({
    engine,
    commit: source.commit,
    executable: NodePath.resolve(cwd, engine === "fx" ? "zig-out/bin/fx" : "build/qjs"),
  }),
);
