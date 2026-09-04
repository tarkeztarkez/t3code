import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFxCodexAuth, type FxCodexFetch, type FxCodexCredential } from "./FxCodexAuth.ts";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true, force: true })),
  );
});

function jwt(exp: number, nonce = "old", account = "account-a") {
  const claims = {
    exp: exp / 1000,
    nonce,
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function headers(credential: FxCodexCredential) {
  const result = new Headers();
  credential.authorize(result);
  return result;
}

async function fixture(exp = NOW + 60 * 60_000) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-auth-"));
  homes.push(home);
  const directory = NodePath.join(home, ".codex");
  await NodeFSP.mkdir(directory);
  const path = NodePath.join(directory, "auth.json");
  const original = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    last_refresh: new Date(NOW).toISOString(),
    extension: { preserved: true },
    tokens: {
      access_token: jwt(exp),
      refresh_token: "refresh-old",
      id_token: jwt(exp),
      account_id: "account-a",
      extra: "keep",
    },
  };
  const write = (value: unknown) =>
    NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await write(original);
  const read = async () => JSON.parse(await NodeFSP.readFile(path, "utf8")) as typeof original;
  const make = (fetch: FxCodexFetch) =>
    makeFxCodexAuth({ homeDirectory: home, fetch, now: () => NOW });
  return { home, directory, path, original, write, read, make };
}

