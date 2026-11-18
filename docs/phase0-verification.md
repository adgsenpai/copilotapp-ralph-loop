# Phase 0 — open items verified against the installed product

Verified on 2026-11-18 against **GitHub Copilot CLI 1.0.114** (Linux x64, Node 22). Each item from spec §14 was tested on the installed product, not assumed. The Copilot desktop app and cloud agent were **not** available for testing (see "Not verified").

| # | Open item (spec §14) | Result | How it was verified |
|---|---|---|---|
| 1 | Does the Copilot app fire `agentStop` with CLI semantics? | **Not verified (CLI only).** CLI: yes. | A probe hook in `.github/hooks/probe.json` returned `{"decision":"block","reason":"…"}` and `copilot -p` ran a second turn with that reason, even in non-interactive mode. Payload: `{sessionId, timestamp, cwd, transcriptPath, stopReason, stop_hook_active}`. |
| 2 | Can an extension send a prompt into a session? | **Yes:** `session.send({prompt})` / `sendAndWait`. | `copilot-sdk/session.d.ts` in the CLI's bundled SDK. `/ralph-start` and `/ralph-resume` use it to start iteration 1 directly. |
| 3 | On-disk discovery path for plugin-bundled extensions | **`<plugin>/com.github.copilot/extensions/<name>/extension.mjs`.** | E2E `extension` mode: Copilot called the plugin extension's `ralph_status` tool. CLI changelog: Agent Plugins spec plugins read `commands/ agents/ rules/ hooks/hooks.json lsp.json extensions/` **only** under `com.github.copilot/`. |
| 4 | Non-interactive flags, permissions, exit codes | `-p <prompt>`, `--allow-all-tools`, `--deny-tool 'shell(git push)'` (deny beats allow), `--no-ask-user`, `--usage-output-file <f>` (JSON with `modelMetrics[*].usage.{inputTokens,outputTokens}`), `--plugin-dir`, exits 0 on a completed turn. | `copilot --help`, plus real runs in the fresh-context E2E. |
| 5 | Plugin `hooks.json` schema | `{"version":1,"hooks":{"agentStop":[{"type":"command","bash":"…","powershell":"…","env":{…},"timeoutSec":N}]}}`; `${PLUGIN_ROOT}` is substituted in `env`. | Probe hook plus the bundled `browser-use` plugin. The in-session E2E ran this exact file. |
| 6 | Awesome Copilot post-approval update process | **Open:** needs the maintainers. | — |
| 7 | Extensions are experimental | Confirmed. The core loop (hook + skills + runner) does not depend on the extension. | `copilot help extensions`. |

## Findings that changed the build

1. **The CLI caps forced continuations at 8 consecutive `agentStop` blocks per turn** (CLI changelog). In-session mode therefore counts consecutive blocks and sets `needsKick`; the extension listens for `session.idle` and re-sends the iteration prompt. Without the extension, one turn runs at most 9 iterations. After that, `/ralph-resume` or any message continues the loop, or you can use fresh-context mode.
2. **Plugin `mcp.json` must carry a `$schema` field**, otherwise the CLI rejects it ("missing the required `$schema` field"). Found in `--log-level all` logs.
3. **`plugin.json` must not declare `skills` / `mcpServers`** (the CLI warns "unknown field … (ignored)"). Portable parts are found by convention: `skills/`, `mcp.json`.
4. **Marketplace manifests** are read from `marketplace.json`, `.github/plugin/marketplace.json` and `.claude-plugin/marketplace.json`. All three worked with `copilot plugin marketplace add <local path>` + `copilot plugin install ralph-loop@adgstudios-ralph` (tested with an isolated `COPILOT_HOME`).
5. **Plugin extensions load in `-p` mode** (project extensions do not, unless `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true`).
6. Running the project's tests from inside another `node --test` process leaks `NODE_TEST_CONTEXT`, which made a nested `node --test` report success falsely. The controller strips it before running the verification command.

## Spec deviations (deliberate)

- **MCP server is plain JavaScript with zero dependencies**, not TypeScript. This matches §10's supply-chain row (Node built-ins only) and needs no build step.
- **Extension SDK import** is `@microsoft/copilot-sdk/extension` (what CLI 1.0.114 injects), not `@github/copilot-sdk/extension` as in the spec's illustration. Options use the current shape: `tools: {definitions}`, `interaction: {commands}`.
- **Hooks live under `com.github.copilot/hooks/`**, as the spec's layout shows, and this is required by the current CLI.
- **Loop initialisation commits its bookkeeping** (`.gitignore`, `.ralph/prd.json`, `.ralph/progress.md`) as `ralph: initialise loop`, so the stuck detector starts from a clean baseline.

## Not verified (needs the owner / other surfaces)

- Copilot desktop app: `agentStop` semantics, extension loading, the Customize-tab install.
- Copilot cloud agent (hook-only): out of scope for v1.
- macOS and Windows: covered by the CI matrix in `.github/workflows/test.yml` (unit and contract tests). The real Copilot E2E was run on Linux only.
- FR-14 canvas view (Phase 4).
