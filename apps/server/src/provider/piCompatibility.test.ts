import { describe, expect, it } from "vitest";

import { PI_COMPAT_EXTENSION } from "./piClaudeCompatibility";

describe("Pi Claude compatibility extension", () => {
  it("loads Claude context files and skill directories", () => {
    expect(PI_COMPAT_EXTENSION).toContain('ancestorPaths(ctx.cwd, ["CLAUDE.md"])');
    expect(PI_COMPAT_EXTENSION).toContain('ancestorPaths(ctx.cwd, [".claude", "skills"])');
    expect(PI_COMPAT_EXTENSION).toContain('join(homedir(), ".claude", "skills")');
    expect(PI_COMPAT_EXTENSION).toContain('join(homedir(), ".claude", "CLAUDE.md")');
    expect(PI_COMPAT_EXTENSION).toContain("backend-api/wham/usage");
    expect(PI_COMPAT_EXTENSION).toContain("x-codex-${name}-used-percent");
    expect(PI_COMPAT_EXTENSION).toContain("setStatus(USAGE_STATUS_KEY");
  });
});
