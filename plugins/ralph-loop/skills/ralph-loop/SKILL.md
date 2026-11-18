---
name: ralph-loop
description: How to run, steer and stop a Ralph loop (autonomous spec-driven implement-verify-commit iterations) in Copilot, including the per-iteration contract the agent must follow.
---

# ralph-loop

A Ralph loop re-runs the agent against the same spec until every story in `.ralph/prd.json` passes **and** the controller's own verification command exits 0. State lives in files and git, never in conversation memory.

## Modes

| Mode | Start | How it continues |
|---|---|---|
| In-session | `/ralph-start <spec-or-prd> [--max N] [--budget TOKENS] [--verify "cmd"]` (extension) or `/ralph-loop:ralph-start` (command + MCP) | the `agentStop` hook blocks the stop and feeds the next-iteration prompt |
| Fresh-context | `node <plugin>/runner/ralph.mjs run <spec-or-prd> ...` | a new `copilot -p` process per iteration |

Steer with `/ralph-status`, `/ralph-stop`, `/ralph-resume` (or the `ralph_status` tool). Edit `.ralph/prompt.md` to change the per-iteration instructions; edit `.ralph/prd.json` to add/reorder stories.

## Limits (always finite)

Defaults: 20 iterations, 2,000,000 tokens, 120 minutes, stuck after 3 identical verification failures or 3 iterations with no git change. Limits are fixed at start and checksummed; changing them stops the loop with `tampered`.

## Iteration contract (what the agent does each turn)

1. Read `AGENTS.md`, `.ralph/prd.json`, `.ralph/progress.md`, and `git log --oneline -10`.
2. Pick the single highest-priority story with `"passes": false`.
3. Implement only that story; run the verification command.
4. Green → set `"passes": true`, append learnings to `.ralph/progress.md` (or call `ralph_log_learning`), commit `ralph: <id> <title>`.
   Red → do not mark done; record what failed in `.ralph/progress.md`.
5. Stop. Never edit `.ralph/state.json`, `.ralph/usage.json` or limits. Never force-push or delete branches.

When everything passes, end the reply with `<promise>RALPH_COMPLETE</promise>`; the controller still re-verifies independently.

## Stop reasons

`complete`, `max_iterations`, `budget`, `timeout`, `stuck`, `stopped` (user), `tampered`, `error`. Every decision is logged with its reason code in `.ralph/metrics.jsonl`.
