// Shared argument parsing for /ralph-start and the runner CLI.
// Accepts: <spec-or-prd-path> [--max N] [--budget TOKENS] [--minutes M]
//          [--verify "cmd"] [--fail-streak N] [--no-diff N] [--review]
//          [--no-branch] [--force] [--dry-run] [--model M] [--agent NAME]

export function tokenize(str) {
  const out = []; let cur = ""; let q = null; let has = false;
  for (const ch of String(str ?? "")) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += ch; has = true;
  }
  if (q) throw new Error("unterminated quote in arguments");
  if (has || cur) out.push(cur);
  return out;
}

const NUM = { "--max": "maxIterations", "--budget": "maxTokens", "--minutes": "maxMinutes", "--fail-streak": "maxFailStreak", "--no-diff": "maxNoDiffIterations", "--compact-every": "compactEvery", "--verify-timeout": "verifyTimeoutSec" };

export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : tokenize(argv);
  const r = { positional: [], limits: {}, branch: true, force: false, dryRun: false, model: undefined, agent: undefined, copilotBin: undefined, cwd: undefined, iterationTimeoutSec: undefined };
  for (let i = 0; i < list.length; i++) {
    let a = list[i]; let val;
    if (a.startsWith("--") && a.includes("=")) { val = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    const take = () => { if (val !== undefined) return val; if (i + 1 >= list.length) throw new Error(`${a} needs a value`); return list[++i]; };
    if (a in NUM) { const n = Number(take()); if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} must be a positive number`); r.limits[NUM[a]] = n; }
    else if (a === "--verify") r.limits.verifyCmd = take();
    else if (a === "--review") r.limits.review = true;
    else if (a === "--no-auto-commit") r.limits.autoCommit = false;
    else if (a === "--no-branch") r.branch = false;
    else if (a === "--force") r.force = true;
    else if (a === "--dry-run") r.dryRun = true;
    else if (a === "--model") r.model = take();
    else if (a === "--agent") r.agent = take();
    else if (a === "--copilot") r.copilotBin = take();
    else if (a === "--cwd" || a === "-C") r.cwd = take();
    else if (a === "--iteration-timeout") r.iterationTimeoutSec = Number(take());
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else r.positional.push(a);
  }
  return r;
}
