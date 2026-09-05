import { parseCodexReserveStatus } from "@howaboua/pi-codex-conversion/dist/codex-usage/reserve-policy.js";
import type { FxCodexAuth, FxCodexFetch } from "./FxCodexAuth.ts";
import { makeFxCodexTransport } from "./FxCodexTransport.ts";

// A quota bucket alone never authorizes Reserve. Use the same identity-bound
// backend banner as conversion 3.0.26. Never redeem credits or retry a turn.
export async function fxReserveStatus(
  auth: FxCodexAuth,
  fetch: FxCodexFetch,
  accountId: string,
  model: string,
) {
  const credential = await auth.credentials(accountId);
  const identity = credential.reserveIdentity();
  if (!identity) return undefined;
  const response = await makeFxCodexTransport({ auth, accountId, fetch }).usage(
    AbortSignal.timeout(10000),
  );
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) throw new Error("Codex usage response exceeds limit");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const current = (await auth.reload(accountId)).reserveIdentity();
  if (current?.userId !== identity.userId) return undefined;
  return parseCodexReserveStatus(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
    identity,
    model,
  );
}
