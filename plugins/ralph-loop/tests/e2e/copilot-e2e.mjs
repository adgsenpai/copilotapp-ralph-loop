#!/usr/bin/env node
// Sandbox end-to-end with the REAL Copilot CLI (spec §11.3).
//
// Builds a small app — a temperature-converter CLI — in a throwaway git repo
// using the Ralph loop, then independently checks the result (the oracle does
// not trust the loop's own claims).
//
//   node tests/e2e/copilot-e2e.mjs fresh       # fresh-context runner, markdown spec -> ralph-prd -> stories
//   node tests/e2e/copilot-e2e.mjs in-session  # agentStop hook drives one copilot -p session
//   node tests/e2e/copilot-e2e.mjs extension   # extension loads; ralph_status tool answers
//
// Env: COPILOT_BIN (default "copilot"), RALPH_E2E_MODEL (optional), KEEP=1 keeps the sandbox.

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initLoop, readState, readPrd, paths, buildIterationPrompt } from "../../lib/core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COPILOT = process.env.COPILOT_BIN || "copilot";
const MODEL = process.env.RALPH_E2E_MODEL;
const mode = process.argv[2] || "fresh";
const log = (...a) => console.log(`[e2e:${mode}]`, ...a);

const SPEC = `# Temperature converter (toy app for the Ralph loop E2E)

Build a tiny Node.js (ES modules, no dependencies) temperature converter.

1. \`src/convert.mjs\` exports \`cToF(c)\` and \`fToC(f)\` (numbers in, numbers out; fToC(32) === 0, cToF(100) === 212).
2. \`test/convert.test.mjs\` uses \`node:test\` and \`node:assert\` to cover both functions, including 0, 100, -40 and 32.
3. A CLI \`bin/convert.mjs\`: \`node bin/convert.mjs --to-f 100\` prints \`212\`; \`node bin/convert.mjs --to-c 32\` prints \`0\`; with no/unknown flag it prints usage to stderr and exits 1. Add a test for the CLI in \`test/cli.test.mjs\`.

Verification command: \`npm test\` (runs \`node --test\`).
`;

const PRD = [
  { id: "S1", priority: 1, title: "Conversion functions in src/convert.mjs", acceptance: ["src/convert.mjs exports cToF and fToC", "cToF(100) === 212 and fToC(32) === 0", "npm test exits 0"], passes: false },
  { id: "S2", priority: 2, title: "Unit tests for conversions", acceptance: ["test/convert.test.mjs covers 0, 100, -40 and 32 for both functions", "npm test exits 0"], passes: false },
  { id: "S3", priority: 3, title: "CLI with --to-f / --to-c flags", acceptance: ["node bin/convert.mjs --to-f 100 prints 212", "node bin/convert.mjs --to-c 32 prints 0", "no/unknown flag prints usage to stderr and exits 1", "test/cli.test.mjs covers the CLI", "npm test exits 0"], passes: false },
];

