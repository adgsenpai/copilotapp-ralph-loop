import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../bin/convert.mjs", import.meta.url);

function runCli(...args) {
  return spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });
}

test("CLI converts Celsius to Fahrenheit", () => {
  const result = runCli("--to-f", "100");

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "212");
  assert.equal(result.stderr, "");
});

test("CLI converts Fahrenheit to Celsius", () => {
  const result = runCli("--to-c", "32");

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "0");
  assert.equal(result.stderr, "");
});

test("CLI prints usage and exits unsuccessfully for missing or unknown flags", () => {
  for (const args of [[], ["--unknown", "100"]]) {
    const result = runCli(...args);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage:/);
  }
});
