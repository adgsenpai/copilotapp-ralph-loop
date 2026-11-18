#!/usr/bin/env node
// Ralph Loop fresh-context runner (spec §7.5, FR-8, FR-11, FR-13).
//
// Huntley's original form: start a *new* Copilot CLI process for every
// iteration against the same .ralph/ state, then apply the same completion
// logic the in-session hook uses. Node only, cross-platform.
//
//   node runner/ralph.mjs run <spec-or-prd> [--max N] [--budget T] [--minutes M]
//                              [--verify "cmd"] [--review] [--model M] [--agent A]
//                              [--dry-run] [--no-branch] [--force] [-C dir]
//   node runner/ralph.mjs init <spec-or-prd> [...]   # arm for in-session mode
//   node runner/ralph.mjs status|stop|resume [-C dir]

import { spawn } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PLUGIN_ROOT, paths, initLoop, readState, writeState, stopLoop, resumeLoop, readStatus,
  evaluateIteration, buildIterationPrompt, addUsage, parseCopilotUsage, readJson, appendMetric,
  COMPLETION_TOKEN, hasLoop,
} from "../lib/core.mjs";
import { parseArgs } from "../lib/args.mjs";

const log = (...a) => process.stderr.write("[ralph] " + a.join(" ") + "\n");

export function copilotCommand(bin, args) {
  // Allow a JS fake (tests) or the real CLI.
  if (/\.(mjs|cjs|js)$/.test(bin)) return { cmd: process.execPath, args: [bin, ...args] };
  return { cmd: bin, args };
}

export function buildCopilotArgs({ promptFile, usageFile, model, agent, pluginDir = PLUGIN_ROOT }) {
  const args = [
    "-p", `Read the file ${promptFile} and follow its instructions exactly. It is this iteration's task.`,
    "--allow-all-tools",
    "--deny-tool", "shell(git push)",
    "--deny-tool", "shell(git push:*)",
    "--deny-tool", "shell(git reset --hard:*)",
    "--deny-tool", "shell(git branch -D:*)",
    "--no-ask-user",
    "--no-auto-update",
    "--usage-output-file", usageFile,
    "--plugin-dir", pluginDir,
  ];
  if (model) args.push("--model", model);
  if (agent) args.push("--agent", agent);
  return args;
}

function runChild(cmd, args, { cwd, timeoutMs, env }) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && !cmd.endsWith(".exe") && cmd !== process.execPath });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => { log(`iteration timed out after ${timeoutMs / 1000}s, killing agent`); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); res({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(t); res({ code: 127, out, err: String(e) }); });
  });
}

