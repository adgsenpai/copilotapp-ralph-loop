// Ralph Loop core: state files, limits, PRD validation and the pure
// continue/stop decision shared by the agentStop hook, the extension,
// the fresh-context runner and the MCP server.
//
// Node built-ins only (spec §10, supply-chain trust).

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RALPH_DIR = ".ralph";
export const COMPLETION_TOKEN = "<promise>RALPH_COMPLETE</promise>";
// Copilot CLI ends a turn after 8 consecutive agentStop blocks (CLI changelog).
export const CLI_MAX_CONSECUTIVE_BLOCKS = 8;

export const DEFAULT_LIMITS = Object.freeze({
  maxIterations: 20,          // FR-5 default
  maxTokens: 2_000_000,       // budget across the whole run
  maxMinutes: 120,            // wall-clock cap
  maxFailStreak: 3,           // identical failing verification N times -> stuck
  maxNoDiffIterations: 3,     // no git change across M iterations -> stuck
  compactEvery: 5,            // compaction nudge every K iterations (§7.4)
  verifyCmd: "npm test",
  verifyTimeoutSec: 600,
  autoCommit: true,
  review: false,              // FR-10 reviewer gate
});

export const STATUSES = Object.freeze([
  "running", "paused", "complete", "max_iterations", "budget", "timeout",
  "stuck", "stopped", "tampered", "error",
]);
export const TERMINAL = new Set(STATUSES.filter((s) => s !== "running" && s !== "paused"));

// ---------------------------------------------------------------- paths/io

export function paths(cwd) {
  const dir = join(cwd, RALPH_DIR);
  return {
    dir,
    state: join(dir, "state.json"),
    prd: join(dir, "prd.json"),
    prompt: join(dir, "prompt.md"),
    progress: join(dir, "progress.md"),
    metrics: join(dir, "metrics.jsonl"),
    usage: join(dir, "usage.json"),
    review: join(dir, "review.json"),
    spec: join(dir, "spec.md"),
    agents: join(cwd, "AGENTS.md"),
  };
}

export function readJson(file, fallback = undefined) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

// Atomic write: a crash never leaves a half-written state.json (idempotence NFR).
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export function hasLoop(cwd) { return existsSync(paths(cwd).state); }
export function readState(cwd) { return readJson(paths(cwd).state); }
export function writeState(cwd, st) { writeJson(paths(cwd).state, st); }

// ---------------------------------------------------------------- limits

export function limitsHash(limits) {
  const canon = JSON.stringify(Object.keys(limits).sort().map((k) => [k, limits[k]]));
  return createHash("sha256").update(canon).digest("hex");
}

export function normalizeLimits(input = {}) {
  const l = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(input)) if (v !== undefined && k in DEFAULT_LIMITS) l[k] = v;
  for (const k of ["maxIterations", "maxTokens", "maxMinutes", "maxFailStreak", "maxNoDiffIterations", "compactEvery", "verifyTimeoutSec"]) {
    const n = Number(l[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`limit ${k} must be a finite positive number (got ${l[k]})`);
    l[k] = Math.floor(n);
  }
  if (typeof l.verifyCmd !== "string" || !l.verifyCmd.trim()) throw new Error("limit verifyCmd must be a non-empty command");
  l.autoCommit = Boolean(l.autoCommit);
  l.review = Boolean(l.review);
  return l;
}

// ---------------------------------------------------------------- PRD

export function validatePrd(prd) {
  const errors = [];
  const stories = Array.isArray(prd) ? prd : prd?.stories;
  if (!Array.isArray(stories)) return { ok: false, errors: ["prd.json must be an array of stories or {stories:[...]}"], stories: [] };
  const ids = new Set();
  stories.forEach((s, i) => {
    const at = `story[${i}]`;
    if (!s || typeof s !== "object") { errors.push(`${at} is not an object`); return; }
    if (typeof s.id !== "string" || !s.id) errors.push(`${at}.id must be a non-empty string`);
    else if (ids.has(s.id)) errors.push(`${at}.id "${s.id}" is duplicated`);
    else ids.add(s.id);
    if (typeof s.title !== "string" || !s.title) errors.push(`${at}.title must be a non-empty string`);
    if (!Array.isArray(s.acceptance) || s.acceptance.length === 0 || !s.acceptance.every((a) => typeof a === "string" && a))
      errors.push(`${at}.acceptance must be a non-empty array of strings`);
    if (typeof s.passes !== "boolean") errors.push(`${at}.passes must be boolean`);
    if (s.priority !== undefined && !Number.isFinite(s.priority)) errors.push(`${at}.priority must be a number`);
  });
  return { ok: errors.length === 0, errors, stories };
}

