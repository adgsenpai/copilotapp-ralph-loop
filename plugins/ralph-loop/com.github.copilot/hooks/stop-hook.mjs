#!/usr/bin/env node
// Ralph Loop in-session controller (spec §7.2, FR-3).
//
// Copilot CLI runs this on `agentStop` with JSON on stdin:
//   {sessionId, timestamp, cwd, transcriptPath, stopReason, stop_hook_active}
// Printing {"decision":"block","reason":<prompt>} forces another agent turn
// with <prompt>; printing {} allows the agent to stop.
//
// Safe by default: any error allows the stop (never loops on a crash).

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  readState, writeState, evaluateIteration, appendMetric, RALPH_DIR, CLI_MAX_CONSECUTIVE_BLOCKS,
} from "../../lib/core.mjs";

const ALLOW = "{}";

function out(s) { process.stdout.write(s + "\n"); }

function findLoopRoot(start) {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, RALPH_DIR, "state.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8" });
  const t = top.stdout?.trim();
  return t && existsSync(join(t, RALPH_DIR, "state.json")) ? t : null;
}

export function handle(input, env = process.env) {
  const cwd = input.cwd || process.cwd();
  const root = findLoopRoot(cwd);
  if (!root) return { stdout: ALLOW, code: "no_loop" };
  const st = readState(root);
  if (!st || st.status !== "running") return { stdout: ALLOW, code: `not_running:${st?.status}` };
  if (st.mode !== "in-session") return { stdout: ALLOW, code: `mode:${st.mode}` };
  if (env.RALPH_RUNNER === "1") return { stdout: ALLOW, code: "runner_child" };

  // Track consecutive forced continuations; the CLI caps them at 8 per turn.
  st.consecutiveBlocks = input.stop_hook_active ? (st.consecutiveBlocks ?? 0) : 0;
  writeState(root, st);

  const tokensEnv = Number(env.RALPH_TOKENS);
  const r = evaluateIteration(root, {
    transcriptPath: input.transcriptPath ?? input.transcript_path,
    tokens: Number.isFinite(tokensEnv) && env.RALPH_TOKENS ? tokensEnv : undefined,
  });

  if (r.action === "stop") {
    appendMetric(root, { event: "hook", decision: "allow_stop", reason: r.reason, sessionId: input.sessionId });
    return { stdout: ALLOW, code: r.reason };
  }
  const st2 = readState(root);
  st2.consecutiveBlocks = (st2.consecutiveBlocks ?? 0) + 1;
  st2.needsKick = st2.consecutiveBlocks >= CLI_MAX_CONSECUTIVE_BLOCKS; // extension re-sends on session.idle
  writeState(root, st2);
  appendMetric(root, { event: "hook", decision: "block", reason: r.reason, sessionId: input.sessionId, consecutiveBlocks: st2.consecutiveBlocks });
  return { stdout: JSON.stringify({ decision: "block", reason: r.prompt }), code: r.reason };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  let input = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = raw.trim() ? JSON.parse(raw) : {};
    const r = handle(input);
    process.stderr.write(`[ralph] ${r.code}\n`);
    out(r.stdout);
  } catch (e) {
    process.stderr.write(`[ralph] hook error, allowing stop: ${e?.stack || e}\n`);
    try {
      const root = findLoopRoot(input.cwd || process.cwd());
      if (root) { const st = readState(root); st.status = "error"; st.lastReason = "hook_error: " + String(e?.message || e); writeState(root, st); }
    } catch { /* ignore */ }
    out(ALLOW);
  }
}
