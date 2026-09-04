import * as NodeFSP from "node:fs/promises";
import { executeCode } from "./runtime.mjs";

const quickjs = process.argv[2];
if (!quickjs) throw new Error("Usage on Linux: bun scripts/fx/benchmark.mjs /absolute/path/to/qjs");
await NodeFSP.access("/proc/self/status");
const rounds = 15;
const samples = { bun: [], quickjs: [] };
async function memory(pid) {
  const status = await NodeFSP.readFile(`/proc/${pid}/status`, "utf8");
  const kib = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
  return { rssKiB: kib("VmRSS"), peakRssKiB: kib("VmHWM") };
}
for (let round = 0; round < rounds; round++) {
  // Alternate order so one engine does not always get the cold filesystem.
  for (const engine of round % 2 ? ["quickjs", "bun"] : ["bun", "quickjs"]) {
    let pid;
    let readyMs;
    let sampledMemory;
    const start = performance.now();
    const result = await executeCode({
      engine,
      executable: engine === "bun" ? process.execPath : quickjs,
      code: "const rows = await Promise.all(Array.from({length: 32}, (_, i) => tools.echo({i}))); text(rows.reduce((n, row) => n + row.i, 0)); await tools.sample({});",
      onReady: (value) => {
        pid = value;
        readyMs = performance.now() - start;
      },
      tools: {
        echo: (value) => value,
        sample: async () => {
          sampledMemory = await memory(pid);
          return null;
        },
      },
    });
    if (result.output[0] !== 496) throw new Error("Benchmark result mismatch");
    samples[engine].push({ readyMs, elapsedMs: result.elapsedMs, ...sampledMemory });
  }
}
const median = (rows, key) =>
  [...rows].map((row) => row[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
console.log(
  JSON.stringify(
    {
      scope:
        "Disposable worker only; excludes T3, fx, model requests, and native shell tools. No CPU or whole-app speed claim.",
      rounds,
      results: Object.fromEntries(
        Object.entries(samples).map(([engine, rows]) => [
          engine,
          Object.fromEntries(
            ["readyMs", "elapsedMs", "rssKiB", "peakRssKiB"].map((key) => [key, median(rows, key)]),
          ),
        ]),
      ),
    },
    null,
    2,
  ),
);
