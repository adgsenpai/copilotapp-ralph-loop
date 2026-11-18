import assert from "node:assert/strict";
import test from "node:test";
import { cToF, fToC } from "../src/convert.mjs";

test("cToF converts Celsius to Fahrenheit", () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(100), 212);
  assert.equal(cToF(-40), -40);
  assert.equal(cToF(32), 89.6);
});

test("fToC converts Fahrenheit to Celsius", () => {
  assert.equal(fToC(0), -17.77777777777778);
  assert.equal(fToC(100), 37.77777777777778);
  assert.equal(fToC(-40), -40);
  assert.equal(fToC(32), 0);
});