export function readPrd(cwd) {
  const raw = readJson(paths(cwd).prd, []);
  return Array.isArray(raw) ? raw : (raw?.stories ?? []);
}

export function writePrd(cwd, stories) { writeJson(paths(cwd).prd, stories); }

export function orderedStories(stories) {
  return stories
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.priority ?? a.i) - (b.s.priority ?? b.i) || a.i - b.i)
    .map((x) => x.s);
}

export function nextStory(stories) {
  return orderedStories(stories).find((s) => !s.passes) ?? null;
}

export function prdSummary(stories) {
  const done = stories.filter((s) => s.passes).length;
  return { total: stories.length, done, remaining: stories.length - done, allPass: stories.length > 0 && done === stories.length };
}

// ---------------------------------------------------------------- git / verification

function run(cmd, args, cwd, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: opts.timeoutMs ?? 60_000, shell: opts.shell ?? false, env: opts.env ?? process.env, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

export function git(cwd, ...args) { return run("git", args, cwd); }
export function isGitRepo(cwd) { return git(cwd, "rev-parse", "--is-inside-work-tree").stdout.trim() === "true"; }

// Hash of the project's tree (committed + working changes), excluding the
// loop's own bookkeeping in .ralph/ except the story pass/fail vector. Equal
// hashes across iterations mean "no progress" (stuck detector, FR-5).
export function diffHash(cwd) {
  if (!isGitRepo(cwd)) return null;
  // Snapshot the working tree's *content* into a throwaway index, so the hash
  // does not change merely because existing work was committed.
  const gitDir = git(cwd, "rev-parse", "--absolute-git-dir").stdout.trim();
  const idx = join(gitDir, `ralph-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    run("git", ["add", "-A", "--", ".", `:(exclude)${RALPH_DIR}`], cwd, { env });
    const tree = run("git", ["write-tree"], cwd, { env }).stdout.trim();
    let passes = "";
    try { passes = readPrd(cwd).map((s) => `${s.id}:${s.passes}`).join(","); } catch { /* invalid prd */ }
    return createHash("sha256").update(tree + "\0" + passes).digest("hex").slice(0, 16);
  } finally {
    try { rmSync(idx, { force: true }); } catch { /* ignore */ }
  }
}

export function runVerify(cwd, limits) {
  const started = Date.now();
  // Never leak a parent test runner's context into the project's own tests.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = run(limits.verifyCmd, [], cwd, { shell: true, timeoutMs: limits.verifyTimeoutSec * 1000, env });
  const out = (r.stdout + "\n" + r.stderr).trim();
  // Normalise volatile output (timings, durations) so identical failures hash identically.
  const norm = out.replace(/duration_ms:? [\d.]+/g, "#").replace(/\(?[\d.]+\s*(ms|s|sec|seconds)\)?/g, "#").replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b/g, "#");
  return { ok: r.code === 0, code: r.code, tail: out.slice(-2000), hash: createHash("sha256").update(norm).digest("hex").slice(0, 16), ms: Date.now() - started };
}

export function autoCommit(cwd, message) {
  if (!isGitRepo(cwd)) return false;
  const dirty = git(cwd, "status", "--porcelain", "--", ".", `:(exclude)${RALPH_DIR}`).stdout.trim();
  if (!dirty) return false; // idempotent: never create empty/duplicate commits
  git(cwd, "add", "-A", "--", ".", `:(exclude)${RALPH_DIR}`);
  // prd.json / progress.md are tracked on purpose (spec §10 Secrets row).
  git(cwd, "add", "--", `${RALPH_DIR}/prd.json`, `${RALPH_DIR}/progress.md`);
  return git(cwd, "commit", "-q", "-m", message, "--no-verify").code === 0;
}

// ---------------------------------------------------------------- the decision

/**
 * Pure decision function. No IO. Given the state *before* this iteration's
 * evaluation and the observations gathered after the agent stopped, decide
 * whether to continue and with which reason code.
 *
 * @returns {{action:"continue"|"stop", reason:string, next:object}}
 *   next = the fields to merge into state.
 */
export function decide(st, obs) {
  const { limits } = st;
  const iteration = st.iteration + 1;
  const next = { iteration };

  if (limitsHash(limits) !== st.limitsHash) return { action: "stop", reason: "tampered", next };

  // stuck detection inputs
  const sameFailure = !obs.verify.ok && obs.verify.hash === st.lastFailHash;
  next.failStreak = obs.verify.ok ? 0 : (sameFailure ? st.failStreak + 1 : 1);
  next.lastFailHash = obs.verify.ok ? null : obs.verify.hash;
  const unchanged = obs.diffHash !== null && obs.diffHash === st.lastDiffHash;
  next.noDiffStreak = unchanged ? st.noDiffStreak + 1 : 0;
  next.lastDiffHash = obs.diffHash;
  next.tokens = obs.tokens ?? st.tokens;

  const s = obs.prd;
  if (!obs.prdValid) {
    // An invalid PRD is a failure the agent must fix; counts toward the stuck detector.
  } else if (s.allPass && obs.verify.ok) {
    if (!limits.review || obs.reviewPassed) return { action: "stop", reason: "complete", next };
    // review pending: fall through to continue with a review prompt
    next.needsReview = true;
  }

  if (iteration >= limits.maxIterations) return { action: "stop", reason: "max_iterations", next };
  if (next.tokens >= limits.maxTokens) return { action: "stop", reason: "budget", next };
  if (obs.now - Date.parse(st.startedAt) >= limits.maxMinutes * 60_000) return { action: "stop", reason: "timeout", next };
  if (next.failStreak >= limits.maxFailStreak) return { action: "stop", reason: "stuck", next };
  if (next.noDiffStreak >= limits.maxNoDiffIterations) return { action: "stop", reason: "stuck", next };

  const why = next.needsReview ? "review_pending"
    : !obs.prdValid ? "continue_invalid_prd"
    : obs.claimedComplete ? "continue_claim_unverified"
    : obs.verify.ok ? "continue" : "continue_verify_failed";
  return { action: "continue", reason: why, next };
}

// ---------------------------------------------------------------- prompts

export function buildIterationPrompt(cwd, st, { reason, verify, needsReview } = {}) {
  const p = paths(cwd);
  const base = existsSync(p.prompt) ? readFileSync(p.prompt, "utf8") : defaultPrompt(st.limits);
  const stories = readPrd(cwd);
  const nxt = nextStory(stories);
  const lines = [base.trim(), "", "---", `Ralph iteration ${st.iteration + 1} of max ${st.limits.maxIterations}.`];
  if (stories.length === 0) {
    lines.push("prd.json is empty: this iteration, use the ralph-prd skill to turn .ralph/spec.md into .ralph/prd.json (small, ordered, verifiable stories, all passes:false). Do not implement anything yet.");
  } else if (nxt) {
    lines.push(`Next story: ${nxt.id} — ${nxt.title}`);
  }
  if (needsReview) {
    lines.push("All stories pass and verification is green. Before the loop may finish, delegate to the ralph-reviewer agent to review the full diff of this loop against the acceptance criteria, then write .ralph/review.json as {\"head\": \"<git rev-parse HEAD>\", \"verdict\": \"pass\"|\"fail\", \"notes\": \"...\"}. If it fails, set the affected stories back to passes:false and record why in progress.md.");
  }
  if (reason === "continue_claim_unverified") lines.push("You claimed completion, but the controller's own verification did not confirm it. Keep working.");
  if (reason === "continue_invalid_prd") lines.push("prd.json failed schema validation; fix it first (array of {id,title,acceptance[],passes}).");
  if (verify && !verify.ok) lines.push("", `Controller verification (\`${st.limits.verifyCmd}\`) is failing (exit ${verify.code}). Tail:`, "```", verify.tail.slice(-1200), "```");
  if (st.limits.compactEvery && (st.iteration + 1) % st.limits.compactEvery === 0)
    lines.push("", "Context note: this session is long. Rely on files (prd.json, progress.md, git log) rather than earlier conversation; keep this turn focused.");
  return lines.join("\n");
}

export function defaultPrompt(limits) {
  return `# Ralph iteration contract

You are one iteration of an autonomous Ralph loop. State lives in files and git, not in this conversation.

1. Read AGENTS.md (if present), .ralph/prd.json, .ralph/progress.md and \`git log --oneline -10\`.
2. Pick the single highest-priority story with "passes": false (lowest priority number; ties by order).
3. Implement only that story. Keep the change small.
4. Run the verification command: \`${limits.verifyCmd}\`.
5. If green: set that story's "passes" to true in .ralph/prd.json, append a short entry to .ralph/progress.md (what you did, what you learned), and commit with message "ralph: <story id> <title>".
   If red: do NOT mark it done; append what failed and what you tried to .ralph/progress.md.
6. Then stop. Do one story per iteration.

Rules: never edit .ralph/state.json, .ralph/usage.json or loop limits; never force-push, delete branches or rewrite history; stay inside this repository.
When every story passes and verification is green, end your reply with ${COMPLETION_TOKEN}.
`;
}

// ---------------------------------------------------------------- lifecycle

function nowIso() { return new Date().toISOString(); }

export function appendProgress(cwd, text) {
  const p = paths(cwd);
  mkdirSync(p.dir, { recursive: true });
  appendFileSync(p.progress, `\n## ${nowIso()}\n${String(text).trim()}\n`);
}

export function appendMetric(cwd, record) {
  const p = paths(cwd);
  mkdirSync(p.dir, { recursive: true });
  appendFileSync(p.metrics, JSON.stringify({ ts: nowIso(), ...record }) + "\n");
}

// Parse Copilot CLI's --usage-output-file JSON into {inputTokens, outputTokens}.
export function parseCopilotUsage(u) {
  let input = 0, output = 0;
  for (const m of Object.values(u?.modelMetrics ?? {})) {
    input += m?.usage?.inputTokens ?? 0;
    output += m?.usage?.outputTokens ?? 0;
  }
  if (!input && !output && u?.tokenDetails) {
    input = (u.tokenDetails.input?.tokenCount ?? 0) + (u.tokenDetails.cache_read?.tokenCount ?? 0) + (u.tokenDetails.cache_write?.tokenCount ?? 0);
    output = u.tokenDetails.output?.tokenCount ?? 0;
  }
  return { inputTokens: input, outputTokens: output };
}

export function readUsageTokens(cwd) {
  const u = readJson(paths(cwd).usage, null);
  return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0;
}

export function addUsage(cwd, input = 0, output = 0) {
  const p = paths(cwd);
  const u = readJson(p.usage, { inputTokens: 0, outputTokens: 0 });
  u.inputTokens += input; u.outputTokens += output; u.updatedAt = nowIso();
  writeJson(p.usage, u);
  return u;
}

function ensureGitignore(cwd) {
  const gi = join(cwd, ".gitignore");
  const block = `\n# ralph-loop (spec §10: only prd.json and progress.md are tracked)\n${RALPH_DIR}/*\n!${RALPH_DIR}/prd.json\n!${RALPH_DIR}/progress.md\n`;
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!cur.includes(`${RALPH_DIR}/*`)) writeFileSync(gi, cur + block);
}

/**
 * Initialise .ralph/ (FR-1). `source` may be a prd.json (validated and copied)
 * or any other text spec (copied to .ralph/spec.md; prd.json starts empty and
 * the first iteration runs the ralph-prd skill).
 */
export function initLoop(cwd, { source, limits: limitInput = {}, mode = "in-session", branch = true, force = false } = {}) {
  const p = paths(cwd);
  if (existsSync(p.state) && !force) {
    const st = readState(cwd);
    if (st.status === "running") throw new Error(`a Ralph loop is already running in ${cwd} (use stop or --force)`);
  }
  const limits = normalizeLimits(limitInput);
  mkdirSync(p.dir, { recursive: true });

  let stories = existsSync(p.prd) ? readPrd(cwd) : [];
  if (source) {
    const src = resolve(cwd, source);
    if (!existsSync(src)) throw new Error(`spec/prd not found: ${src}`);
    const text = readFileSync(src, "utf8");
    if (src.endsWith(".json")) {
      const v = validatePrd(JSON.parse(text));
      if (!v.ok) throw new Error("invalid prd.json:\n  " + v.errors.join("\n  "));
      stories = v.stories;
    } else {
      writeFileSync(p.spec, text);
      stories = [];
    }
  }
  writePrd(cwd, stories);
  if (!existsSync(p.prompt)) writeFileSync(p.prompt, defaultPrompt(limits));
  if (!existsSync(p.progress)) writeFileSync(p.progress, `# Ralph progress log\n\nAppend-only. Each iteration records what was done, learned and what failed.\n`);
  ensureGitignore(cwd);

  let branchName = null;
  if (branch && isGitRepo(cwd)) {
    const cur = git(cwd, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    if (cur.startsWith("ralph/")) branchName = cur;
    else {
      branchName = `ralph/${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
      const r = git(cwd, "checkout", "-q", "-b", branchName);
      if (r.code !== 0) branchName = cur; // fall back to the current branch, never destructive
    }
  }

  // Commit the loop's tracked bookkeeping (.gitignore, prd.json, progress.md)
  // so the stuck detector's baseline is the real starting point.
  if (isGitRepo(cwd)) {
    git(cwd, "add", "--", ".gitignore", `${RALPH_DIR}/prd.json`, `${RALPH_DIR}/progress.md`);
    if (git(cwd, "diff", "--cached", "--quiet").code !== 0) git(cwd, "commit", "-q", "--no-verify", "-m", "ralph: initialise loop");
  }

  const st = {
    version: 1,
    status: "running",
    mode,
    iteration: 0,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    tokens: 0,
    failStreak: 0,
    lastFailHash: null,
    noDiffStreak: 0,
    lastDiffHash: diffHash(cwd),
    consecutiveBlocks: 0,
    branch: branchName,
    limits,
    limitsHash: limitsHash(limits),
    lastReason: "init",
  };
  writeState(cwd, st);
  writeJson(p.usage, { inputTokens: 0, outputTokens: 0, updatedAt: nowIso() });
  appendMetric(cwd, { event: "init", mode, limits, stories: stories.length, branch: branchName });
  return st;
}

export function setStatus(cwd, status, reason = status) {
  const st = readState(cwd);
  if (!st) throw new Error("no Ralph loop in " + cwd);
  st.status = status; st.lastReason = reason; st.updatedAt = nowIso();
  writeState(cwd, st);
  appendMetric(cwd, { event: "status", status, reason });
  return st;
}

export function stopLoop(cwd, reason = "user") { return setStatus(cwd, "stopped", reason); }

export function resumeLoop(cwd) {
  const st = readState(cwd);
  if (!st) throw new Error("no Ralph loop in " + cwd);
  if (st.status === "complete") throw new Error("loop is already complete");
  if (st.status === "tampered") throw new Error("limits were tampered with; re-initialise the loop");
  // Resuming after a limit stop resets the streak counters, not the limits.
  if (st.iteration >= st.limits.maxIterations) throw new Error(`max iterations (${st.limits.maxIterations}) already reached; start a new loop with a higher --max`);
  st.status = "running"; st.failStreak = 0; st.noDiffStreak = 0; st.consecutiveBlocks = 0; st.lastReason = "resume"; st.updatedAt = nowIso();
  writeState(cwd, st);
  appendMetric(cwd, { event: "resume" });
  return st;
}

export function readStatus(cwd) {
  if (!hasLoop(cwd)) return { active: false, message: "No Ralph loop in this directory." };
  const st = readState(cwd);
  const stories = readPrd(cwd);
  const sum = prdSummary(stories);
  const nxt = nextStory(stories);
  return {
    active: st.status === "running",
    status: st.status,
    mode: st.mode,
    iteration: st.iteration,
    maxIterations: st.limits.maxIterations,
    tokens: Math.max(st.tokens, readUsageTokens(cwd)),
    maxTokens: st.limits.maxTokens,
    startedAt: st.startedAt,
    branch: st.branch,
    lastReason: st.lastReason,
    stories: sum,
    nextStory: nxt ? { id: nxt.id, title: nxt.title } : null,
    remaining: orderedStories(stories).filter((s) => !s.passes).map((s) => ({ id: s.id, title: s.title })),
  };
}

export function completeStory(cwd, id, passes = true) {
  const stories = readPrd(cwd);
  const s = stories.find((x) => x.id === id);
  if (!s) throw new Error(`unknown story id: ${id}`);
  s.passes = Boolean(passes);
  writePrd(cwd, stories);
  return s;
}

// Did the last assistant message in a Copilot transcript claim completion?
export function transcriptClaimsComplete(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
      const ev = JSON.parse(lines[i]);
      if (ev.type === "assistant.message") return String(ev.data?.content ?? "").includes(COMPLETION_TOKEN);
    }
  } catch { /* best effort */ }
  return false;
}

/**
 * One full evaluation step, used by both the hook (in-session) and the runner
 * (fresh-context). Gathers observations, applies decide(), persists state and
 * metrics, auto-commits on green, and returns the decision plus the next prompt.
 */
export function evaluateIteration(cwd, { transcriptPath, tokens, claimedComplete, now = Date.now() } = {}) {
  const st = readState(cwd);
  const stories = readPrd(cwd);
  const v = validatePrd(stories);
  const verify = runVerify(cwd, st.limits);
  const review = readJson(paths(cwd).review, null);
  const head = isGitRepo(cwd) ? git(cwd, "rev-parse", "HEAD").stdout.trim() : null;

  // Commit on success before hashing, so committed work counts as progress.
  let committed = false;
  if (verify.ok && st.limits.autoCommit) {
    const nxt = nextStory(stories);
    committed = autoCommit(cwd, `ralph: iteration ${st.iteration + 1}${nxt ? "" : " (all stories pass)"}`);
  }

  const obs = {
    verify,
    prd: prdSummary(stories),
    prdValid: v.ok,
    diffHash: diffHash(cwd),
    tokens: Math.max(st.tokens, tokens ?? readUsageTokens(cwd)),
    now,
    claimedComplete: claimedComplete ?? transcriptClaimsComplete(transcriptPath),
    reviewPassed: Boolean(review && review.verdict === "pass" && (!head || review.head === head || review.head === head.slice(0, review.head?.length))),
  };
  const d = decide(st, obs);
  Object.assign(st, d.next);
  st.updatedAt = new Date(now).toISOString();
  st.lastReason = d.reason;
  if (d.action === "stop") st.status = d.reason === "complete" ? "complete" : d.reason;
  writeState(cwd, st);
  appendMetric(cwd, {
    event: "iteration", iteration: st.iteration, decision: d.action, reason: d.reason,
    verifyExit: verify.code, verifyMs: verify.ms, stories: obs.prd, tokens: st.tokens,
    diffHash: obs.diffHash, failStreak: st.failStreak, noDiffStreak: st.noDiffStreak, committed,
  });
  const prompt = d.action === "continue" ? buildIterationPrompt(cwd, { ...st, iteration: st.iteration }, { reason: d.reason, verify, needsReview: d.next.needsReview }) : null;
  return { ...d, state: st, verify, prompt, committed };
}
