#!/usr/bin/env node
// ralph-loop-mcp: the Ralph state machine as MCP tools over stdio (spec §9, FR-9).
// Zero dependencies: a minimal newline-delimited JSON-RPC 2.0 MCP server.
// Tools: ralph_init, ralph_status, ralph_next_story, ralph_complete_story,
//        ralph_log_learning, ralph_stop.

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  initLoop, readStatus, nextStory, readPrd, completeStory, stopLoop, appendProgress,
} from "../lib/core.mjs";

const PROTOCOL = "2025-06-18";
const root = () => resolve(process.env.RALPH_CWD || process.cwd());
const cwdProp = { cwd: { type: "string", description: "Repository directory (defaults to the server's working directory)" } };
const dirOf = (a) => resolve(root(), a?.cwd ?? ".");

export const TOOLS = [
  {
    name: "ralph_init",
    description: "Initialise a Ralph loop (.ralph/ state) from a spec or prd.json path, with finite limits.",
    inputSchema: { type: "object", properties: { ...cwdProp, source: { type: "string" }, maxIterations: { type: "number" }, maxTokens: { type: "number" }, maxMinutes: { type: "number" }, verifyCmd: { type: "string" }, mode: { type: "string", enum: ["in-session", "fresh"] }, branch: { type: "boolean" } } },
    run: (a) => initLoop(dirOf(a), { source: a.source, mode: a.mode ?? "in-session", branch: a.branch ?? true, limits: { maxIterations: a.maxIterations, maxTokens: a.maxTokens, maxMinutes: a.maxMinutes, verifyCmd: a.verifyCmd } }),
  },
  { name: "ralph_status", description: "Current loop status, limits, token use and remaining stories.", inputSchema: { type: "object", properties: { ...cwdProp } }, run: (a) => readStatus(dirOf(a)) },
  { name: "ralph_next_story", description: "The highest-priority story with passes:false, or null.", inputSchema: { type: "object", properties: { ...cwdProp } }, run: (a) => nextStory(readPrd(dirOf(a))) },
  {
    name: "ralph_complete_story", description: "Mark a story as passing after verification is green.",
    inputSchema: { type: "object", properties: { ...cwdProp, id: { type: "string" }, passes: { type: "boolean" } }, required: ["id"] },
    run: (a) => completeStory(dirOf(a), a.id, a.passes ?? true),
  },
  {
    name: "ralph_log_learning", description: "Append a learning to .ralph/progress.md.",
    inputSchema: { type: "object", properties: { ...cwdProp, text: { type: "string" } }, required: ["text"] },
    run: (a) => { appendProgress(dirOf(a), a.text); return "ok"; },
  },
  { name: "ralph_stop", description: "Stop the active loop.", inputSchema: { type: "object", properties: { ...cwdProp, reason: { type: "string" } } }, run: (a) => stopLoop(dirOf(a), a.reason ?? "user") },
];

export function handleMessage(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "ralph-loop-mcp", version: "0.1.0" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
      try {
        const r = t.run(params.arguments ?? {});
        return ok({ content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });
      }
    }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); return; }
    const res = handleMessage(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
}
