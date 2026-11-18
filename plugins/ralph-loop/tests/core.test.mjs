// Unit tests (spec §11.1): state transitions, limit evaluation, stuck
// detection, prd.json schema validation.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LIMITS, normalizeLimits, limitsHash, validatePrd, nextStory, prdSummary, decide,
  initLoop, readState, writeState, stopLoop, resumeLoop, readStatus, completeStory, paths,
  parseCopilotUsage, autoCommit, git, buildIterationPrompt, evaluateIteration, COMPLETION_TOKEN,
  transcriptClaimsComplete,
} from "../lib/core.mjs";
import { parseArgs, tokenize } from "../lib/args.mjs";
import { tempRepo, story, writePrdFile } from "./helpers.mjs";

const baseState = (over = {}) => {
  const limits = normalizeLimits({ maxIterations: 5, maxTokens: 10_000, maxMinutes: 60, maxFailStreak: 3, maxNoDiffIterations: 3, ...(over.limits ?? {}) });
  return { iteration: 0, status: "running", startedAt: new Date().toISOString(), tokens: 0, failStreak: 0, lastFailHash: null, noDiffStreak: 0, lastDiffHash: "d0", limits, limitsHash: limitsHash(limits), ...over, ...(over.limits ? { limits, limitsHash: over.limitsHash ?? limitsHash(limits) } : {}) };
};
const obs = (over = {}) => ({ verify: { ok: true, code: 0, hash: "v0" }, prd: { total: 3, done: 1, remaining: 2, allPass: false }, prdValid: true, diffHash: "d1", tokens: 0, now: Date.now(), claimedComplete: false, reviewPassed: false, ...over });

describe("limits", () => {
  test("defaults are finite and conservative", () => {
    const l = normalizeLimits();
    assert.equal(l.maxIterations, 20);
    for (const k of ["maxIterations", "maxTokens", "maxMinutes", "maxFailStreak", "maxNoDiffIterations"]) assert.ok(Number.isFinite(l[k]) && l[k] > 0, k);
  });
  test("rejects non-finite or non-positive limits", () => {
    assert.throws(() => normalizeLimits({ maxIterations: Infinity }));
    assert.throws(() => normalizeLimits({ maxIterations: 0 }));
    assert.throws(() => normalizeLimits({ maxTokens: -1 }));
    assert.throws(() => normalizeLimits({ verifyCmd: "  " }));
  });
  test("ignores unknown keys and floors numbers", () => {
    const l = normalizeLimits({ maxIterations: "7.9", bogus: 1 });
    assert.equal(l.maxIterations, 7);
    assert.equal(l.bogus, undefined);
  });
  test("hash is key-order independent and change-sensitive", () => {
    const a = normalizeLimits({ maxIterations: 4 });
    const b = Object.fromEntries(Object.entries(a).reverse());
    assert.equal(limitsHash(a), limitsHash(b));
    assert.notEqual(limitsHash(a), limitsHash({ ...a, maxIterations: 99 }));
  });
});

describe("prd validation", () => {
  test("accepts a valid array and {stories}", () => {
    assert.ok(validatePrd([story("S1")]).ok);
    assert.ok(validatePrd({ stories: [story("S1")] }).ok);
  });
  test("reports each schema error", () => {
    const v = validatePrd([{ id: "S1", title: "", acceptance: [], passes: "no" }, { id: "S1", title: "x", acceptance: ["a"], passes: false }, null]);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("title")));
    assert.ok(v.errors.some((e) => e.includes("acceptance")));
    assert.ok(v.errors.some((e) => e.includes("passes")));
    assert.ok(v.errors.some((e) => e.includes("duplicated")));
    assert.ok(v.errors.some((e) => e.includes("not an object")));
  });
  test("rejects non-array", () => assert.equal(validatePrd({ foo: 1 }).ok, false));
  test("nextStory honours priority then order", () => {
    const s = [story("A", false, { priority: 3 }), story("B", true, { priority: 1 }), story("C", false, { priority: 2 }), story("D")];
    assert.equal(nextStory(s).id, "C");
    assert.equal(nextStory([story("X", true)]), null);
  });
  test("summary: empty prd is never allPass", () => {
    assert.equal(prdSummary([]).allPass, false);
    assert.equal(prdSummary([story("A", true)]).allPass, true);
  });
});

