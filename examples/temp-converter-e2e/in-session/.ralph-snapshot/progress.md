# Ralph progress log

Append-only. Each iteration records what was done, learned and what failed.

## 2026-11-18T08:55:20.112Z
Implemented and verified cToF/fToC using the standard Celsius/Fahrenheit formulas; both required examples pass and `npm test` exits 0.

## 2026-11-18T08:56:04.637Z
Added node:test coverage for cToF and fToC at 0, 100, -40, and 32; tolerance-based assertions handle recurring decimal results. `npm test` passes.

## 2026-11-18T08:56:37.984Z
Added the --to-f/--to-c CLI with usage errors for missing or unknown flags, plus subprocess tests for conversions and errors. All six tests pass with `npm test`.
