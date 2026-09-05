import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import {
  HostProcessPlatform,
  HostProcessArchitecture,
} from "../../packages/shared/src/hostProcess.ts";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const build = NodePath.join(root, ".fx-build");
const runtime = NodePath.join(build, "runtime");
const platform = Effect.runSync(HostProcessPlatform);
const hostArch = Effect.runSync(HostProcessArchitecture);
const arch = platform === "darwin" ? "universal" : hostArch;
const required = process.env.T3_BUILD_FX === "1";
const available = (name, args) =>
  NodeChildProcess.spawnSync(name, args, { stdio: "ignore" }).status === 0;
const exists = (path) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );
const inputs = await Promise.all(
  [
    "sources.json",
    "native.patch",
    "code-worker.c",
    "worker-core.mjs",
    "build.mjs",
    "prepare.mjs",
  ].map((file) => NodeFSP.readFile(new URL(file, import.meta.url))),
);
const hash = NodeCrypto.createHash("sha256");
for (const input of inputs) hash.update(input);
const stamp = `${platform}-${arch}-${hash.digest("hex")}`;
const suffix = platform === "win32" ? ".exe" : "";
const cached = await NodeFSP.readFile(NodePath.join(runtime, "stamp"), "utf8").catch(() => "");
await NodeFSP.mkdir(build, { recursive: true });
function run(command, args, cwd = root) {
  const child = NodeChildProcess.spawnSync(command, args, { cwd, stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`${command} failed with ${child.status}`);
}
if (
  cached !== stamp ||
  !(await exists(NodePath.join(runtime, `fx${suffix}`))) ||
  !(await exists(NodePath.join(runtime, `fx-code-worker${suffix}`)))
) {
  if (
    platform === "win32" ||
    !available("zig", ["version"]) ||
    !available("cmake", ["--version"])
  ) {
    if (required) throw new Error("Bundling fx requires Zig 0.16.0, CMake and a C compiler");
    console.warn(
      "[fx] Native fx requires a POSIX host with Zig 0.16.0, CMake and a C compiler. fx will report unavailable here. Windows clients can use a Linux or macOS environment. Set T3_BUILD_FX=1 to require the native build.",
    );
    await NodeFSP.rm(runtime, { recursive: true, force: true });
    await NodeFSP.mkdir(runtime, { recursive: true });
  } else {
    const temporary = await NodeFSP.mkdtemp(NodePath.join(build, "compile-"));
    try {
      for (const engine of ["fx", "quickjs"])
        run(process.execPath, [
          NodeURL.fileURLToPath(new URL("./build.mjs", import.meta.url)),
          engine,
          NodePath.join(temporary, engine),
        ]);
      const next = NodePath.join(temporary, "runtime");
      await NodeFSP.mkdir(next);
      await NodeFSP.copyFile(
        NodePath.join(temporary, "fx/zig-out/bin", `fx${suffix}`),
        NodePath.join(next, `fx${suffix}`),
      );
      if (platform === "darwin") {
        const other = hostArch === "arm64" ? "x86_64" : "aarch64";
        run(
          "zig",
          [
            "build",
            `-Dtarget=${other}-macos`,
            "-Doptimize=ReleaseFast",
            "--prefix",
            NodePath.join(temporary, "other"),
          ],
          NodePath.join(temporary, "fx"),
        );
        run("lipo", [
          "-create",
          NodePath.join(next, "fx"),
          NodePath.join(temporary, "other/bin/fx"),
          "-output",
          NodePath.join(next, "fx-universal"),
        ]);
        await NodeFSP.rename(NodePath.join(next, "fx-universal"), NodePath.join(next, "fx"));
      }
      const quickjs = NodePath.join(temporary, "quickjs/build");
      const worker = (await exists(NodePath.join(quickjs, `fx-code-worker${suffix}`)))
        ? NodePath.join(quickjs, `fx-code-worker${suffix}`)
        : NodePath.join(quickjs, "Release", `fx-code-worker${suffix}`);
      await NodeFSP.copyFile(worker, NodePath.join(next, `fx-code-worker${suffix}`));
      for (const engine of ["fx", "quickjs"])
        await NodeFSP.copyFile(
          NodePath.join(temporary, engine, "LICENSE"),
          NodePath.join(next, `${engine}.LICENSE`),
        );
      await NodeFSP.writeFile(NodePath.join(next, "stamp"), stamp);
      await NodeFSP.writeFile(
        NodePath.join(next, "target.json"),
        JSON.stringify({ platform, arch }),
      );
      await NodeFSP.rm(runtime, { recursive: true, force: true });
      await NodeFSP.rename(next, runtime);
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  }
}
await NodeFSP.copyFile(
  new URL("./worker-core.mjs", import.meta.url),
  NodePath.join(runtime, "worker-core.mjs"),
);
const destination = NodePath.join(root, "apps/server/dist/fx");
await NodeFSP.rm(destination, { recursive: true, force: true });
await NodeFSP.cp(runtime, destination, { recursive: true });
console.log(`[fx] Runtime staged at ${destination}`);
