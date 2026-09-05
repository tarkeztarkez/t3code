import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { FxSettings } from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import { record, string } from "./FxTools.ts";

export interface FxMcpServer {
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
}

const decodeServers = Schema.decodeUnknownSync(FxSettings.fields.mcpServers);
export async function loadFxMcpServers(
  home: string,
  cwd: string,
  agentDir: string,
  overrides: Readonly<Record<string, FxMcpServer>>,
) {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const path of [
    NodePath.join(home, ".config/mcp/mcp.json"),
    NodePath.join(home, ".agents/mcp.json"),
    NodePath.join(home, ".agents/mcp/mcp.json"),
    NodePath.join(agentDir, "mcp.json"),
    NodePath.join(cwd, ".mcp.json"),
    NodePath.join(cwd, ".pi/mcp.json"),
  ]) {
    const size = await NodeFSP.stat(path).then(
      (stat) => stat.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (size === undefined) continue;
    if (size > 1024 * 1024) throw new Error("MCP configuration exceeds 1 MiB");
    const data = record(JSON.parse(await NodeFSP.readFile(path, "utf8")));
    for (const [name, entry] of Object.entries(record(data.mcpServers ?? {})))
      merged[name] = { ...merged[name], ...record(entry) };
  }
  return decodeServers({
    ...Object.fromEntries(Object.entries(merged).filter(([, value]) => value.disabled !== true)),
    ...overrides,
  });
}

// Connections are lazy and conversation-owned. MCP credentials stay in the host.
export function makeFxMcp(options: {
  servers: Readonly<Record<string, FxMcpServer>>;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  bridge: () => McpProviderSessionConfig | undefined;
}) {
  const connections = new Map<string, Promise<{ client: Client; tools: Tool[] }>>();
  const configurations = new Map<string, string>();
  let closed = false;
  const servers = (): Readonly<Record<string, FxMcpServer>> => {
    const bridge = options.bridge();
    return {
      ...options.servers,
      ...(bridge
        ? {
            "t3-code": {
              url: bridge.endpoint,
              headers: { Authorization: bridge.authorizationHeader },
            },
          }
        : {}),
    };
  };
  const connect = (name: string) => {
    const config: FxMcpServer | undefined = servers()[name];
    const identity = JSON.stringify(config);
    const existing = connections.get(name);
    if (existing && configurations.get(name) === identity && !closed) return existing;
    if (existing) {
      connections.delete(name);
      void existing.then((value) => value.client.close()).catch(() => undefined);
    }
    if (identity) configurations.set(name, identity);
    const promise = (async () => {
      if (closed) throw new Error("MCP session is closed");
      if (!config) throw new Error(`Unknown MCP server: ${name}`);
      const client = new Client({ name: "t3-fx", version: "1" });
      try {
        const transport = config.url
          ? new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers ?? {} },
              reconnectionOptions: {
                maxRetries: 0,
                initialReconnectionDelay: 1000,
                maxReconnectionDelay: 1000,
                reconnectionDelayGrowFactor: 1,
              },
            })
          : new StdioClientTransport({
              command: string(config.command),
              args: [...(config.args ?? [])],
              cwd: options.cwd,
              env: {
                ...Object.fromEntries(
                  Object.entries(options.environment).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                ),
                ...config.env,
              },
              stderr: "pipe",
            });
        if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
        // SDK 1.29 declares sessionId differently on Transport and its HTTP
        // implementation under exactOptionalPropertyTypes.
        await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: 30000 });
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 30000 });
          tools.push(...page.tools);
          if (tools.length > 2000) throw new Error("MCP catalog exceeds 2000 tools");
          cursor = page.nextCursor;
        } while (cursor);
        if (closed) throw new Error("MCP session is closed");
        return { client, tools };
      } catch (error) {
        await client.close().catch(() => undefined);
        if (configurations.get(name) === identity) connections.delete(name);
        throw error;
      }
    })();
    connections.set(name, promise);
    return promise;
  };
  return {
    async call(input: unknown, signal: AbortSignal): Promise<unknown> {
      const args = record(input);
      signal.throwIfAborted();
      const names = Object.keys(servers()).sort();
      if (args.connect) {
        const name = string(args.connect);
        const connection = await connect(name);
        return { server: name, tools: connection.tools.length };
      }
      if (!args.search && !args.describe && !args.tool)
        return { servers: names.map((name) => ({ name, connected: connections.has(name) })) };
      const selected = args.server ? [string(args.server)] : names;
      const catalogs = await Promise.all(
        selected.map(async (server) => {
          try {
            return { server, ...(await connect(server)) };
          } catch {
            return {
              server,
              error: "MCP connection failed. Check this server's configuration and credentials.",
            };
          }
        }),
      );
      const tools = catalogs.flatMap((c) =>
        "tools" in c && c.tools ? c.tools.map((tool) => ({ server: c.server, tool })) : [],
      );
      if (args.search) {
        const query = string(args.search).toLowerCase();
        return {
          items: tools
            .filter((t) =>
              `${t.server} ${t.tool.name} ${t.tool.description ?? ""}`
                .toLowerCase()
                .includes(query),
            )
            .slice(0, 30)
            .map((t) => ({ server: t.server, name: t.tool.name, description: t.tool.description })),
          errors: catalogs.filter((c) => "error" in c),
        };
      }
      const name = string(args.describe ?? args.tool);
      const matching = tools.filter((t) => t.tool.name === name);
      if (matching.length !== 1)
        throw new Error(
          "Specify an exact MCP tool and server. Use search to inspect available tools.",
        );
      const match = matching[0]!;
      if (args.describe) return { server: match.server, ...match.tool };
      const { client } = await connect(match.server);
      return client.callTool(
        {
          name,
          arguments:
            args.args === undefined
              ? {}
              : record(typeof args.args === "string" ? JSON.parse(args.args) : args.args),
        },
        undefined,
        { signal, timeout: 24 * 60 * 60 * 1000, maxTotalTimeout: 24 * 60 * 60 * 1000 },
      );
    },
    async close() {
      closed = true;
      await Promise.allSettled(
        [...connections.values()].map(async (p) => (await p).client.close()),
      );
      connections.clear();
      configurations.clear();
    },
  };
}
