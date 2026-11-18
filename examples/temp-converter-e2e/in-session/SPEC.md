# Temperature converter (toy app for the Ralph loop E2E)

Build a tiny Node.js (ES modules, no dependencies) temperature converter.

1. `src/convert.mjs` exports `cToF(c)` and `fToC(f)` (numbers in, numbers out; fToC(32) === 0, cToF(100) === 212).
2. `test/convert.test.mjs` uses `node:test` and `node:assert` to cover both functions, including 0, 100, -40 and 32.
3. A CLI `bin/convert.mjs`: `node bin/convert.mjs --to-f 100` prints `212`; `node bin/convert.mjs --to-c 32` prints `0`; with no/unknown flag it prints usage to stderr and exits 1. Add a test for the CLI in `test/cli.test.mjs`.

Verification command: `npm test` (runs `node --test`).
