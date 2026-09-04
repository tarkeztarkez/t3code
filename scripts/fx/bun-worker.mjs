import * as NodeReadline from "node:readline";
import { createWorker } from "./worker-core.mjs";

const lines = NodeReadline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const accept = createWorker(send, (value) => {
  send(value);
  lines.close();
  process.stdin.destroy();
});
lines.on("line", (line) => accept(JSON.parse(line)));
send({ type: "ready" });
