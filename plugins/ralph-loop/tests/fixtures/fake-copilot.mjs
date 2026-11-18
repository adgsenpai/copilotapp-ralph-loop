#!/usr/bin/env node
// A deterministic stand-in for `copilot -p` used by the runner tests.
// It honours the iteration contract: picks the next story, writes that
// story's solution files (from FAKE_SOLUTIONS), runs verification, marks the
// story passing on green, appends progress, commits, and writes a usage file.
//
// Env:
//   FAKE_SOLUTIONS  path to {storyId: {file: content}}
//   FAKE_TOKENS     tokens to report per iteration (default 1000)
//   FAKE_NOOP       "1" = do nothing at all (simulates a stuck agent)

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const cwd = process.cwd();
const usageFile = get("--usage-output-file");
const tokens = Number(process.env.FAKE_TOKENS ?? 1000);
if (usageFile) writeFileSync(usageFile, JSON.stringify({ modelMetrics: { fake: { usage: { inputTokens: tokens - 100, outputTokens: 100 } } } }));

if (!get("-p")?.includes(".ralph/next-prompt.md")) { console.error("fake-copilot: unexpected prompt"); process.exit(3); }
const prompt = readFileSync(join(cwd, ".ralph/next-prompt.md"), "utf8");
if (!prompt.includes("Ralph iteration")) { console.error("fake-copilot: prompt missing contract"); process.exit(4); }
if (process.env.FAKE_NOOP === "1") { console.log("I did nothing."); process.exit(0); }

const prdFile = join(cwd, ".ralph/prd.json");
const prd = JSON.parse(readFileSync(prdFile, "utf8"));
const next = prd.filter((s) => !s.passes).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
if (!next) { console.log("All stories pass. <promise>RALPH_COMPLETE</promise>"); process.exit(0); }

const solutions = JSON.parse(readFileSync(process.env.FAKE_SOLUTIONS, "utf8"));
for (const [f, c] of Object.entries(solutions[next.id] ?? {})) {
  mkdirSync(dirname(join(cwd, f)), { recursive: true });
  writeFileSync(join(cwd, f), c);
}
const verify = JSON.parse(readFileSync(join(cwd, ".ralph/state.json"), "utf8")).limits.verifyCmd;
const v = spawnSync(verify, { cwd, shell: true, encoding: "utf8" });
if (v.status === 0) {
  next.passes = true;
  writeFileSync(prdFile, JSON.stringify(prd, null, 2));
  appendFileSync(join(cwd, ".ralph/progress.md"), `\n- ${next.id}: done\n`);
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", `ralph: ${next.id} ${next.title}`], { cwd });
  console.log(`Completed ${next.id}.`);
} else {
  appendFileSync(join(cwd, ".ralph/progress.md"), `\n- ${next.id}: verification failed\n`);
  console.log(`${next.id} failed verification.`);
}
