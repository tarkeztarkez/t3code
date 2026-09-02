export const PI_CODEX_CONVERSION_DEFAULT_CONFIG = `${JSON.stringify(
  {
    voiceFeaturesOnly: false,
    prompt: { heavySystemPromptOverwrite: true },
    openai: {
      forceCachedWebSockets: true,
      cacheKeepalive: true,
    },
    executionMode: "notebook",
  },
  null,
  2,
)}\n`;
