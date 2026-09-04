// Shared protocol for the two disposable execution workers. Only trusted fixtures
// may run here until the production host has an OS-level sandbox.
export function createWorker(send, finish) {
  let sequence = 0;
  let started = false;
  const pending = new Map();
  const tools = new Proxy(Object.create(null), {
    get(_target, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      return (input) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          send({ type: "call", id, name, input });
        });
    },
  });
  return (message) => {
    if (message.type === "result") {
      const call = pending.get(message.id);
      if (!call) throw new Error("Unknown tool response");
      pending.delete(message.id);
      if (message.error !== undefined) call.reject(new Error(message.error));
      else call.resolve(message.value);
      return;
    }
    if (message.type !== "execute" || started) throw new Error("Expected one execution");
    started = true;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    Promise.resolve()
      .then(() =>
        new AsyncFunction("tools", "text", message.code)(tools, (value) =>
          send({ type: "output", value }),
        ),
      )
      .then(
        () => finish({ type: "done" }),
        (error) => finish({ type: "failed", error: String(error) }),
      );
  };
}
