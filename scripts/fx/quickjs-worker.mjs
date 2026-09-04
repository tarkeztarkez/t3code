import * as std from "qjs:std";
import * as os from "qjs:os";
import { createWorker } from "./worker-core.mjs";

const send = (value) => {
  std.out.puts(`${JSON.stringify(value)}\n`);
  std.out.flush();
};
const accept = createWorker(send, (value) => {
  send(value);
  os.setReadHandler(0, null);
});
let buffered = "";
const bytes = new Uint8Array(8192);
os.setReadHandler(0, () => {
  const count = os.read(0, bytes.buffer, 0, bytes.length);
  if (count <= 0) {
    os.setReadHandler(0, null);
    return;
  }
  // The parent escapes non-ASCII characters, including surrogate pairs.
  for (let i = 0; i < count; i++) buffered += String.fromCharCode(bytes[i]);
  if (buffered.length > 1024 * 1024) throw new Error("Worker input exceeds 1 MiB");
  let end;
  while ((end = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    accept(JSON.parse(line));
  }
});
send({ type: "ready" });
