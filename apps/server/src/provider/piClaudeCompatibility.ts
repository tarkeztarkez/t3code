import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent@0.84.4";
export const PI_COMPAT_EXTENSION_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  "t3-claude-compat.ts",
);

const execFileAsync = promisify(execFile);

export const PI_COMPAT_EXTENSION = `import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { homedir } from "node:os";
import { AuthStorage, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_STATUS_KEY = "t3-codex-usage";

function ancestorPaths(cwd: string, suffix: string[]): string[] {
  const paths: string[] = [];
  let directory = cwd;
  while (true) {
    const candidate = join(directory, ...suffix);
    if (existsSync(candidate)) paths.push(candidate);
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) break;
    directory = parent;
  }
  return paths;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeWindow(value: unknown) {
  const window = asRecord(value);
  const usedPercent = asNumber(window?.used_percent ?? window?.usedPercent);
  if (usedPercent === undefined) return null;
  const seconds = asNumber(window?.limit_window_seconds);
  const resetsAt = asNumber(window?.reset_at ?? window?.resetsAt);
  return {
    usedPercent,
    ...(seconds !== undefined ? { windowDurationMins: seconds / 60 } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function usageFromHeaders(headers: Record<string, string>) {
  const readWindow = (name: "primary" | "secondary") => {
    const usedPercent = asNumber(headers[\`x-codex-\${name}-used-percent\`]);
    if (usedPercent === undefined) return null;
    const windowDurationMins = asNumber(headers[\`x-codex-\${name}-window-minutes\`]);
    const resetsAt = asNumber(headers[\`x-codex-\${name}-reset-at\`]);
    return {
      usedPercent,
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  };
  const primary = readWindow("primary");
  const secondary = readWindow("secondary");
  return primary || secondary ? { primary, secondary } : null;
}

async function fetchCodexUsage(ctx: ExtensionContext) {
  const auth = AuthStorage.create(join(getAgentDir(), "auth.json"));
  const credential = auth.get("openai-codex");
  if (!credential || credential.type !== "oauth") return;
  const token = await auth.getApiKey("openai-codex");
  if (!token) return;
  const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: \`Bearer \${token}\`,
      Accept: "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
  });
  if (!response.ok) return;
  const body = asRecord(await response.json());
  const rateLimit = asRecord(body?.rate_limit ?? body?.rateLimit);
  const primary = normalizeWindow(rateLimit?.primary_window ?? rateLimit?.primary);
  const secondary = normalizeWindow(rateLimit?.secondary_window ?? rateLimit?.secondary);
  if (primary || secondary) ctx.ui.setStatus(USAGE_STATUS_KEY, JSON.stringify({ primary, secondary }));
}

export default function claudeCompatibility(pi: ExtensionAPI) {
  pi.on("resources_discover", async (_event, ctx) => ({
    skillPaths: [
      ...ancestorPaths(ctx.cwd, [".claude", "skills"]),
      join(homedir(), ".claude", "skills"),
    ].filter(existsSync),
  }));
  pi.on("before_agent_start", (event, ctx) => {
    const loaded = new Set(event.systemPromptOptions.contextFiles?.map((file) => file.path));
    const files = [
      join(homedir(), ".claude", "CLAUDE.md"),
      ...ancestorPaths(ctx.cwd, ["CLAUDE.md"]),
    ].filter((path) => existsSync(path) && !loaded.has(path));
    const extra = files
      .map((path) => \`\\n# \${path}\\n\\n\${readFileSync(path, "utf8")}\`)
      .join("\\n");
    return extra ? { systemPrompt: event.systemPrompt + extra } : undefined;
  });
  pi.on("session_start", async (_event, ctx) => {
    await fetchCodexUsage(ctx).catch(() => undefined);
  });
  pi.on("after_provider_response", (event, ctx) => {
    const usage = usageFromHeaders(event.headers);
    if (usage) ctx.ui.setStatus(USAGE_STATUS_KEY, JSON.stringify(usage));
  });
}
`;

export async function installPiCompatibilityExtension(): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(PI_COMPAT_EXTENSION_PATH, PI_COMPAT_EXTENSION, "utf8");
}

export async function installPiGlobally(): Promise<void> {
  await execFileAsync("npm", ["install", "--global", PI_PACKAGE], {
    timeout: 120_000,
    windowsHide: true,
  });
}
