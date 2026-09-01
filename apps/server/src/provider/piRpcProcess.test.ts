import { describe, expect, it } from "vitest";

import { PiRpcProcess } from "./piRpcProcess";

describe("PiRpcProcess", () => {
  it("correlates JSONL responses and forwards events", async () => {
    const events: Array<Record<string, unknown>> = [];
    const rpc = new PiRpcProcess(
      "node",
      [
        "-e",
        `process.stdin.once("data", (chunk) => {
          const request = JSON.parse(String(chunk));
          process.stdout.write("not-json\\n");
          process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          process.stdout.write(JSON.stringify({ id: request.id, type: "response", success: true }) + "\\n");
        }); setInterval(() => {}, 1000);`,
      ],
      process.cwd(),
      (event) => events.push(event),
    );

    try {
      await expect(rpc.command({ type: "get_state" })).resolves.toMatchObject({ success: true });
      expect(events).toEqual([{ type: "agent_start" }]);
    } finally {
      rpc.stop();
    }
  });
});
