# Changelog

## 0.1.0 — 2026-11-18 (unreleased)

First build against spec v1.0 draft.

- Agent Plugins 1.0 package `plugins/ralph-loop`: skills (`ralph-prd`, `ralph-loop`), MCP server, `agentStop` hook controller, CLI/app extension, `ralph-worker` / `ralph-reviewer` agents, `ralph-start` command.
- In-session loop (agentStop block) and fresh-context runner (`runner/ralph.mjs`) sharing one `.ralph/` state format.
- Hard limits: iterations (default 20), tokens, wall clock, stuck detector (identical failure / no change), checksummed limits.
- Dry run, reviewer gate, local-only metrics (`.ralph/metrics.jsonl`).
- Self-hosted marketplace manifests.
- Tests: 65 unit/contract/runner/MCP/manifest tests; real Copilot CLI E2E building a toy app in both modes.
