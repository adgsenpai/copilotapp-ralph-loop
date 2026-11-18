#!/usr/bin/env node
import { cToF, fToC } from "../src/convert.mjs";

const usage = "Usage: node bin/convert.mjs --to-f <celsius> | --to-c <fahrenheit>";
const [flag, input, ...extraArgs] = process.argv.slice(2);
const value = Number(input);

if (
  extraArgs.length > 0 ||
  !input?.trim() ||
  !Number.isFinite(value) ||
  (flag !== "--to-f" && flag !== "--to-c")
) {
  console.error(usage);
  process.exitCode = 1;
} else {
  console.log(flag === "--to-f" ? cToF(value) : fToC(value));
}
