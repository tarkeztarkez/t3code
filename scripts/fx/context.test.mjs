import { afterEach, expect, test } from "bun:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { loadContext } from "./context.mjs";
import { cacheUsage, createPromptSnapshot } from "./cache.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-context-"));
  directories.push(root);
  const put = async (path, contents) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), contents);
  };
  return { root, put };
}

test("loads scoped instructions, Claude imports, and both skill directories deterministically", async () => {
  const { root, put } = await fixture();
  await put("home/.claude/CLAUDE.md", "Use bun.");
  await put("project/AGENTS.md", "Project instructions.");
  await put("project/CLAUDE.md", "@AGENTS.md\n@extra.md");
  await put("project/extra.md", "@CLAUDE.md\nImported instructions.");
  await put("project/sub/AGENTS.md", "Scoped instructions.");
  await put(
    "home/.agents/skills/zeta/SKILL.md",
    '---\nname: zeta\ndescription: "Read <files>"\n---\nBody stays out of the prefix.',
  );
  await put(
    "project/.claude/skills/alpha/SKILL.md",
    "---\nname: alpha\ndescription: |\n  Claude skill.\n---\nBody",
  );
  await NodeFSP.mkdir(NodePath.join(root, "home/.claude/skills"), { recursive: true });
  await NodeFSP.symlink(
    NodePath.join(root, "home/.agents/skills/zeta"),
    NodePath.join(root, "home/.claude/skills/zeta"),
  );
  const options = { home: NodePath.join(root, "home"), cwd: NodePath.join(root, "project/sub") };
  const first = await loadContext(options);
  const second = await loadContext(options);
  expect(first.prompt).toBe(second.prompt);
  expect(first.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
  expect(first.instructions.filter((file) => file.text === "Project instructions.")).toHaveLength(
    1,
  );
  expect(first.prompt).toContain("Imported instructions.");
  expect(first.prompt).toContain("Scoped instructions.");
  expect(first.prompt).toContain("&lt;files&gt;");
  expect(first.prompt).not.toContain("Body stays out");
  await put("project/extra.md", "Changed instructions.");
  expect(first.prompt).toBe(second.prompt);
  expect((await loadContext(options)).prompt).not.toBe(first.prompt);
});

test("rejects oversized context rather than silently dropping instructions", async () => {
  const { root, put } = await fixture();
  await put("AGENTS.md", "x".repeat(65537));
  await expect(loadContext({ cwd: root, home: NodePath.join(root, "home") })).rejects.toThrow(
    "64 KiB",
  );
});

test("cache identity survives tool ordering and token rotation, but separates accounts and threads", () => {
  const options = {
    accountId: "account",
    threadId: "thread",
    instructions: "Stable instructions",
    tools: [
      { name: "wait", inputSchema: { type: "object", properties: {} } },
      { name: "exec", inputSchema: { properties: {}, type: "object" } },
    ],
  };
  const first = createPromptSnapshot(options);
  const second = createPromptSnapshot({ ...options, tools: [...options.tools].toReversed() });
  expect(first).toEqual(second);
  expect(first.promptCacheKey).toHaveLength(64);
  expect(createPromptSnapshot({ ...options, accountId: "other" }).promptCacheKey).not.toBe(
    first.promptCacheKey,
  );
  expect(createPromptSnapshot({ ...options, threadId: "other" }).promptCacheKey).not.toBe(
    first.promptCacheKey,
  );
  const changed = createPromptSnapshot({ ...options, instructions: "Changed" });
  expect(changed.prefixHash).not.toBe(first.prefixHash);
  expect(changed.promptCacheKey).toBe(first.promptCacheKey);
  options.tools[0].inputSchema.type = "string";
  expect(first.tools[1].inputSchema.type).toBe("object");
  expect(() =>
    createPromptSnapshot({ ...options, tools: [options.tools[0], options.tools[0]] }),
  ).toThrow("unique");
});

test("cache reporting does not count cached input twice or invent cache hits", () => {
  expect(cacheUsage({ input_tokens: 1000, input_tokens_details: { cached_tokens: 800 } })).toEqual({
    inputTokens: 1000,
    cachedInputTokens: 800,
    uncachedInputTokens: 200,
    cachedFraction: 0.8,
  });
  expect(cacheUsage({ input_tokens: 1000 })).toBeNull();
  expect(cacheUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 11 } })).toBeNull();
});
