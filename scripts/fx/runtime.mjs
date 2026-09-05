import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const MAX_BYTES = 1024 * 1024;
const asciiJson = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

// A single execution owns its process and its abort signal. There is no notebook
// state and no idle process per agent. Only quickjs-isolated omits OS bindings.
export function executeCode({
  engine,
  executable,
  code,
  tools = {},
  signal,
  timeoutMs = 10_000,
  onReady,
  workerPath,
  catalog = [],
}) {
  if (!["bun", "quickjs", "quickjs-isolated"].includes(engine)) throw new Error("Unknown engine");
  if (typeof code !== "string" || Buffer.byteLength(code) > 64 * 1024)
    throw new Error("Code exceeds 64 KiB");
  signal?.throwIfAborted();
  const started = performance.now();
  const worker =
    workerPath ??
    NodeURL.fileURLToPath(
      new URL(
        engine === "quickjs-isolated" ? "./worker-core.mjs" : `./${engine}-worker.mjs`,
        import.meta.url,
      ),
    );
  const args =
    engine === "quickjs" ? ["--memory-limit", "32768", "--stack-size", "1024", worker] : [worker];
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
    const controller = new AbortController();
    const output = [];
    let outputBytes = 0;
    let buffer = "";
    let stderr = "";
    let result;
    let failure;
    let ready = false;
    const calls = new Set();
    const stop = (error) => {
      failure ??= error;
      controller.abort();
      child.kill("SIGKILL");
    };
    const abort = () => stop(signal.reason ?? new Error("Execution cancelled"));
    const timer = setTimeout(() => stop(new Error("Execution deadline exceeded")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const send = (message) => {
      if (controller.signal.aborted) return;
      const line = `${asciiJson(message)}\n`;
      if (Buffer.byteLength(line) > MAX_BYTES) throw new Error("Worker message exceeds 1 MiB");
      child.stdin.write(line);
    };
    const accept = async (message) => {
      if (message.type === "ready" && !ready) {
        ready = true;
        await onReady?.(child.pid);
        send({ type: "execute", code, catalog });
      } else if (message.type === "call" && ready && !result) {
        if (!Number.isSafeInteger(message.id) || message.id <= 0 || calls.has(message.id))
          throw new Error("Invalid tool call ID");
        if (calls.size >= 64) throw new Error("Too many concurrent tool calls");
        calls.add(message.id);
        let response;
        try {
          if (!Object.hasOwn(tools, message.name)) throw new Error(`Unknown tool: ${message.name}`);
          response = {
            type: "result",
            id: message.id,
            value: await tools[message.name](message.input, controller.signal),
          };
        } catch (error) {
          response = { type: "result", id: message.id, error: String(error) };
        } finally {
          calls.delete(message.id);
        }
        send(response);
      } else if (message.type === "output" && ready && !result) {
        outputBytes += Buffer.byteLength(JSON.stringify(message.value) ?? "null");
        if (outputBytes > MAX_BYTES) throw new Error("Execution output exceeds 1 MiB");
        output.push(message.value);
      } else if (message.type === "done" && ready && !result) {
        if (calls.size) throw new Error("Execution completed with unawaited tools");
        result = { output, elapsedMs: performance.now() - started };
        child.stdin.end();
      } else if (message.type === "failed") {
        throw new Error(message.error);
      } else throw new Error("Unexpected worker message");
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES)
        return stop(new Error("Worker output exceeds 1 MiB"));
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          void accept(JSON.parse(line)).catch(stop);
        } catch (error) {
          stop(error);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdin.on("error", stop);
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Worker exited with ${code}: ${stderr}`));
      else resolve(result);
    });
  });
}
