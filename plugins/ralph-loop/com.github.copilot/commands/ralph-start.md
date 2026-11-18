---
description: Start a Ralph loop from a spec or prd.json (portable path via the ralph-loop MCP server)
---

Start a Ralph loop with these arguments: $ARGUMENTS

1. Parse the arguments as `<spec-or-prd-path> [--max N] [--budget TOKENS] [--minutes M] [--verify "cmd"]`.
2. Call the `ralph_init` tool of the ralph-loop MCP server with `source`, `maxIterations`, `maxTokens`, `maxMinutes` and `verifyCmd` from those arguments (omit any not given; `mode` = "in-session").
3. Report the branch and limits in one line.
4. Then begin iteration 1 following the ralph-loop skill's iteration contract (if `.ralph/prd.json` is empty, generate it with the ralph-prd skill first). The agentStop hook will continue the loop after you stop.
