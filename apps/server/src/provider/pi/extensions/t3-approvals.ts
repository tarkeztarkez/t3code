import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function t3codeApprovals(pi: ExtensionAPI) {
  const mode = process.env.T3CODE_PI_RUNTIME_MODE ?? "approval-required";
  const alwaysAllowed = new Set();

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "full-access") return;
    const tool = event.toolName;
    const isEditTool =
      tool === "edit" || tool === "write" || tool === "multiedit" || tool === "patch";
    const gated = tool === "bash" || (isEditTool && mode !== "auto-accept-edits");
    if (!gated || alwaysAllowed.has(tool)) return;

    const input = (event.input ?? {}) as Record<string, unknown>;
    const detail =
      tool === "bash" ? String(input.command ?? "") : String(input.path ?? input.file_path ?? "");
    const choice = await ctx.ui.select(
      "T3_APPROVAL " + JSON.stringify({ version: 1, tool, detail }),
      ["allow", "allow-always", "deny"],
    );

    if (choice === "allow-always") {
      alwaysAllowed.add(tool);
      return;
    }
    if (choice === "allow") return;
    return {
      block: true,
      reason:
        choice === "deny" ? "The user denied this action." : "The approval request was cancelled.",
    };
  });
}