function sh(cwd, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", ...opts });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), `ralph-e2e-${mode}-`));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "ralph-e2e@example.invalid"]);
  sh(dir, "git", ["config", "user.name", "Ralph E2E"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "temp-converter", version: "0.0.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(dir, "AGENTS.md"), "# Agent notes\n\n- Node.js ES modules, no dependencies.\n- Build: none. Test/verify: `npm test`.\n- Commit each finished story as `ralph: <id> <title>`.\n");
  writeFileSync(join(dir, "SPEC.md"), SPEC);
  writeFileSync(join(dir, "prd-input.json"), JSON.stringify(PRD, null, 2));
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test/.gitkeep"), "");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "toy repo"]);
  return dir;
}

// Independent oracle: does the app actually work?
function oracle(dir) {
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const fn = sh(dir, process.execPath, ["--input-type=module", "-e", "import {cToF,fToC} from './src/convert.mjs'; console.log(JSON.stringify([cToF(100), fToC(32), cToF(-40), fToC(212)]))"], { env });
  check("functions convert correctly", fn.out === "[212,0,-40,100]", fn.out || fn.err);
  const f = sh(dir, process.execPath, ["bin/convert.mjs", "--to-f", "100"], { env });
  check("CLI --to-f 100 prints 212", f.code === 0 && f.out === "212", JSON.stringify(f));
  const c = sh(dir, process.execPath, ["bin/convert.mjs", "--to-c", "32"], { env });
  check("CLI --to-c 32 prints 0", c.code === 0 && c.out === "0", JSON.stringify(c));
  const u = sh(dir, process.execPath, ["bin/convert.mjs", "--nope"], { env });
  check("CLI unknown flag exits 1 with usage on stderr", u.code === 1 && /usage/i.test(u.err), JSON.stringify(u));
  const t = sh(dir, "npm", ["test", "--silent"], { env });
  check("npm test passes", t.code === 0, t.code !== 0 ? t.out.slice(-400) : "");
  check("test files exist", existsSync(join(dir, "test/convert.test.mjs")) && existsSync(join(dir, "test/cli.test.mjs")));
  const st = readState(dir);
  check("loop status is complete", st.status === "complete", `${st.status} after ${st.iteration} iterations`);
  const prd = readPrd(dir);
  check("every story passes in prd.json", prd.length > 0 && prd.every((s) => s.passes), `${prd.filter((s) => s.passes).length}/${prd.length}`);
  const logOut = sh(dir, "git", ["log", "--oneline"]).out;
  check("work committed on a ralph/ branch", /^ralph\//.test(sh(dir, "git", ["rev-parse", "--abbrev-ref", "HEAD"]).out) && logOut.split("\n").length > 2);
  check("no push attempted / no remote", sh(dir, "git", ["remote"]).out === "");
  return checks;
}

function summarise(dir, checks, extra = {}) {
  const st = readState(dir);
  const metrics = readFileSync(paths(dir).metrics, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const report = {
    mode, dir, status: st.status, iterations: st.iteration, tokens: st.tokens,
    decisions: metrics.filter((m) => m.event === "iteration").map((m) => `${m.iteration}:${m.decision}/${m.reason}`),
    gitLog: sh(dir, "git", ["log", "--oneline"]).out.split("\n"),
    passed: checks.filter((c) => c.ok).length, total: checks.length, ...extra,
  };
  writeFileSync(join(dir, "..", `ralph-e2e-${mode}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const ok = checks.every((c) => c.ok);
  log(ok ? "E2E PASSED" : "E2E FAILED", `(${report.passed}/${report.total})`);
  if (ok && !process.env.KEEP) rmSync(dir, { recursive: true, force: true });
  return ok ? 0 : 1;
}

async function fresh() {
  const dir = sandbox();
  log("sandbox", dir);
  const args = [join(ROOT, "runner/ralph.mjs"), "run", "SPEC.md", "--max", "8", "--verify", "npm test", "--minutes", "40", "--iteration-timeout", "600", "-C", dir];
  if (MODEL) args.push("--model", MODEL);
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, RALPH_COPILOT_BIN: COPILOT } });
  log("runner exit", r.status);
  return summarise(dir, oracle(dir));
}

async function inSession() {
  const dir = sandbox();
  log("sandbox", dir);
  // Arm the loop (what /ralph-start does), then start ONE copilot session with
  // the first iteration prompt. The agentStop hook must drive the rest.
  const st = initLoop(dir, { source: "prd-input.json", mode: "in-session", limits: { maxIterations: 8, verifyCmd: "npm test", maxMinutes: 40 } });
  const prompt = buildIterationPrompt(dir, st, {});
  writeFileSync(join(dir, ".ralph/first-prompt.md"), prompt);
  const args = ["-p", "Read .ralph/first-prompt.md and follow its instructions exactly.", "--plugin-dir", ROOT, "--allow-all-tools",
    "--deny-tool", "shell(git push)", "--deny-tool", "shell(git push:*)", "--no-ask-user", "--no-auto-update", "--experimental",
    "--usage-output-file", join(dir, ".ralph/session-usage.json")];
  if (MODEL) args.push("--model", MODEL);
  const started = Date.now();
  const code = await new Promise((res) => {
    const c = spawn(COPILOT, args, { cwd: dir, stdio: "inherit" });
    const t = setTimeout(() => c.kill("SIGTERM"), 40 * 60_000);
    c.on("close", (x) => { clearTimeout(t); res(x); });
  });
  log("copilot exit", code, `in ${Math.round((Date.now() - started) / 1000)}s`);
  const hookDecisions = readFileSync(paths(dir).metrics, "utf8").trim().split("\n").map(JSON.parse).filter((m) => m.event === "hook");
  log("hook decisions:", hookDecisions.map((h) => `${h.decision}/${h.reason}`).join(", "));
  const checks = oracle(dir);
  checks.push({ name: "agentStop hook drove >=2 iterations in one session", ok: hookDecisions.filter((h) => h.decision === "block").length >= 2 });
  log(`${checks.at(-1).ok ? "PASS" : "FAIL"} agentStop hook drove >=2 iterations in one session`);
  return summarise(dir, checks, { hookDecisions: hookDecisions.length });
}

async function extension() {
  const dir = sandbox();
  initLoop(dir, { source: "prd-input.json", mode: "in-session", limits: { maxIterations: 3, verifyCmd: "npm test" } });
  // Mark as stopped so the hook does not loop; we only probe the extension tool.
  const st = readState(dir); st.status = "stopped"; writeFileSync(paths(dir).state, JSON.stringify(st, null, 2));
  const r = sh(dir, COPILOT, ["-p", "Call the ralph_status tool exactly once and print its raw JSON output verbatim, nothing else.", "--plugin-dir", ROOT, "--experimental", "--allow-all-tools", "--no-ask-user", "--no-auto-update", "-s"], { timeout: 300_000 });
  log("output:", r.out.slice(0, 800));
  const ok = /"status":\s*"stopped"/.test(r.out) && /"maxIterations":\s*3/.test(r.out);
  log(ok ? "E2E PASSED (extension tool reachable)" : "E2E FAILED (extension tool not reachable)");
  if (ok && !process.env.KEEP) rmSync(dir, { recursive: true, force: true });
  return ok ? 0 : 1;
}

const run = { fresh, "in-session": inSession, extension }[mode];
if (!run) { console.error("mode must be fresh | in-session | extension"); process.exit(2); }
process.exit(await run());
