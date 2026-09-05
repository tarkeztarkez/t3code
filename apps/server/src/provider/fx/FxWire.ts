import {
  namespaceResponsesLiteTools,
  namespaceResponsesLiteInputTools,
} from "@howaboua/pi-codex-conversion/dist/providers/openai-codex/responses-lite-tools.js";
import { supportsResponsesLiteModel } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex/responses-lite-model.js";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Convert once before authorization/retries. The original reasoning items and
// account/thread cache key survive model and effort changes unchanged.
export async function prepareFxRequest(body: string, image?: (id: string) => Promise<unknown>) {
  const value: unknown = JSON.parse(body);
  if (!object(value) || typeof value.model !== "string" || !Array.isArray(value.input))
    throw new Error("Invalid fx Responses request");
  const input = await Promise.all(
    value.input.map(async (item) => {
      if (
        !image ||
        !object(item) ||
        item.type !== "function_call_output" ||
        typeof item.output !== "string"
      )
        return item;
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.output);
      } catch {
        return item;
      }
      if (!object(parsed) || !Array.isArray(parsed.t3_fx_images) || typeof parsed.text !== "string")
        return item;
      if (parsed.t3_fx_images.length > 8) throw new Error("Too many fx images");
      return {
        ...item,
        output: [
          { type: "input_text", text: parsed.text },
          ...(await Promise.all(
            parsed.t3_fx_images.map((id) => {
              if (typeof id !== "string") throw new Error("Invalid fx image");
              return image(id);
            }),
          )),
        ],
      };
    }),
  );
  const tools = Array.isArray(value.tools)
    ? value.tools.map((tool) =>
        object(tool) && tool.type === "function" ? { ...tool, strict: false } : tool,
      )
    : [];
  if (!supportsResponsesLiteModel(value.model))
    return { body: JSON.stringify({ ...value, input, tools }), lite: false };
  const { instructions, tools: _tools, ...rest } = value;
  const stripDetail = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripDetail);
    if (!object(value)) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => value.type !== "input_image" || key !== "detail")
        .map(([key, child]) => [key, stripDetail(child)]),
    );
  };
  return {
    lite: true,
    body: JSON.stringify({
      ...rest,
      input: [
        { type: "additional_tools", role: "developer", tools: namespaceResponsesLiteTools(tools) },
        ...(typeof instructions === "string" && instructions
          ? [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: instructions }],
              },
            ]
          : []),
        ...namespaceResponsesLiteInputTools(input.map(stripDetail)),
      ],
      parallel_tool_calls: false,
      reasoning: { ...(object(value.reasoning) ? value.reasoning : {}), context: "all_turns" },
    }),
  };
}
