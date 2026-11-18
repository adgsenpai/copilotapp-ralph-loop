// Packaging checks: the Agent Plugins 1.0 layout and the formats the installed
// Copilot CLI (1.0.114) was observed to require during Phase 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.mjs";

const json = (f) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
const REPO = join(ROOT, "../..");

test("plugin.json: Agent Plugins 1.0 manifest with only known fields", () => {
  const m = json("plugin.json");
  assert.equal(m.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(m.name, "ralph-loop");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(m.license, "MIT");
  assert.ok(m.keywords.every((k) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k)), "lowercase hyphenated keywords");
  // The CLI warns on (and ignores) these; portable parts are found by convention.
  for (const k of ["skills", "mcpServers", "hooks", "agents", "commands"]) assert.equal(m[k], undefined, k);
  assert.equal(json("package.json").version, m.version, "package.json and plugin.json versions match");
});

test("mcp.json: has the required $schema and a stdio ralph-loop server", () => {
  const m = json("mcp.json");
  assert.ok(m.$schema, "CLI rejects plugin mcp.json without $schema");
  assert.equal(m.mcpServers["ralph-loop"].type, "stdio");
  assert.ok(m.mcpServers["ralph-loop"].args[0].startsWith("${PLUGIN_ROOT}/"));
});

test("hooks.json: version 1, agentStop command for bash and powershell", () => {
  const h = json("com.github.copilot/hooks/hooks.json");
  assert.equal(h.version, 1);
  const [stop] = h.hooks.agentStop;
  assert.equal(stop.type, "command");
  assert.match(stop.bash, /stop-hook\.mjs/);
  assert.match(stop.powershell, /stop-hook\.mjs/);
  assert.equal(stop.env.RALPH_PLUGIN_ROOT, "${PLUGIN_ROOT}");
  assert.ok(stop.timeoutSec > 0);
});

test("Copilot-specific parts live under com.github.copilot/", () => {
  for (const f of ["com.github.copilot/extensions/ralph/extension.mjs", "com.github.copilot/hooks/stop-hook.mjs",
    "com.github.copilot/agents/ralph-worker.agent.md", "com.github.copilot/agents/ralph-reviewer.agent.md", "com.github.copilot/commands/ralph-start.md"])
    assert.ok(existsSync(join(ROOT, f)), f);
});

test("skills and agents have name/description frontmatter", () => {
  const fm = (f) => {
    const m = readFileSync(join(ROOT, f), "utf8").match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${f} has frontmatter`);
    return m[1];
  };
  for (const d of readdirSync(join(ROOT, "skills"))) {
    const f = fm(`skills/${d}/SKILL.md`);
    assert.match(f, new RegExp(`^name: ${d}$`, "m"));
    assert.match(f, /^description: .{20,}/m);
  }
  for (const a of ["ralph-worker", "ralph-reviewer"]) {
    const f = fm(`com.github.copilot/agents/${a}.agent.md`);
    assert.match(f, new RegExp(`^name: ${a}$`, "m"));
  }
  assert.doesNotMatch(fm("com.github.copilot/agents/ralph-reviewer.agent.md"), /"edit"/, "reviewer is read-only");
});

test("hook and core use Node built-ins only (no dependencies)", () => {
  for (const f of ["lib/core.mjs", "lib/args.mjs", "com.github.copilot/hooks/stop-hook.mjs", "runner/ralph.mjs", "mcp/server.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const [, spec] of src.matchAll(/from\s+"([^"]+)"/g)) assert.ok(spec.startsWith("node:") || spec.startsWith("."), `${f} imports ${spec}`);
  }
  assert.equal(json("package.json").dependencies, undefined);
});

test("marketplace.json lists the plugin in every location Copilot reads", () => {
  for (const f of ["marketplace.json", ".github/plugin/marketplace.json", ".claude-plugin/marketplace.json"]) {
    const m = JSON.parse(readFileSync(join(REPO, f), "utf8"));
    const p = m.plugins.find((x) => x.name === "ralph-loop");
    assert.ok(p, f);
    assert.equal(p.source, "./plugins/ralph-loop");
    assert.equal(p.version, json("plugin.json").version);
  }
});
