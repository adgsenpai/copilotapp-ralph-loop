// Fresh-context runner tests with a deterministic fake Copilot (spec §11.3/§11.4):
// three-story toy repo must reach `complete` within 6 iterations; an
// unpassable story must stop with `stuck` or `max_iterations`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readState, paths, git } from "../lib/core.mjs";
import { tempRepo, story, writePrdFile, RUNNER, FAKE_COPILOT } from "./helpers.mjs";
import { buildCopilotArgs } from "../runner/ralph.mjs";

const TOY_SOLUTIONS = {
  S1: { "src/math.mjs": "export function add(a, b) { return a + b; }\n" },
  S2: { "test/math.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n" },
  S3: { "bin/cli.mjs": "import { add } from '../src/math.mjs';\nconst i = process.argv.indexOf('--sum');\nif (i >= 0) console.log(add(Number(process.argv[i + 1]), Number(process.argv[i + 2])));\n",
        "test/cli.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { execFileSync } from 'node:child_process';\ntest('cli --sum', () => assert.equal(execFileSync(process.execPath, ['bin/cli.mjs', '--sum', '2', '3'], { encoding: 'utf8' }).trim(), '5'));\n" },
};
const TOY_PRD = [
  { id: "S1", title: "Add add(a,b) function", priority: 1, acceptance: ["src/math.mjs exports add"], passes: false },
  { id: "S2", title: "Add a unit test for add", priority: 2, acceptance: ["node --test passes with a test for add"], passes: false },
  { id: "S3", title: "Add --sum CLI flag", priority: 3, acceptance: ["node bin/cli.mjs --sum 2 3 prints 5"], passes: false },
];
const VERIFY = "node --test";

function runner(dir, args, env = {}) {
  const sol = join(dir, "..", `${dir.split(/[\\/]/).pop()}-solutions.json`);
  writeFileSync(sol, JSON.stringify(env.solutions ?? TOY_SOLUTIONS));
  const r = spawnSync(process.execPath, [RUNNER, ...args, "--copilot", FAKE_COPILOT, "-C", dir], {
    encoding: "utf8", env: { ...process.env, FAKE_SOLUTIONS: sol, ...env.vars },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function toyRepo() {
  return tempRepo({ files: { "package.json": JSON.stringify({ name: "toy", type: "module", scripts: { test: VERIFY } }, null, 2), "test/.keep": "" } }).dir;
}

describe("fresh-context runner", () => {
  test("three-story toy app reaches complete within 6 iterations", () => {
    const dir = toyRepo();
    const prd = writePrdFile(dir, TOY_PRD);
    const r = runner(dir, ["run", prd, "--max", "6", "--verify", VERIFY]);
    assert.equal(r.code, 0, r.stderr);
    const st = readState(dir);
    assert.equal(st.status, "complete");
    assert.ok(st.iteration <= 6, `took ${st.iteration}`);
    const prdOut = JSON.parse(readFileSync(paths(dir).prd, "utf8"));
    assert.ok(prdOut.every((s) => s.passes));
    const log = git(dir, "log", "--oneline").stdout;
    for (const id of ["S1", "S2", "S3"]) assert.match(log, new RegExp(`ralph: ${id}`));
    assert.match(git(dir, "rev-parse", "--abbrev-ref", "HEAD").stdout, /^ralph\//);
    // tokens metered from the usage file of every iteration
    assert.equal(st.tokens, st.iteration * 1000);
    const metrics = readFileSync(paths(dir).metrics, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(metrics.filter((m) => m.event === "iteration").every((m) => typeof m.reason === "string"));
  });

  test("failure injection: an unpassable story stops with stuck", () => {
    const dir = toyRepo();
    const prd = writePrdFile(dir, TOY_PRD);
    const broken = { ...TOY_SOLUTIONS, S2: { "test/math.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('impossible', () => assert.equal(1, 2));\n" } };
    const r = runner(dir, ["run", prd, "--max", "10", "--verify", VERIFY, "--fail-streak", "3"], { solutions: broken });
    assert.equal(r.code, 2);
    const st = readState(dir);
    assert.ok(["stuck", "max_iterations"].includes(st.status), st.status);
    assert.ok(st.iteration < 10, "must stop before the cap via the stuck detector");
  });

  test("failure injection: an idle agent (no diff) stops with stuck", () => {
    const dir = toyRepo();
    const prd = writePrdFile(dir, TOY_PRD);
    const r = runner(dir, ["run", prd, "--max", "10", "--verify", VERIFY, "--no-diff", "2"], { vars: { FAKE_NOOP: "1" } });
    assert.equal(r.code, 2);
    assert.equal(readState(dir).status, "stuck");
    assert.equal(readState(dir).iteration, 2);
  });

  test("hard cap: max_iterations bounds a loop that keeps changing things", () => {
    const dir = toyRepo();
    const many = Array.from({ length: 8 }, (_, i) => story(`T${i}`, false, { priority: i }));
    const sols = Object.fromEntries(many.map((s, i) => [s.id, { [`f${i}.txt`]: String(i) }]));
    const r = runner(dir, ["run", writePrdFile(dir, many), "--max", "3", "--verify", VERIFY], { solutions: sols });
    assert.equal(r.code, 2);
    assert.equal(readState(dir).status, "max_iterations");
    assert.equal(readState(dir).iteration, 3);
  });

  test("budget stops the loop", () => {
    const dir = toyRepo();
    const r = runner(dir, ["run", writePrdFile(dir, TOY_PRD), "--budget", "1500", "--verify", VERIFY]);
    assert.equal(r.code, 2);
    assert.equal(readState(dir).status, "budget");
  });

  test("dry-run prints the plan and first prompt without invoking the agent", () => {
    const dir = toyRepo();
    const r = runner(dir, ["run", writePrdFile(dir, TOY_PRD), "--dry-run", "--verify", VERIFY], { vars: { FAKE_SOLUTIONS: "/nonexistent" } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Ralph dry run/);
    assert.match(r.stdout, /1\. S1 Add add\(a,b\) function/);
    assert.match(r.stdout, /Ralph iteration contract/);
    assert.equal(readState(dir).iteration, 0);
    assert.doesNotMatch(git(dir, "log", "--oneline").stdout, /ralph: (S\d|iteration)/);
  });

  test("resume after an interruption continues from state.json", () => {
    const dir = toyRepo();
    const prd = writePrdFile(dir, TOY_PRD);
    runner(dir, ["run", prd, "--max", "1", "--verify", VERIFY]);
    assert.equal(readState(dir).status, "max_iterations");
    // simulate a crash mid-run: status left as running with progress on disk
    const st = readState(dir);
    st.status = "running"; st.limits.maxIterations = 1; // untouched hash -> still valid
    writeFileSync(paths(dir).state, JSON.stringify(st));
    const r = spawnSync(process.execPath, [RUNNER, "status", "-C", dir], { encoding: "utf8" });
    assert.equal(JSON.parse(r.stdout).stories.done, 1);
  });

  test("copilot invocation is non-interactive, metered and denies pushes", () => {
    const a = buildCopilotArgs({ promptFile: ".ralph/next-prompt.md", usageFile: "u.json", model: "m", agent: "ralph-worker" });
    assert.equal(a[0], "-p");
    for (const f of ["--allow-all-tools", "--no-ask-user", "--usage-output-file", "--plugin-dir"]) assert.ok(a.includes(f), f);
    assert.ok(a.includes("shell(git push)"));
    assert.deepEqual(a.slice(-4), ["--model", "m", "--agent", "ralph-worker"]);
  });
});