describe("fx Codex auth", () => {
  it("shares temporary failures rather than issuing one refresh per waiting conversation", async () => {
    const f = await fixture(NOW - 1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetch = vi.fn<FxCodexFetch>(async () => {
      entered.resolve();
      await release.promise;
      return new Response("unavailable", { status: 503 });
    });
    const auth = f.make(fetch);
    const requests = Array.from({ length: 8 }, () => auth.credentials("account-a"));
    const settled = Promise.allSettled(requests);
    await entered.promise;
    release.resolve();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(auth.credentials("account-a")).rejects.toMatchObject({ code: "refresh_failed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves a linked Codex auth file when persisting a refresh", async () => {
    const f = await fixture(NOW - 1);
    const target = NodePath.join(f.home, "linked-auth.json");
    await NodeFSP.rename(f.path, target);
    await NodeFSP.symlink(target, f.path);
    const auth = f.make(async () =>
      Response.json({ access_token: jwt(NOW + 3600_000, "new"), refresh_token: "rotated" }),
    );
    await auth.credentials();
    expect((await NodeFSP.lstat(f.path)).isSymbolicLink()).toBe(true);
    expect(await NodeFSP.readFile(target, "utf8")).toContain("rotated");
  });
  it("reads existing credentials without refreshing, creating fx files, or serializing secrets", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>();
    const credentials = await f.make(fetch).credentials();
    expect(headers(credentials).get("authorization")).toBe(
      `Bearer ${f.original.tokens.access_token}`,
    );
    expect(headers(credentials).get("chatgpt-account-id")).toBe("account-a");
    expect(JSON.stringify(credentials)).not.toContain(f.original.tokens.access_token);
    expect(JSON.stringify(credentials)).not.toContain("refresh-old");
    expect(fetch).not.toHaveBeenCalled();
    expect(await NodeFSP.readdir(f.home)).toEqual([".codex"]);
    expect(await f.read()).toEqual(f.original);
  });

  it("refreshes within Codex's five-minute window and preserves file metadata", async () => {
    const f = await fixture(NOW + 4 * 60_000);
    const access = jwt(NOW + 60 * 60_000, "new");
    const id = jwt(NOW + 60 * 60_000, "new-id");
    const fetch = vi.fn<FxCodexFetch>(async () =>
      Response.json({ access_token: access, refresh_token: "refresh-new", id_token: id }),
    );
    const auth = f.make(fetch);
    expect(headers(await auth.credentials("account-a")).get("authorization")).toBe(
      `Bearer ${access}`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
    });
    const saved = await f.read();
    expect(saved).toEqual({
      ...f.original,
      tokens: {
        ...f.original.tokens,
        access_token: access,
        refresh_token: "refresh-new",
        id_token: id,
      },
    });
    expect(await NodeFSP.readdir(f.directory)).toEqual(["auth.json"]);
    expect(headers(await auth.credentials()).get("authorization")).toBe(`Bearer ${access}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to eight days when an access token has no expiry", async () => {
    const f = await fixture();
    await f.write({
      ...f.original,
      last_refresh: new Date(NOW - 9 * 86400_000).toISOString(),
      tokens: { ...f.original.tokens, access_token: "opaque-token" },
    });
    const fetch = vi.fn<FxCodexFetch>(async () =>
      Response.json({ access_token: jwt(NOW + 3600_000, "new") }),
    );
    await f.make(fetch).credentials();
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = await f.read();
    expect(saved.last_refresh).toBe(new Date(NOW).toISOString());
    expect(saved.tokens.refresh_token).toBe("refresh-old");
    expect(saved.tokens.id_token).toBe(f.original.tokens.id_token);
  });

  it("serializes concurrent refreshes across conversations", async () => {
    const f = await fixture(NOW - 1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetch = vi.fn<FxCodexFetch>(async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ access_token: jwt(NOW + 3600_000, "new"), refresh_token: "rotated" });
    });
    const auth = f.make(fetch);
    const requests = Array.from({ length: 8 }, () => auth.credentials("account-a"));
    await entered.promise;
    release.resolve();
    const results = await Promise.all(requests);
    await auth.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((value) => value.fingerprint)).size).toBe(1);
  });

  it("reloads an external rotation before refreshing a rejected credential", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>();
    const auth = f.make(fetch);
    const rejected = await auth.credentials();
    const external = {
      ...f.original,
      tokens: {
        ...f.original.tokens,
        access_token: jwt(NOW + 3600_000, "external"),
        refresh_token: "external-refresh",
      },
    };
    await f.write(external);
    const recovered = await auth.recover(rejected);
    expect(recovered.fingerprint).not.toBe(rejected.fingerprint);
    expect(headers(recovered).get("authorization")).toBe(`Bearer ${external.tokens.access_token}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not overwrite an external rotation during its own refresh", async () => {
    const f = await fixture(NOW - 1);
    const external = {
      ...f.original,
      tokens: {
        ...f.original.tokens,
        access_token: jwt(NOW + 3600_000, "external"),
        refresh_token: "external-refresh",
      },
    };
    const fetch: FxCodexFetch = async () => {
      await f.write(external);
      return Response.json({ access_token: jwt(NOW + 3600_000, "ours"), refresh_token: "ours" });
    };
    expect(headers(await f.make(fetch).credentials()).get("authorization")).toBe(
      `Bearer ${external.tokens.access_token}`,
    );
    expect(await f.read()).toEqual(external);
  });

  it("rebases unrelated file edits made during refresh", async () => {
    const f = await fixture(NOW - 1);
    const fetch: FxCodexFetch = async () => {
      await f.write({ ...f.original, extension: { preserved: true, added: "external" } });
      return Response.json({ access_token: jwt(NOW + 3600_000, "ours") });
    };
    await f.make(fetch).credentials();
    expect((await f.read()).extension).toEqual({ preserved: true, added: "external" });
  });

  it("recovers an external rotation even if its refresh reports a reused token", async () => {
    const f = await fixture(NOW - 1);
    const externalToken = jwt(NOW + 3600_000, "external");
    const fetch: FxCodexFetch = async () => {
      await f.write({
        ...f.original,
        tokens: {
          ...f.original.tokens,
          access_token: externalToken,
          refresh_token: "external-refresh",
        },
      });
      return Response.json({ error: { code: "refresh_token_reused" } }, { status: 400 });
    };
    expect(headers(await f.make(fetch).credentials()).get("authorization")).toBe(
      `Bearer ${externalToken}`,
    );
  });

  it("does not silently switch accounts or restore credentials after logout", async () => {
    const f = await fixture(NOW - 1);
    const other = {
      ...f.original,
      tokens: {
        ...f.original.tokens,
        account_id: "account-b",
        access_token: jwt(NOW + 3600_000, "b", "account-b"),
        id_token: jwt(NOW + 3600_000, "b", "account-b"),
      },
    };
    const auth = f.make(async () => {
      await f.write(other);
      return Response.json({ access_token: jwt(NOW + 3600_000, "ours") });
    });
    await expect(auth.credentials("account-a")).rejects.toMatchObject({ code: "account_changed" });
    expect(await f.read()).toEqual(other);
    await f.write(f.original);
    const logout = f.make(async () => {
      await NodeFSP.unlink(f.path);
      return Response.json({ access_token: jwt(NOW + 3600_000, "ours") });
    });
    await expect(logout.credentials()).rejects.toMatchObject({ code: "missing" });
    expect(await NodeFSP.readdir(f.directory)).toEqual([]);
  });

  it("caches permanent failures only for the rejected token snapshot", async () => {
    const f = await fixture(NOW - 1);
    const fetch = vi.fn<FxCodexFetch>(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "refresh-old should not be logged" },
        { status: 400 },
      ),
    );
    const auth = f.make(fetch);
    await expect(auth.credentials()).rejects.toMatchObject({
      code: "login_required",
      retryable: false,
    });
    await expect(auth.credentials()).rejects.toMatchObject({ code: "login_required" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await f.read()).toEqual(f.original);
    await f.write({
      ...f.original,
      tokens: {
        ...f.original.tokens,
        access_token: jwt(NOW + 3600_000, "login"),
        refresh_token: "new-login",
      },
    });
    await expect(auth.credentials()).resolves.toMatchObject({ accountId: "account-a" });
  });

  it.each([429, 500, 503])(
    "does not cache temporary HTTP %s failures or leak the response body",
    async (status) => {
      const f = await fixture(NOW - 1);
      const fetch = vi.fn<FxCodexFetch>(
        async () => new Response("refresh-old private response", { status }),
      );
      const auth = f.make(fetch);
      await expect(auth.credentials()).rejects.toMatchObject({
        code: "refresh_failed",
        retryable: true,
      });
      await expect(auth.credentials()).rejects.not.toThrow("refresh-old");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await f.read()).toEqual(f.original);
    },
  );

  it("rejects malformed refresh responses and account-changing token claims without writing", async () => {
    const f = await fixture(NOW - 1);
    for (const response of [
      {},
      { access_token: "bad\nheader" },
      { access_token: jwt(NOW + 3600_000, "bad", "account-b") },
    ]) {
      await expect(f.make(async () => Response.json(response)).credentials()).rejects.toThrow();
      expect(await f.read()).toEqual(f.original);
    }
  });

  it("rejects missing, malformed, oversized, and non-subscription credentials", async () => {
    const f = await fixture();
    const fetch = vi.fn<FxCodexFetch>();
    const auth = f.make(fetch);
    await f.write({ OPENAI_API_KEY: "private-key" });
    await expect(auth.credentials()).rejects.toMatchObject({ code: "unsupported" });
    await f.write({ tokens: {} });
    await expect(auth.credentials()).rejects.toMatchObject({ code: "invalid" });
    await NodeFSP.writeFile(f.path, "x".repeat(65537));
    await expect(auth.credentials()).rejects.toMatchObject({ code: "invalid" });
    await NodeFSP.unlink(f.path);
    await expect(auth.credentials()).rejects.toMatchObject({ code: "missing" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
