---
name: ralph-prd
description: Convert a natural-language spec into .ralph/prd.json — an ordered list of small, individually verifiable user stories with machine-checkable acceptance criteria — for a Ralph loop.
---

# ralph-prd: spec → prd.json

Use this when a Ralph loop has a spec (usually `.ralph/spec.md`) but `.ralph/prd.json` is empty, or when the user asks to plan a Ralph run.

## Output format

Write `.ralph/prd.json` as a JSON array:

```json
[
  {
    "id": "S1",
    "title": "Add add(a, b) to src/math.js",
    "priority": 1,
    "acceptance": [
      "src/math.js exports add(a, b) returning a + b",
      "npm test exits 0"
    ],
    "passes": false
  }
]
```

Rules:

1. **Small stories.** Each story must be completable and verifiable in one agent iteration (one context window). If a story needs more than ~1 file of new logic or more than ~150 lines, split it. Refuse to emit a story that is too large — split it instead.
2. **Ordered.** `priority` ascending = do first. Order by dependency: foundations (scaffolding, test harness) before features that rely on them.
3. **Verifiable.** Every acceptance criterion must be checkable by a command or by reading a specific file — no "works well" or "is clean". Include the project's verification command (from AGENTS.md, e.g. `npm test`) as a criterion where relevant.
4. **All `passes: false`.** Never pre-mark a story as done.
5. Unique string `id`s (`S1`, `S2`, ...). Non-empty `title` and `acceptance`.
6. If there is no `AGENTS.md`, create one at the repo root listing the build and test commands the loop should use.

After writing, validate the JSON parses, append a one-line note to `.ralph/progress.md` ("PRD generated: N stories"), then stop. Do not implement stories in the same iteration.
