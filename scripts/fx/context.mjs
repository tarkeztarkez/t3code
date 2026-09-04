import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { parse } from "yaml";

const MAX_CONTEXT_BYTES = 64 * 1024;
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const missing = (error) => error.code === "ENOENT" || error.code === "ENOTDIR";

// Capture once for a session. No timestamps, mtimes, locale-dependent ordering,
// or per-turn skill scans enter the cached prompt prefix.
export async function loadContext({ cwd, home = NodeOS.homedir() }) {
  const seen = new Set();
  const instructions = [];
  const skills = [];
  let bytes = 0;
  const consume = (text) => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_CONTEXT_BYTES)
      throw new Error("fx context exceeds 64 KiB; narrow the configured context");
    return text;
  };
  const load = async (path) => {
    let canonical;
    try {
      canonical = await NodeFSP.realpath(path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (seen.has(canonical)) return null;
    const text = await NodeFSP.readFile(canonical, "utf8");
    if (Buffer.byteLength(text) > MAX_CONTEXT_BYTES)
      throw new Error(`Context file exceeds 64 KiB: ${path}`);
    seen.add(canonical);
    return { path: canonical, text };
  };
  const visitInstruction = async (path, depth = 0) => {
    if (depth > 16) throw new Error("Instruction import depth exceeds 16");
    const file = await load(path);
    if (!file) return;
    instructions.push({ path: file.path, text: consume(file.text) });
    // Claude-compatible standalone file imports. Inline mentions are not imports.
    for (const line of file.text.split(/\r?\n/)) {
      const match = /^@([^\s]+)\s*$/.exec(line);
      if (!match) continue;
      const imported = match[1].startsWith("~/")
        ? NodePath.join(home, match[1].slice(2))
        : NodePath.isAbsolute(match[1])
          ? match[1]
          : NodePath.resolve(NodePath.dirname(file.path), match[1]);
      await visitInstruction(imported, depth + 1);
    }
  };
  const ancestors = [];
  let directory = NodePath.resolve(cwd);
  for (;;) {
    ancestors.unshift(directory);
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const file of [
    NodePath.join(home, ".pi/agent/AGENTS.md"),
    NodePath.join(home, ".agents/AGENTS.md"),
    NodePath.join(home, ".claude/CLAUDE.md"),
  ]) {
    await visitInstruction(file);
  }
  for (const ancestor of ancestors) {
    await visitInstruction(NodePath.join(ancestor, "AGENTS.md"));
    await visitInstruction(NodePath.join(ancestor, "CLAUDE.md"));
  }
  const skillRoots = [
    NodePath.join(home, ".pi/agent/skills"),
    NodePath.join(home, ".agents/skills"),
    NodePath.join(home, ".claude/skills"),
    ...ancestors.flatMap((path) => [
      NodePath.join(path, ".pi/skills"),
      NodePath.join(path, ".agents/skills"),
      NodePath.join(path, ".claude/skills"),
    ]),
  ];
  for (const root of skillRoots) {
    let entries;
    try {
      entries = await NodeFSP.readdir(root);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    for (const entry of entries.sort(order)) {
      const file = await load(NodePath.join(root, entry, "SKILL.md"));
      if (!file) continue;
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.text);
      if (!match) throw new Error(`Skill lacks frontmatter: ${file.path}`);
      const metadata = parse(match[1]);
      if (typeof metadata?.name !== "string" || typeof metadata?.description !== "string") {
        throw new Error(`Skill lacks name or description: ${file.path}`);
      }
      if (metadata["disable-model-invocation"] === true) continue;
      consume(metadata.name + metadata.description + file.path);
      skills.push({ name: metadata.name, description: metadata.description, path: file.path });
    }
  }
  skills.sort((a, b) => order(a.name, b.name) || order(a.path, b.path));
  const prompt = [
    ...instructions.map(
      (file) => `<instructions path="${escape(file.path)}">\n${file.text}\n</instructions>`,
    ),
    "Read a matching skill's SKILL.md before using it. Resolve its references relative to that file.",
    "<skills>",
    ...skills.map(
      (skill) =>
        `<skill name="${escape(skill.name)}" path="${escape(skill.path)}">${escape(skill.description)}</skill>`,
    ),
    "</skills>",
  ].join("\n\n");
  if (Buffer.byteLength(prompt) > MAX_CONTEXT_BYTES)
    throw new Error("Rendered fx context exceeds 64 KiB");
  return { instructions, skills, prompt };
}
