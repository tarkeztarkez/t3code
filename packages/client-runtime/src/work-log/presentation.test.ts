import { describe, expect, it } from "vitest";
import { toolLifecycleFallbackLabel } from "./presentation.js";

describe("toolLifecycleFallbackLabel", () => {
  it("hides partial tool output until the call finishes", () => {
    expect(
      toolLifecycleFallbackLabel({
        label: "Script completedNotebook memory: heap 88 MiB",
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolLifecycleStatus: "inProgress",
      }),
    ).toBe("Running tool");
  });

  it("keeps yielded commands marked as running", () => {
    expect(
      toolLifecycleFallbackLabel({
        label: "wait",
        detail: 'Still running (exec cell "notebook-159").',
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolLifecycleStatus: "completed",
      }),
    ).toBe("Running tool");
  });

  it("does not replace completed tool labels", () => {
    expect(
      toolLifecycleFallbackLabel({
        label: "Fetched site data",
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolLifecycleStatus: "completed",
      }),
    ).toBeNull();
  });
});
