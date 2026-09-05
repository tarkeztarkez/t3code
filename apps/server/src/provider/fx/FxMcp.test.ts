// @effect-diagnostics nodeBuiltinImport:off - Native ACP, OAuth files and fixture subprocesses use Node streams and filesystem semantics.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test, expect } from "vitest";
import { loadFxMcpServers, makeFxMcp } from "./FxMcp.ts";

test("MCP merges shared configuration and lazily discovers/calls a stdio server", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fx-mcp-"));
  const agent = NodePath.join(home, ".pi/agent");
  await NodeFSP.mkdir(agent, { recursive: true });
  const script = NodePath.join(home, "server.mjs");
  await NodeFSP.writeFile(
    script,
    'import {createInterface} from "node:readline"; const reader=createInterface({input:process.stdin}); reader.on("line",line=>{const r=JSON.parse(line); if(r.id===undefined)return; const result=r.method==="initialize"?{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:r.method==="tools/list"?{tools:[{name:"echo",description:"Echo input",inputSchema:{type:"object",properties:{text:{type:"string"}}}}]}:{content:[{type:"text",text:r.params.arguments.text}]}; process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");});',
  );
  await NodeFSP.writeFile(
    NodePath.join(agent, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } },
        disabled: { command: "never-start" },
      },
    }),
  );
  await NodeFSP.mkdir(NodePath.join(home, ".pi"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(home, ".pi/mcp.json"),
    JSON.stringify({ mcpServers: { disabled: { disabled: true } } }),
  );
  const servers = await loadFxMcpServers(home, home, agent, {});
  expect(Object.keys(servers)).toEqual(["fixture"]);
  const mcp = makeFxMcp({ servers, cwd: home, environment: {}, bridge: () => undefined });
  const signal = new AbortController().signal;
  try {
    expect(await mcp.call({}, signal)).toEqual({
      servers: [{ name: "fixture", connected: false }],
    });
    expect(await mcp.call({ search: "echo" }, signal)).toMatchObject({
      items: [{ name: "echo", server: "fixture" }],
    });
    expect(await mcp.call({ describe: "echo", server: "fixture" }, signal)).toMatchObject({
      inputSchema: { type: "object" },
    });
    expect(await mcp.call({ tool: "echo", args: '{"text":"MCP works"}' }, signal)).toMatchObject({
      content: [{ type: "text", text: "MCP works" }],
    });
    await expect(mcp.call({ tool: "invented" }, signal)).rejects.toThrow("exact MCP tool");
  } finally {
    await mcp.close();
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