describe("decide() state transitions", () => {
  test("continue when work remains", () => {
    const d = decide(baseState(), obs());
    assert.equal(d.action, "continue");
    assert.equal(d.reason, "continue");
    assert.equal(d.next.iteration, 1);
  });
  test("complete only when all pass AND verification is green", () => {
    assert.equal(decide(baseState(), obs({ prd: { total: 2, done: 2, remaining: 0, allPass: true } })).reason, "complete");
    const d = decide(baseState(), obs({ prd: { total: 2, done: 2, remaining: 0, allPass: true }, verify: { ok: false, code: 1, hash: "f" } }));
    assert.equal(d.action, "continue");
    assert.equal(d.reason, "continue_verify_failed");
  });
  test("agent's completion claim alone never completes", () => {
    const d = decide(baseState(), obs({ claimedComplete: true }));
    assert.equal(d.action, "continue");
    assert.equal(d.reason, "continue_claim_unverified");
  });
  test("complete beats max_iterations on the final iteration", () => {
    const d = decide(baseState({ iteration: 4 }), obs({ prd: { total: 1, done: 1, remaining: 0, allPass: true } }));
    assert.equal(d.reason, "complete");
  });
  test("max_iterations", () => assert.equal(decide(baseState({ iteration: 4 }), obs()).reason, "max_iterations"));
  test("budget", () => assert.equal(decide(baseState(), obs({ tokens: 10_000 })).reason, "budget"));
  test("timeout", () => assert.equal(decide(baseState({ startedAt: new Date(Date.now() - 61 * 60_000).toISOString() }), obs()).reason, "timeout"));
  test("stuck: same failing check N times", () => {
    let st = baseState();
    const fail = obs({ verify: { ok: false, code: 1, hash: "same" } });
    const reasons = [];
    for (let i = 0; i < 3; i++) { const d = decide(st, { ...fail, diffHash: "d" + (i + 10) }); reasons.push(d.reason); st = { ...st, ...d.next }; }
    assert.deepEqual(reasons, ["continue_verify_failed", "continue_verify_failed", "stuck"]);
  });
  test("different failures reset the fail streak", () => {
    let st = baseState();
    for (const h of ["a", "b", "c", "d"]) { const d = decide(st, obs({ verify: { ok: false, code: 1, hash: h }, diffHash: h })); assert.equal(d.action, "continue"); st = { ...st, ...d.next }; }
    assert.equal(st.failStreak, 1);
  });
  test("stuck: no git diff across M iterations", () => {
    let st = baseState({ lastDiffHash: "same" });
    const out = [];
    for (let i = 0; i < 3; i++) { const d = decide(st, obs({ diffHash: "same" })); out.push(d.reason); st = { ...st, ...d.next }; }
    assert.deepEqual(out, ["continue", "continue", "stuck"]);
  });
  test("tampered limits stop immediately", () => {
    const st = baseState();
    st.limits = { ...st.limits, maxIterations: 9999 };
    assert.equal(decide(st, obs()).reason, "tampered");
  });
  test("review gate holds completion until the reviewer passes", () => {
    const st = baseState({ limits: { review: true } });
    const all = { prd: { total: 1, done: 1, remaining: 0, allPass: true } };
    const d1 = decide(st, obs(all));
    assert.equal(d1.reason, "review_pending");
    assert.equal(d1.next.needsReview, true);
    assert.equal(decide(st, obs({ ...all, reviewPassed: true })).reason, "complete");
  });
  test("invalid prd continues with a fix-it reason", () => assert.equal(decide(baseState(), obs({ prdValid: false })).reason, "continue_invalid_prd"));
});

