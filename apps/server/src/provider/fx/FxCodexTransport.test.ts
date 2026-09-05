// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFxCodexAuth, type FxCodexFetch } from "./FxCodexAuth.ts";
import { makeFxCodexTransport } from "./FxCodexTransport.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-transport-"));
  homes.push(home);
  await NodeFSP.mkdir(NodePath.join(home, ".codex"));
  const write = (token: string, account = "account-a") =>
    NodeFSP.writeFile(
      NodePath.join(home, ".codex/auth.json"),
      JSON.stringify({
        tokens: { access_token: token, refresh_token: `refresh-${token}`, account_id: account },
      }),
    );
  await write("initial");
  const refresh = vi.fn<FxCodexFetch>(async () =>
    Response.json({ access_token: "refreshed", refresh_token: "rotated" }),
  );
  const auth = makeFxCodexAuth({ homeDirectory: home, fetch: refresh });
  const make = (fetch: FxCodexFetch) =>
    makeFxCodexTransport({ accountId: "account-a", auth, fetch });
  return { write, refresh, auth, make };
}

describe("fx Codex transport", () => {
  it("streams successful responses without buffering or rewriting the cached prefix", async () => {
    const f = await fixture();
    const response = new Response("data: streaming\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const fetch = vi.fn<FxCodexFetch>(async () => response);
    const body = '{"prompt_cache_key":"stable-thread","instructions":"unchanged","input":[]}';
    const result = await f.make(fetch).responses({
      body,
      headers: {
        "session-id": "stable-thread",
        authorization: "Bearer untrusted",
        cookie: "secret",
        "chatgpt-account-id": "wrong",
      },
    });
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.body).toBe(body);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer initial");
    expect(headers.get("chatgpt-account-id")).toBe("account-a");
    expect(headers.get("session-id")).toBe("stable-thread");
    expect(headers.has("cookie")).toBe(false);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("refreshes once after a 401 and replays identical request bytes and cache headers", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(
      async (_url, init) =>
        new Response("", {
          status: new Headers(init.headers).get("authorization") === "Bearer initial" ? 401 : 200,
        }),
    );
    const body = '{"prompt_cache_key":"key","input":[{"role":"user","content":"hello"}]}';
    expect((await f.make(fetch).responses({ body, headers: { "session-id": "key" } })).status).toBe(
      200,
    );
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init.body)).toEqual([body, body]);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("session-id"))).toEqual(
      ["key", "key"],
    );
  });

  it("reloads an external rotation before making any OAuth request", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(async (_url, init) => {
      if (new Headers(init.headers).get("authorization") === "Bearer initial") {
        await f.write("external");
        return new Response("", { status: 401 });
      }
      return new Response("ok");
    });
    expect((await f.make(fetch).responses({ body: "{}" })).status).toBe(200);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds recovery to reload then refresh even when all requests fail", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(async () => {
      if (fetch.mock.calls.length === 1) await f.write("external");
      return new Response("unauthorized", { status: 401 });
    });
    const response = await f.make(fetch).responses({ body: "{}" });
    expect(response.status).toBe(401);
    expect(response.bodyUsed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("shares refresh work between concurrent requests", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(
      async (_url, init) =>
        new Response("", {
          status: new Headers(init.headers).get("authorization") === "Bearer initial" ? 401 : 200,
        }),
    );
    const transport = f.make(fetch);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => transport.responses({ body: "{}" })),
    );
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects account changes instead of sending the old conversation to another account", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(async () => {
      await f.write("other-account", "account-b");
      return new Response("", { status: 401 });
    });
    await expect(f.make(fetch).responses({ body: "{}" })).rejects.toMatchObject({
      code: "account_changed",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500, 503])("does not replay HTTP %s failures", async (status) => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(async () => new Response("", { status }));
    expect((await f.make(fetch).responses({ body: "{}" })).status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not replay transport errors or expose their diagnostic credentials", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(async () => {
      throw new Error("Bearer initial");
    });
    await expect(f.make(fetch).responses({ body: "{}" })).rejects.not.toThrow("Bearer initial");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before requests and between recovery steps", async () => {
    const f = await fixture();
    const before = new AbortController();
    before.abort(new Error("cancelled"));
    const unused = vi.fn<FxCodexFetch>();
    await expect(f.make(unused).responses({ body: "{}", signal: before.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(unused).not.toHaveBeenCalled();
    const between = new AbortController();
    const fetch = vi.fn<FxCodexFetch>(async () => {
      between.abort(new Error("cancelled"));
      return new Response("", { status: 401 });
    });
    await expect(f.make(fetch).responses({ body: "{}", signal: between.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("uses the same account-bound auth for model discovery and escapes version parameters", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>(async () => Response.json({ models: [] }));
    await f.make(fetch).models({ clientVersion: "1.2.3&next=https://elsewhere" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url).origin).toBe("https://chatgpt.com");
    expect(new URL(url).searchParams.get("next")).toBeNull();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer initial");
  });
});
