import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function t3OpenAICodexModels(pi: ExtensionAPI) {
  pi.registerProvider("openai-codex", {
    models: [
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoning: true,
        thinkingLevelMap: {
          off: "low",
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text", "image"],
        cost: {
          input: 10,
          output: 50,
          cacheRead: 1,
          cacheWrite: 12.5,
          tiers: [
            {
              inputTokensAbove: 272_000,
              input: 20,
              output: 75,
              cacheRead: 2,
              cacheWrite: 25,
            },
          ],
        },
        contextWindow: 272_000,
        maxTokens: 128_000,
        compat: {
          supportsOpenAIGrammarTools: true,
          supportsAdditionalTools: true,
          supportsToolSearch: true,
        },
      },
    ],
  });
}
