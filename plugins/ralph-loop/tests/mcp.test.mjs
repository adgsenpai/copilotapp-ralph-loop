// MCP server (FR-9): JSON-RPC over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { MCP, tempRepo, writePrdFile, story } from "./helpers.mjs";

function rpc(cwd, msgs) {
  const r = spawnSync(process.execPath, [MCP], { cwd, input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("mcp: initialize, list, init/status/next/complete/stop", () => {
  const { dir } = tempRepo();
  const prd = writePrdFile(dir, [story("S1"), story("S2")]);
  const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const res = rpc(dir, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "ralph_init", { source: prd, maxIterations: 4, verifyCmd: "true", branch: false }),
    call(4, "ralph_next_story"),
    call(5, "ralph_complete_story", { id: "S1" }),
    call(6, "ralph_status"),
    call(7, "ralph_stop"),
    call(8, "ralph_complete_story", { id: "missing" }),
    { jsonrpc: "2.0", id: 9, method: "bogus" },
  ]);
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, "ralph-loop-mcp");
  assert.deepEqual(byId[2].result.tools.map((t) => t.name).sort(), ["ralph_complete_story", "ralph_init", "ralph_log_learning", "ralph_next_story", "ralph_status", "ralph_stop"]);
  assert.equal(JSON.parse(byId[3].result.content[0].text).limits.maxIterations, 4);
  assert.equal(JSON.parse(byId[4].result.content[0].text).id, "S1");
  assert.equal(JSON.parse(byId[6].result.content[0].text).stories.done, 1);
  assert.equal(JSON.parse(byId[7].result.content[0].text).status, "stopped");
  assert.equal(byId[8].result.isError, true);
  assert.equal(byId[9].error.code, -32601);
  assert.equal(res.length, 9, "notifications get no response");
});