describe("lifecycle on disk", () => {
  test("initLoop from prd.json creates state, branch, gitignore", () => {
    const { dir } = tempRepo();
    const st = initLoop(dir, { source: writePrdFile(dir, [story("S1"), story("S2")]), limits: { maxIterations: 4, verifyCmd: "true" } });
    assert.equal(st.status, "running");
    assert.match(st.branch, /^ralph\//);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim(), st.branch);
    const p = paths(dir);
    for (const f of [p.state, p.prd, p.prompt, p.progress, p.metrics, p.usage]) assert.ok(existsSync(f), f);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gi, /\.ralph\/\*/); assert.match(gi, /!\.ralph\/prd\.json/); assert.match(gi, /!\.ralph\/progress\.md/);
    assert.equal(st.limitsHash, limitsHash(st.limits));
  });
  test("initLoop from a markdown spec copies it and leaves prd empty", () => {
    const { dir } = tempRepo({ files: { "SPEC.md": "# Build a thing\n" } });
    initLoop(dir, { source: "SPEC.md", branch: false });
    assert.equal(readFileSync(paths(dir).spec, "utf8"), "# Build a thing\n");
    assert.deepEqual(JSON.parse(readFileSync(paths(dir).prd, "utf8")), []);
    assert.match(buildIterationPrompt(dir, readState(dir)), /ralph-prd skill/);
  });
  test("initLoop rejects an invalid prd and a missing source", () => {
    const { dir } = tempRepo();
    assert.throws(() => initLoop(dir, { source: writePrdFile(dir, [{ id: 1 }]) }), /invalid prd/);
    assert.throws(() => initLoop(dir, { source: "nope.md" }), /not found/);
  });
  test("refuses to start over a running loop without force", () => {
    const { dir } = tempRepo();
    initLoop(dir, { source: writePrdFile(dir, [story("S1")]), branch: false });
    assert.throws(() => initLoop(dir, { branch: false }), /already running/);
    assert.doesNotThrow(() => initLoop(dir, { branch: false, force: true }));
  });
  test("stop / resume / status", () => {
    const { dir } = tempRepo();
    initLoop(dir, { source: writePrdFile(dir, [story("S1"), story("S2", true)]), branch: false });
    assert.equal(stopLoop(dir).status, "stopped");
    assert.equal(readStatus(dir).active, false);
    const st = resumeLoop(dir);
    assert.equal(st.status, "running");
    const s = readStatus(dir);
    assert.deepEqual(s.stories, { total: 2, done: 1, remaining: 1, allPass: false });
    assert.equal(s.nextStory.id, "S1");
    completeStory(dir, "S1");
    assert.equal(readStatus(dir).stories.allPass, true);
    assert.throws(() => completeStory(dir, "nope"));
  });
  test("resume refuses complete/tampered/exhausted loops", () => {
    const { dir } = tempRepo();
    initLoop(dir, { source: writePrdFile(dir, [story("S1")]), branch: false, limits: { maxIterations: 2 } });
    const st = readState(dir);
    writeState(dir, { ...st, status: "complete" }); assert.throws(() => resumeLoop(dir), /complete/);
    writeState(dir, { ...st, status: "tampered" }); assert.throws(() => resumeLoop(dir), /tampered/);
    writeState(dir, { ...st, status: "max_iterations", iteration: 2 }); assert.throws(() => resumeLoop(dir), /max iterations/);
  });
  test("autoCommit is idempotent (no duplicate/empty commits)", () => {
    const { dir } = tempRepo();
    initLoop(dir, { source: writePrdFile(dir, [story("S1")]), branch: false });
    writeFileSync(join(dir, "a.txt"), "x");
    assert.equal(autoCommit(dir, "ralph: one"), true);
    assert.equal(autoCommit(dir, "ralph: two"), false);
    assert.equal(git(dir, "log", "--oneline").stdout.trim().split("\n").filter((l) => /ralph: (one|two)/.test(l)).length, 1);
  });
  test("evaluateIteration writes metrics with a reason code and resumes from state", () => {
    const { dir } = tempRepo();
    initLoop(dir, { source: writePrdFile(dir, [story("S1")]), branch: false, limits: { verifyCmd: "node -e \"process.exit(0)\"" } });
    writeFileSync(join(dir, "work.txt"), "progress");
    const r = evaluateIteration(dir);
    assert.equal(r.action, "continue");
    assert.equal(r.committed, true);
    const lines = readFileSync(paths(dir).metrics, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const it = lines.find((l) => l.event === "iteration");
    assert.equal(it.reason, "continue");
    assert.equal(readState(dir).iteration, 1);
    completeStory(dir, "S1");
    const r2 = evaluateIteration(dir);
    assert.equal(r2.reason, "complete");
    assert.equal(readState(dir).status, "complete");
  });
});

describe("helpers", () => {
  test("parseCopilotUsage sums model metrics", () => {
    assert.deepEqual(parseCopilotUsage({ modelMetrics: { a: { usage: { inputTokens: 10, outputTokens: 2 } }, b: { usage: { inputTokens: 5, outputTokens: 1 } } } }), { inputTokens: 15, outputTokens: 3 });
    assert.deepEqual(parseCopilotUsage(null), { inputTokens: 0, outputTokens: 0 });
  });
  test("transcriptClaimsComplete reads the last assistant message", () => {
    const { dir } = tempRepo();
    const f = join(dir, "events.jsonl");
    writeFileSync(f, [{ type: "assistant.message", data: { content: COMPLETION_TOKEN } }, { type: "tool.execution_complete" }].map((e) => JSON.stringify(e)).join("\n"));
    assert.equal(transcriptClaimsComplete(f), true);
    writeFileSync(f, JSON.stringify({ type: "assistant.message", data: { content: "not yet" } }));
    assert.equal(transcriptClaimsComplete(f), false);
    assert.equal(transcriptClaimsComplete(join(dir, "missing")), false);
  });
  test("args: tokenize and parse", () => {
    assert.deepEqual(tokenize(`spec.md --verify "npm test -- --x" --max=3`), ["spec.md", "--verify", "npm test -- --x", "--max=3"]);
    const a = parseArgs(`spec.md --max 3 --budget 5000 --verify 'node --test' --review --no-branch --minutes 9`);
    assert.deepEqual(a.positional, ["spec.md"]);
    assert.deepEqual(a.limits, { maxIterations: 3, maxTokens: 5000, verifyCmd: "node --test", review: true, maxMinutes: 9 });
    assert.equal(a.branch, false);
    assert.throws(() => parseArgs("--max nope"));
    assert.throws(() => parseArgs("--wat"));
    assert.throws(() => tokenize(`"open`));
  });
  test("DEFAULT_LIMITS is frozen", () => assert.ok(Object.isFrozen(DEFAULT_LIMITS)));
});
