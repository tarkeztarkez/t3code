// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
// @effect-diagnostics globalDate:off - Native protocol timestamps use wall time outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_AUTH_BYTES = 64 * 1024;
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const messages = {
  missing: "Codex credentials are missing. Sign in with the Codex CLI.",
  invalid: "The Codex auth file is invalid.",
  unsupported: "fx requires a ChatGPT subscription login in the Codex auth file.",
  account_changed: "The Codex account changed. Reconnect this conversation explicitly.",
  storage: "Could not read or persist Codex credentials.",
  conflict: "Codex credentials changed during refresh. Retry the request.",
  refresh_failed: "Codex token refresh failed temporarily. Retry the request.",
  login_required: "The Codex refresh token is no longer usable. Sign in with the Codex CLI.",
  invalid_response: "Codex token refresh returned an invalid response.",
} as const;

export class FxCodexAuthError extends Error {
  readonly code: keyof typeof messages;
  readonly retryable: boolean;

  constructor(code: keyof typeof messages) {
    super(messages[code]);
    this.name = "FxCodexAuthError";
    this.code = code;
    this.retryable = code === "refresh_failed" || code === "conflict" || code === "storage";
  }
}

export type FxCodexFetch = (url: string, init: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/\s/u.test(value) &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    return payload
      ? record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
      : undefined;
  } catch {
    return undefined;
  }
}

function checkTokenAccount(token: string, expected: string): void {
  const claim = record(jwtClaims(token)?.["https://api.openai.com/auth"])?.chatgpt_account_id;
  if (claim !== undefined && claim !== expected) throw new FxCodexAuthError("account_changed");
}

function parseAuth(raw: string, expectedAccountId?: string) {
  let json: Record<string, unknown> | undefined;
  try {
    json = record(JSON.parse(raw));
  } catch {
    throw new FxCodexAuthError("invalid");
  }
  if (!json) throw new FxCodexAuthError("invalid");
  if (
    (json.auth_mode !== undefined && json.auth_mode !== null && json.auth_mode !== "chatgpt") ||
    (typeof json.OPENAI_API_KEY === "string" && json.OPENAI_API_KEY.length > 0)
  ) {
    throw new FxCodexAuthError("unsupported");
  }
  const tokens = record(json.tokens);
  if (
    !tokens ||
    !nonEmpty(tokens.access_token) ||
    !nonEmpty(tokens.refresh_token) ||
    !nonEmpty(tokens.account_id)
  ) {
    throw new FxCodexAuthError("invalid");
  }
  if (expectedAccountId !== undefined && tokens.account_id !== expectedAccountId) {
    throw new FxCodexAuthError("account_changed");
  }
  checkTokenAccount(tokens.access_token, tokens.account_id);
  if (typeof tokens.id_token === "string") checkTokenAccount(tokens.id_token, tokens.account_id);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        tokens.account_id,
        tokens.access_token,
        tokens.refresh_token,
        tokens.id_token,
      ]),
    )
    .digest("hex");
  return {
    raw,
    json,
    tokens,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id,
    fingerprint,
  };
}

type AuthSnapshot = ReturnType<typeof parseAuth> & { readonly realPath: string };

// Private fields keep bearer tokens out of JSON serialization and object logs.
// Only the server-side transport calls authorize. Never send this object to a client.
export class FxCodexCredential {
  readonly accountId: string;
  readonly fingerprint: string;
  readonly #accessToken: string;

  constructor(snapshot: Pick<AuthSnapshot, "accountId" | "fingerprint" | "accessToken">) {
    this.accountId = snapshot.accountId;
    this.fingerprint = snapshot.fingerprint;
    this.#accessToken = snapshot.accessToken;
  }

  authorize(headers: Headers): void {
    headers.set("authorization", `Bearer ${this.#accessToken}`);
    headers.set("chatgpt-account-id", this.accountId);
  }

