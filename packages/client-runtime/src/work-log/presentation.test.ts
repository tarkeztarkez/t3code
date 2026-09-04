import { describe, expect, it } from "vitest";
import { runningToolFallbackLabel } from "./presentation.js";

describe("runningToolFallbackLabel", () => {
  it("hides partial tool output until the call finishes", () => {
    expect(
      runningToolFallbackLabel({
        label: "Script completedNotebook memory: heap 88 MiB",
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolLifecycleStatus: "inProgress",
      }),
    ).toBe("Running tool");
  });

  it("does not replace completed tool labels", () => {
    expect(
      runningToolFallbackLabel({
        label: "Fetched site data",
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolLifecycleStatus: "completed",
      }),
    ).toBeNull();
  });
});
