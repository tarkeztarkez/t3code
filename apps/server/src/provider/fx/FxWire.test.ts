import { expect, test } from "vitest";
import { prepareFxRequest } from "./FxWire.ts";

test("Astra uses the conversion namespace format without moving reasoning or cache identity", async () => {
  const request = {
    model: "gpt-6-astra",
    prompt_cache_key: "account-thread",
    instructions: "Stable policy",
    tools: [
      {
        type: "function",
        name: "wait",
        strict: true,
        parameters: {
          type: "object",
          properties: { cell_id: { type: "string" }, terminate: { type: "boolean" } },
          required: ["cell_id"],
        },
      },
    ],
    input: [
      { type: "reasoning", encrypted_content: "opaque" },
      { role: "user", content: [{ type: "input_text", text: "task" }] },
    ],
    reasoning: { effort: "high" },
  };
  const first = await prepareFxRequest(JSON.stringify(request));
  const second = await prepareFxRequest(
    JSON.stringify({ ...request, reasoning: { effort: "low" } }),
  );
  const body = JSON.parse(first.body);
  expect(first.lite).toBe(true);
  expect(body.input.slice(0, 2)).toEqual(JSON.parse(second.body).input.slice(0, 2));
  expect(body.input[0]).toMatchObject({
    type: "additional_tools",
    role: "developer",
    tools: [
      {
        type: "namespace",
        name: "functions",
        tools: [{ name: "wait", strict: false, parameters: { required: ["cell_id"] } }],
      },
    ],
  });
  expect(body.input[2]).toEqual(request.input[0]);
  expect(body.prompt_cache_key).toBe("account-thread");
  expect(body.reasoning).toEqual({ effort: "high", context: "all_turns" });
  expect(body).not.toHaveProperty("instructions");
});

test("standard Codex models retain the normal Responses layout", async () => {
  const body = {
    model: "gpt-5.4",
    instructions: "policy",
    input: [{ role: "user", content: "hello" }],
    tools: [],
  };
  const prepared = await prepareFxRequest(JSON.stringify(body));
  expect(prepared.lite).toBe(false);
  expect(JSON.parse(prepared.body)).toEqual(body);
});