export async function runLoop(cwd, opts) {
  const p = paths(cwd);
  let st = hasLoop(cwd) ? readState(cwd) : null;
  const source = opts.positional[0];
  if (!st || opts.force || (source && st.status !== "running")) {
    st = initLoop(cwd, { source, limits: opts.limits, mode: "fresh", branch: opts.branch, force: opts.force });
    log(`initialised loop on ${st.branch ?? "current branch"}: max ${st.limits.maxIterations} iterations, verify "${st.limits.verifyCmd}"`);
  } else if (st.status !== "running") {
    throw new Error(`loop status is "${st.status}"; use resume or pass a spec with --force`);
  } else {
    log(`resuming running loop at iteration ${st.iteration}`);
    if (st.mode !== "fresh") { st.mode = "fresh"; writeState(cwd, st); }
  }

  if (opts.dryRun) {
    const prompt = buildIterationPrompt(cwd, st, {});
    const status = readStatus(cwd);
    process.stdout.write(`# Ralph dry run\n\nPlan (${status.stories.total} stories):\n` +
      (status.remaining.map((s, i) => `  ${i + 1}. ${s.id} ${s.title}`).join("\n") || "  (prd.json empty: iteration 1 will generate it from .ralph/spec.md)") +
      `\n\nLimits: ${JSON.stringify(st.limits)}\n\nFirst iteration prompt:\n\n${prompt}\n`);
    stopLoop(cwd, "dry_run");
    return { status: "dry_run" };
  }

  const bin = opts.copilotBin || process.env.RALPH_COPILOT_BIN || "copilot";
  const iterTimeoutMs = (opts.iterationTimeoutSec || Math.min(st.limits.maxMinutes * 60, 1800)) * 1000;
  let stopping = false;
  const onSig = () => { if (stopping) process.exit(130); stopping = true; log("interrupt: stopping after this iteration (Ctrl-C again to abort)"); stopLoop(cwd, "user"); };
  process.on("SIGINT", onSig);

  try {
    while (readState(cwd).status === "running") {
      st = readState(cwd);
      if (Date.now() - Date.parse(st.startedAt) >= st.limits.maxMinutes * 60_000) { st.status = "timeout"; st.lastReason = "timeout"; writeState(cwd, st); break; }
      const n = st.iteration + 1;
      const promptFile = join(p.dir, "next-prompt.md");
      const usageFile = join(p.dir, `usage-iter.json`);
      writeFileSync(promptFile, buildIterationPrompt(cwd, st, { reason: st.lastReason, verify: st.lastReason === "continue_verify_failed" ? readJson(join(p.dir, "last-verify.json"), undefined) : undefined }));
      if (existsSync(usageFile)) rmSync(usageFile);
      log(`iteration ${n}/${st.limits.maxIterations}: spawning ${bin}`);
      const { cmd, args } = copilotCommand(bin, buildCopilotArgs({ promptFile: `${".ralph"}/next-prompt.md`, usageFile, model: opts.model, agent: opts.agent }));
      const started = Date.now();
      const child = await runChild(cmd, args, { cwd, timeoutMs: iterTimeoutMs, env: { ...process.env, RALPH_RUNNER: "1" } });
      const u = parseCopilotUsage(readJson(usageFile, null));
      addUsage(cwd, u.inputTokens, u.outputTokens);
      appendMetric(cwd, { event: "agent_exit", iteration: n, exitCode: child.code, ms: Date.now() - started, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
      if (child.code !== 0) log(`agent exited ${child.code}: ${child.err.trim().split("\n").slice(-3).join(" | ")}`);
      if (readState(cwd).status !== "running") break; // stopped by user mid-iteration
      const r = evaluateIteration(cwd, { claimedComplete: child.out.includes(COMPLETION_TOKEN) });
      writeFileSync(join(p.dir, "last-verify.json"), JSON.stringify(r.verify));
      log(`iteration ${r.state.iteration}: ${r.action} (${r.reason}) — verify exit ${r.verify.code}, stories ${readStatus(cwd).stories.done}/${readStatus(cwd).stories.total}, tokens ${r.state.tokens}`);
    }
  } finally {
    process.off("SIGINT", onSig);
  }
  const final = readStatus(cwd);
  log(`loop finished: ${final.status} after ${final.iteration} iterations`);
  return final;
}

export async function main(argv) {
  const [sub = "help", ...rest] = argv;
  const opts = parseArgs(rest);
  const cwd = resolve(opts.cwd || process.cwd());
  switch (sub) {
    case "run": {
      const r = await runLoop(cwd, opts);
      return r.status === "complete" || r.status === "dry_run" ? 0 : 2;
    }
    case "dry-run": { await runLoop(cwd, { ...opts, dryRun: true }); return 0; }
    case "init": {
      const st = initLoop(cwd, { source: opts.positional[0], limits: opts.limits, mode: "in-session", branch: opts.branch, force: opts.force });
      process.stdout.write(`Ralph loop armed (in-session) on ${st.branch ?? "current branch"}.\nStart Copilot in this directory and send:\n\n${buildIterationPrompt(cwd, st, {})}\n`);
      return 0;
    }
    case "status": process.stdout.write(JSON.stringify(readStatus(cwd), null, 2) + "\n"); return 0;
    case "stop": stopLoop(cwd, "user"); process.stdout.write("stopped\n"); return 0;
    case "resume": {
      const st = resumeLoop(cwd);
      if (st.mode === "fresh") { const r = await runLoop(cwd, { ...opts, positional: [] }); return r.status === "complete" ? 0 : 2; }
      process.stdout.write("resumed (in-session): send any message in Copilot to continue, or use /ralph-resume\n");
      return 0;
    }
    default:
      process.stdout.write(`Usage: ralph <run|dry-run|init|status|stop|resume> [spec-or-prd] [--max N] [--budget TOKENS] [--minutes M] [--verify "cmd"] [--review] [--model M] [--agent A] [--no-branch] [--force] [-C dir]\n`);
      return sub === "help" || sub === "--help" ? 0 : 1;
  }
}

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { log("error:", e.message); process.exit(1); });
}
