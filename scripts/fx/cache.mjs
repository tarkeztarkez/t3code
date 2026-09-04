import * as NodeCrypto from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");

// Persist this snapshot with the conversation. A context refresh creates a new
// prefix deliberately, rather than silently changing it on every model call.
export function createPromptSnapshot({ accountId, threadId, instructions, tools }) {
  if (!accountId || !threadId) throw new Error("Cache identity requires account and thread IDs");
  const names = new Set();
  for (const tool of tools) {
    if (!tool.name || names.has(tool.name)) throw new Error("Tool names must be unique");
    names.add(tool.name);
  }
  const stableTools = canonical(
    [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
  return {
    version: 1,
    // 64 ASCII characters. Never key by turn ID, request ID, or bearer token.
    promptCacheKey: hash(JSON.stringify(["t3-fx-v1", accountId, threadId])),
    instructions,
    tools: stableTools,
    prefixHash: hash(JSON.stringify([instructions, stableTools])),
  };
}

export function cacheUsage(usage) {
  const inputTokens = usage?.input_tokens;
  const cachedInputTokens = usage?.input_tokens_details?.cached_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(cachedInputTokens) ||
    cachedInputTokens < 0 ||
    cachedInputTokens > inputTokens
  )
    return null;
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cachedFraction: inputTokens === 0 ? 0 : cachedInputTokens / inputTokens,
  };
}
