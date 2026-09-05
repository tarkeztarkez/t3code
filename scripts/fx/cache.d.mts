export function createPromptSnapshot<T>(options: {
  accountId: string;
  threadId: string;
  instructions: string;
  tools: readonly T[];
}): {
  version: number;
  promptCacheKey: string;
  instructions: string;
  tools: T[];
  prefixHash: string;
};
