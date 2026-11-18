// Hook contract tests (spec §11.2): feed agentStop payloads on stdin and
// assert the exact stdout JSON for continue, complete, budget, stuck,
// max_iterations, no-loop and error cases.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initLoop, readState, writeState, completeStory, addUsage, CLI_MAX_CONSECUTIVE_BLOCKS } from "../lib/core.mjs";
import { tempRepo, story, writePrdFile, runHook, hookPayload } from "./helpers.mjs";

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "console.log('boom'); process.exit(1)"`;

function armed(stories, limits = {}, mode = "in-session") {
  const { dir } = tempRepo();
  initLoop(dir, { source: writePrdFile(dir, stories), limits: { verifyCmd: PASS, ...limits }, mode, branch: false });
  return dir;
}

describe("agentStop hook contract", () => {
  test("no loop -> allow stop ({})", () => {
    const { dir } = tempRepo();
    const r = runHook(hookPayload(dir));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "{}");
  });

  test("continue -> block with the iteration prompt as reason", () => {
    const dir = armed([story("S1"), story("S2")]);
    writeFileSync(join(dir, "w.txt"), "1");
    const r = runHook(hookPayload(dir));
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /Ralph iteration contract/);
    assert.match(out.reason, /Ralph iteration 2 of max 20/);
    assert.match(out.reason, /Next story: S1/);
    assert.equal(readState(dir).iteration, 1);
    assert.equal(readState(dir).consecutiveBlocks, 1);
  });

  test("hook run from a subdirectory finds the loop root", () => {
    const dir = armed([story("S1")]);
    mkdirSync(join(dir, "src/deep"), { recursive: true });
    const out = JSON.parse(runHook(hookPayload(join(dir, "src/deep"))).stdout);
    assert.equal(out.decision, "block");
  });

  test("complete -> {} and status complete", () => {
    const dir = armed([story("S1", true), story("S2", true)]);
    const r = runHook(hookPayload(dir));
    assert.equal(r.stdout, "{}");
    assert.equal(readState(dir).status, "complete");
  });

  test("all stories pass but verification fails -> block (no false completion)", () => {
    const dir = armed([story("S1", true)], { verifyCmd: FAIL });
    const out = JSON.parse(runHook(hookPayload(dir)).stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /verification .* is failing/);
    assert.match(out.reason, /boom/);
  });

  test("budget -> {} and status budget", () => {
    const dir = armed([story("S1")], { maxTokens: 500 });
    addUsage(dir, 400, 200);
    assert.equal(runHook(hookPayload(dir)).stdout, "{}");
    assert.equal(readState(dir).status, "budget");
  });

  test("stuck (identical failing check) -> {} and status stuck", () => {
    const dir = armed([story("S1")], { verifyCmd: FAIL, maxFailStreak: 2, maxNoDiffIterations: 99 });
    writeFileSync(join(dir, "a.txt"), "1");
    assert.equal(JSON.parse(runHook(hookPayload(dir)).stdout).decision, "block");
    writeFileSync(join(dir, "a.txt"), "2");
    assert.equal(runHook(hookPayload(dir, { stop_hook_active: true })).stdout, "{}");
    assert.equal(readState(dir).status, "stuck");
  });

  test("stuck (no diff) -> {} and status stuck", () => {
    const dir = armed([story("S1")], { maxNoDiffIterations: 2 });
    assert.equal(JSON.parse(runHook(hookPayload(dir)).stdout).decision, "block");
    assert.equal(runHook(hookPayload(dir, { stop_hook_active: true })).stdout, "{}");
    assert.equal(readState(dir).status, "stuck");
  });

  test("max_iterations -> {} and never runs unbounded", () => {
    const dir = armed([story("S1")], { maxIterations: 3, maxNoDiffIterations: 99 });
    const outs = [];
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, "f.txt"), String(i));
      const o = runHook(hookPayload(dir, { stop_hook_active: i > 0 })).stdout;
      outs.push(o === "{}" ? "allow" : "block");
      if (o === "{}") break;
    }
    assert.deepEqual(outs, ["block", "block", "allow"]);
    assert.equal(readState(dir).status, "max_iterations");
  });

  test("stopped loop -> {}", () => {
    const dir = armed([story("S1")]);
    writeState(dir, { ...readState(dir), status: "stopped" });
    assert.equal(runHook(hookPayload(dir)).stdout, "{}");
  });

  test("fresh-context mode and runner children are ignored by the hook", () => {
    const dir = armed([story("S1")], {}, "fresh");
    assert.equal(runHook(hookPayload(dir)).stdout, "{}");
    const dir2 = armed([story("S1")]);
    assert.equal(runHook(hookPayload(dir2), { RALPH_RUNNER: "1" }).stdout, "{}");
    assert.equal(readState(dir2).iteration, 0);
  });

  test("tampered limits -> {} and status tampered", () => {
    const dir = armed([story("S1")]);
    const st = readState(dir);
    st.limits.maxIterations = 10_000;
    writeState(dir, st);
    assert.equal(runHook(hookPayload(dir)).stdout, "{}");
    assert.equal(readState(dir).status, "tampered");
  });

  test("malformed stdin -> {} (never loops on a crash)", () => {
    const r = runHook("{not json");
    assert.equal(r.stdout, "{}");
    assert.match(r.stderr, /hook error/);
  });

  test("consecutive-block counter flags needsKick at the CLI cap and resets on a fresh turn", () => {
    const dir = armed([story("S1")], { maxNoDiffIterations: 99, maxIterations: 50 });
    for (let i = 0; i < CLI_MAX_CONSECUTIVE_BLOCKS; i++) {
      writeFileSync(join(dir, "f.txt"), String(i));
      runHook(hookPayload(dir, { stop_hook_active: i > 0 }));
    }
    assert.equal(readState(dir).needsKick, true);
    writeFileSync(join(dir, "f.txt"), "fresh");
    runHook(hookPayload(dir, { stop_hook_active: false }));
    assert.equal(readState(dir).consecutiveBlocks, 1);
    assert.equal(readState(dir).needsKick, false);
  });

  test("progress: completed story flips to complete on the next stop", () => {
    const dir = armed([story("S1")]);
    writeFileSync(join(dir, "impl.js"), "x");
    assert.equal(JSON.parse(runHook(hookPayload(dir)).stdout).decision, "block");
    completeStory(dir, "S1");
    assert.equal(runHook(hookPayload(dir, { stop_hook_active: true })).stdout, "{}");
    assert.equal(readState(dir).status, "complete");
  });
});
