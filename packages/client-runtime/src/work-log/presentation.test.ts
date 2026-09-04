import { describe, expect, it } from "vitest";
import {
  generatedPiToolLabel,
  previousGeneratedPiToolLabel,
  toolLifecycleFallbackLabel,
} from "./presentation.js";

const toolEntry = (toolTitle: string, label: string) => ({
  label,
  toolTitle,
  tone: "tool" as const,
  itemType: "dynamic_tool_call" as const,
});

describe("generated Pi tool labels", () => {
  it("recognizes generated exec and notebook labels", () => {
    expect(generatedPiToolLabel(toolEntry("exec", "Inspected repository files"))).toBe(
      "Inspected repository files",
    );
    expect(generatedPiToolLabel(toolEntry("notebook", "Checked notebook state"))).toBe(
      "Checked notebook state",
    );
    expect(generatedPiToolLabel(toolEntry("exec", "exec started"))).toBeNull();
  });

  it("finds a previous generated label without treating the current entry as previous", () => {
    expect(
      previousGeneratedPiToolLabel([
        toolEntry("exec", "Inspected repository files"),
        toolEntry("wait", "wait"),
      ]),
    ).toBe("Inspected repository files");
    expect(previousGeneratedPiToolLabel([toolEntry("exec", "exec")])).toBeNull();
  });
});

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

  it("labels yielded wait calls as waiting for the command", () => {
    expect(
      toolLifecycleFallbackLabel({
        label: "wait",
        toolTitle: "wait",
        detail: 'Still running (exec cell "notebook-159").',
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolLifecycleStatus: "completed",
      }),
    ).toBe("Waiting for command");
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
