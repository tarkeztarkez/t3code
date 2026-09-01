import { describe, expect, it } from "vitest";

import { parsePiModels } from "./PiProvider";

describe("parsePiModels", () => {
  it("parses Pi's model table", () => {
    const models = parsePiModels(
      "provider model context max-out thinking images\nanthropic claude-sonnet-4-6 1M 128K yes yes\n",
    );

    expect(models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });
});
