# Ralph Loop for GitHub Copilot

Autonomous, spec-driven coding loops (the [Ralph technique](docs/phase0-verification.md)) for **Copilot CLI** and the **Copilot app**, packaged as one **Agent Plugins 1.0** plugin.

Write a spec. Ralph turns it into small verifiable stories (`.ralph/prd.json`). Then it re-runs Copilot, one story per iteration, until every story passes **and** the controller's own verification command exits 0, or a hard limit stops it.

```
plugins/ralph-loop/
  plugin.json                       Agent Plugins 1.0 manifest
  mcp.json                          ralph-loop MCP server (portable)
  skills/ralph-prd, skills/ralph-loop
  com.github.copilot/
    hooks/hooks.json, stop-hook.mjs agentStop -> in-session loop controller
    extensions/ralph/extension.mjs  /ralph-start|stop|status|resume, ralph_* tools, token metering
    agents/ralph-worker, ralph-reviewer
    commands/ralph-start.md
  runner/ralph.mjs                  fresh-context runner (new copilot process per iteration)
  mcp/server.mjs                    zero-dependency MCP server
  lib/core.mjs                      shared state machine (used by all of the above)
```

## Install

```sh
copilot plugin marketplace add adgsenpai/copilotapp-ralph-loop   # or a local path to this repo
copilot plugin install ralph-loop@adgstudios-ralph
```

For development, load it straight from disk: `copilot --plugin-dir ./plugins/ralph-loop --experimental`.

## Use

**In-session** (the `agentStop` hook keeps one Copilot session going):

```text
/ralph-start SPEC.md --max 20 --budget 2000000 --verify "npm test"
/ralph-status    /ralph-stop    /ralph-resume
```

Without the experimental extension, run `node plugins/ralph-loop/runner/ralph.mjs init SPEC.md --verify "npm test"` and paste the prompt it prints, or use `/ralph-loop:ralph-start`, which goes through the MCP server.

**Fresh context** (Huntley's original form: a new `copilot -p` process for every iteration):

```sh
node plugins/ralph-loop/runner/ralph.mjs run SPEC.md --max 20 --verify "npm test" [--model M] [--review]
node plugins/ralph-loop/runner/ralph.mjs run SPEC.md --dry-run      # plan and first prompt only
node plugins/ralph-loop/runner/ralph.mjs status | stop | resume
```

A spec can be Markdown, in which case the first iteration runs the `ralph-prd` skill to write `prd.json`. It can also be a ready `prd.json`: `[{id, title, acceptance[], passes:false, priority?}]`.

## Safety

| Control | Default |
|---|---|
| Max iterations | 20 |
| Token budget (from `assistant.usage` / `--usage-output-file`) | 2,000,000 |
| Wall clock | 120 min |
| Stuck: identical failing verification | 3× |
| Stuck: no change to the working tree | 3 iterations |
| Limits immutable to the agent | SHA-256 checksum; any change stops the loop with `tampered` |
| Completion | requires all stories `passes:true` **and** the controller's verify command exits 0. The agent's claim alone is never enough. An optional reviewer gate is available (`--review`). |
| Git | works on a new `ralph/<timestamp>` branch. The runner denies `git push`, `reset --hard` and `branch -D`. |
| Telemetry | local only: `.ralph/metrics.jsonl` records every decision with a reason code |

`.ralph/` is git-ignored except `prd.json` and `progress.md`.

## Tests

```sh
npm test                                              # 65 unit, hook-contract, runner, MCP and manifest tests (no network)
node plugins/ralph-loop/tests/e2e/copilot-e2e.mjs fresh       # REAL Copilot builds a toy app, fresh-context mode
node plugins/ralph-loop/tests/e2e/copilot-e2e.mjs in-session  # REAL Copilot, agentStop-driven
node plugins/ralph-loop/tests/e2e/copilot-e2e.mjs extension   # plugin extension tool reachable
```

The E2E builds a temperature-converter CLI (functions, tests, CLI flags) in a throwaway repo. An independent oracle then checks that the app actually works. It does not trust the loop's own claims.

See [docs/phase0-verification.md](docs/phase0-verification.md) for what was verified against Copilot CLI 1.0.114, the deviations from the spec, and what is still open.

## Publishing

Nothing has been published. The spec's §12 channels (self-hosted marketplace, Awesome Copilot, MCP Registry, optional VS Marketplace) all need the owner's accounts and an explicit go-ahead.

MIT © ADGSTUDIOS (PTY) LTD