  reserveIdentity(): { accountId: string; userId: string } | undefined {
    const claims = record(jwtClaims(this.#accessToken)?.["https://api.openai.com/auth"]);
    const userId = claims?.chatgpt_user_id ?? claims?.user_id;
    return claims?.chatgpt_account_is_fedramp !== true && nonEmpty(userId)
      ? { accountId: this.accountId, userId }
      : undefined;
  }
}

async function readAuth(path: string, expectedAccountId?: string): Promise<AuthSnapshot> {
  try {
    const realPath = await NodeFSP.realpath(path);
    const file = await NodeFSP.open(realPath, "r");
    try {
      if (!(await file.stat()).isFile()) throw new FxCodexAuthError("invalid");
      const bytes = Buffer.alloc(MAX_AUTH_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_AUTH_BYTES) throw new FxCodexAuthError("invalid");
      return { ...parseAuth(bytes.toString("utf8", 0, size), expectedAccountId), realPath };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof FxCodexAuthError) throw error;
    if (record(error)?.code === "ENOENT") throw new FxCodexAuthError("missing");
    throw new FxCodexAuthError("storage");
  }
}

// This detects observed external writes, not an atomic compare-and-swap with the
// Codex CLI. Its current file backend does not participate in an interprocess lock.
async function replaceAuth(path: string, expected: AuthSnapshot, json: Record<string, unknown>) {
  const temporary = NodePath.join(
    NodePath.dirname(expected.realPath),
    `.t3-fx-auth-${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    const contents = `${JSON.stringify(json, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_AUTH_BYTES)
      throw new FxCodexAuthError("invalid_response");
    const file = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const latest = await readAuth(path, expected.accountId);
    if (latest.raw !== expected.raw || latest.realPath !== expected.realPath) return false;
    await NodeFSP.rename(temporary, expected.realPath);
    return true;
  } catch (error) {
    if (error instanceof FxCodexAuthError) throw error;
    throw new FxCodexAuthError("storage");
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function refreshDue(snapshot: AuthSnapshot, now: number): boolean {
  const expires = jwtClaims(snapshot.accessToken)?.exp;
  if (typeof expires === "number" && Number.isFinite(expires) && expires > 0) {
    return expires * 1000 <= now + 5 * 60_000;
  }
  const lastRefresh =
    typeof snapshot.json.last_refresh === "string" ? Date.parse(snapshot.json.last_refresh) : NaN;
  return Number.isFinite(lastRefresh) && lastRefresh < now - 8 * 24 * 60 * 60_000;
}

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new FxCodexAuthError("invalid_response");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_AUTH_BYTES) throw new FxCodexAuthError("invalid_response");
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new FxCodexAuthError("invalid_response");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function requestRefresh(snapshot: AuthSnapshot, fetch: FxCodexFetch) {
  let response: Response;
  try {
    response = await fetch(REFRESH_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: snapshot.refreshToken,
      }),
    });
  } catch {
    throw new FxCodexAuthError("refresh_failed");
  }
  const body = await responseJson(response).catch(() => undefined);
  const object = record(body);
  if (!response.ok) {
    const rawCode = record(object?.error)?.code ?? object?.error ?? object?.code;
    const code = typeof rawCode === "string" ? rawCode.toLowerCase() : "";
    if (
      response.status === 401 ||
      [
        "invalid_grant",
        "refresh_token_expired",
        "refresh_token_reused",
        "refresh_token_invalidated",
      ].includes(code)
    ) {
      throw new FxCodexAuthError("login_required");
    }
    throw new FxCodexAuthError("refresh_failed");
  }
  if (!object || !nonEmpty(object.access_token)) throw new FxCodexAuthError("invalid_response");
  const updated: Record<string, unknown> = { access_token: object.access_token };
  checkTokenAccount(object.access_token, snapshot.accountId);
  for (const field of ["refresh_token", "id_token"] as const) {
    if (object[field] === undefined) continue;
    if (!nonEmpty(object[field])) throw new FxCodexAuthError("invalid_response");
    if (field === "id_token") {
      if (!jwtClaims(object[field])) throw new FxCodexAuthError("invalid_response");
      checkTokenAccount(object[field], snapshot.accountId);
    }
    updated[field] = object[field];
  }
  return updated;
}

// Own one manager per Codex home in the environment server, shared by all fx
// conversations. A cancelled turn must not abandon a rotating refresh token.
export function makeFxCodexAuth(options: {
  readonly homeDirectory: string;
  readonly fetch: FxCodexFetch;
  readonly now?: () => number;
}) {
  const path = NodePath.join(options.homeDirectory, ".codex", "auth.json");
  const now = options.now ?? Date.now;
  let tail = Promise.resolve();
  let permanentFailure: string | undefined;
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const inFlight = new Map<string, Promise<FxCodexCredential>>();
  const shared = (key: string, work: () => Promise<FxCodexCredential>) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const result = exclusive(work);
    inFlight.set(key, result);
    const release = () => {
      inFlight.delete(key);
    };
    void result.then(release, release);
    return result;
  };

  const refresh = async (snapshot: AuthSnapshot): Promise<FxCodexCredential> => {
    if (permanentFailure === snapshot.fingerprint) throw new FxCodexAuthError("login_required");
    let updated: Record<string, unknown>;
    try {
      updated = await requestRefresh(snapshot, options.fetch);
    } catch (error) {
      const latest = await readAuth(path, snapshot.accountId);
      if (latest.fingerprint !== snapshot.fingerprint) return new FxCodexCredential(latest);
      if (error instanceof FxCodexAuthError && error.code === "login_required")
        permanentFailure = snapshot.fingerprint;
      throw error;
    }
    // Rebase unrelated metadata edits without overwriting an external token rotation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await readAuth(path, snapshot.accountId);
      if (latest.fingerprint !== snapshot.fingerprint) return new FxCodexCredential(latest);
      const json = {
        ...latest.json,
        tokens: { ...latest.tokens, ...updated },
        last_refresh: new Date(now()).toISOString(),
      };
      const next = parseAuth(JSON.stringify(json), snapshot.accountId);
      if (await replaceAuth(path, latest, json)) return new FxCodexCredential(next);
    }
    throw new FxCodexAuthError("conflict");
  };

  return {
    credentials: (expectedAccountId?: string) =>
      shared(`credentials:${expectedAccountId ?? ""}`, async () => {
        const snapshot = await readAuth(path, expectedAccountId);
        if (permanentFailure === snapshot.fingerprint) throw new FxCodexAuthError("login_required");
        return refreshDue(snapshot, now()) ? refresh(snapshot) : new FxCodexCredential(snapshot);
      }),
    reload: (expectedAccountId: string) =>
      exclusive(async () => new FxCodexCredential(await readAuth(path, expectedAccountId))),
    recover: (rejected: FxCodexCredential) =>
      shared(`recover:${rejected.fingerprint}`, async () => {
        const snapshot = await readAuth(path, rejected.accountId);
        if (snapshot.fingerprint !== rejected.fingerprint) return new FxCodexCredential(snapshot);
        return refresh(snapshot);
      }),
    drain: () => tail,
  };
}

export type FxCodexAuth = ReturnType<typeof makeFxCodexAuth>;
