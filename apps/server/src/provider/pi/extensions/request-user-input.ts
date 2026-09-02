import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function requestUserInput(pi: ExtensionAPI) {
  const parameters = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            header: { type: "string" },
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  } as const;

  pi.registerTool({
    name: "request_user_input",
    label: "request_user_input",
    description:
      "Request user input for one or more short questions and wait for the response. Questions are shown one at a time.",
    promptSnippet: "Ask the user structured clarification questions",
    parameters: parameters as never,

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as {
        questions: Array<{
          id: string;
          header: string;
          question: string;
          options: Array<{ label: string; description: string }>;
        }>;
      };
      if (
        params.questions.length === 0 ||
        params.questions.some(
          (question) =>
            !question.id.trim() ||
            !question.header.trim() ||
            !question.question.trim() ||
            question.options.length === 0 ||
            question.options.some((option) => !option.label.trim() || !option.description.trim()) ||
            new Set(question.options.map((option) => option.label)).size !==
              question.options.length,
        ) ||
        new Set(params.questions.map((question) => question.id)).size !== params.questions.length
      ) {
        return {
          content: [{ type: "text", text: "request_user_input received invalid questions" }],
          details: undefined,
          isError: true,
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "request_user_input requires interactive mode" }],
          details: undefined,
          isError: true,
        };
      }

      const answers: Record<string, { answers: string[] }> = {};
      for (const question of params.questions) {
        const answer = await ctx.ui.select(
          "T3_USER_INPUT " + JSON.stringify({ version: 1, ...question }),
          question.options.map((option) => option.label),
        );
        if (answer === undefined) {
          return {
            content: [{ type: "text", text: "request_user_input was cancelled" }],
            details: undefined,
            isError: true,
          };
        }
        answers[question.id] = { answers: [answer] };
      }

      const response = { answers };
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
        details: response,
      };
    },
  });
}
