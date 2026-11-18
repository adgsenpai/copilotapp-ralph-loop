import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TESTS = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(TESTS, "..");
export const HOOK = join(ROOT, "com.github.copilot/hooks/stop-hook.mjs");
export const RUNNER = join(ROOT, "runner/ralph.mjs");
export const MCP = join(ROOT, "mcp/server.mjs");
export const FAKE_COPILOT = join(TESTS, "fixtures/fake-copilot.mjs");

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** A temp git repo with a passing (or failing) verification command. */
export function tempRepo({ files = {}, verify = "node -e \"process.exit(0)\"" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ralph-test-"));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "ralph@example.invalid"]);
  sh(dir, "git", ["config", "user.name", "Ralph Test"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  for (const [f, c] of Object.entries({ "README.md": "# toy\n", ...files })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
  return { dir, verify };
}

export function story(id, passes = false, extra = {}) {
  return { id, title: `Story ${id}`, acceptance: [`${id} works`], passes, ...extra };
}

export function writePrdFile(dir, stories, name = "prd-input.json") {
  const f = join(dir, name);
  writeFileSync(f, JSON.stringify(stories, null, 2));
  return f;
}

export function readJsonFile(f) { return JSON.parse(readFileSync(f, "utf8")); }

export function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...process.env, RALPH_RUNNER: "", ...env } });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

export function hookPayload(cwd, extra = {}) {
  return { sessionId: "test-session", timestamp: Date.now(), cwd, transcriptPath: join(cwd, "no-transcript.jsonl"), stopReason: "end_turn", stop_hook_active: false, ...extra };
}
