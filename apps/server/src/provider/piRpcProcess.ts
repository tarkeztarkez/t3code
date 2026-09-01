import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type JsonObject = Record<string, unknown>;

export class PiRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
  >();

  constructor(
    binaryPath: string,
    args: ReadonlyArray<string>,
    cwd: string,
    private readonly onEvent: (event: JsonObject) => void,
  ) {
    this.child = spawn(binaryPath, [...args], { cwd, stdio: "pipe", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => this.rejectAll(new Error(`Pi exited with code ${code}.`)));
  }

  command(command: JsonObject): Promise<JsonObject> {
    const id = `t3-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop(): void {
    this.child.kill();
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonObject;
          const id = typeof message.id === "string" ? message.id : undefined;
          const pending = id ? this.pending.get(id) : undefined;
          if (pending && message.type === "response") {
            this.pending.delete(id!);
            if (message.success === false) {
              pending.reject(
                new Error(String(message.error ?? `Pi command failed: ${message.command}`)),
              );
            } else {
              pending.resolve(message);
            }
          } else {
            this.onEvent(message);
          }
        } catch {
          // Pi reserves stdout for JSONL. Ignore a malformed line and keep the session alive.
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
