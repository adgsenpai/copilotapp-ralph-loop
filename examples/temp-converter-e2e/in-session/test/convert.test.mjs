import assert from 'node:assert/strict';
import test from 'node:test';
import { cToF, fToC } from '../src/convert.mjs';

test('cToF converts representative Celsius values', () => {
  for (const [celsius, fahrenheit] of [
    [0, 32],
    [100, 212],
    [-40, -40],
    [32, 89.6],
  ]) {
    assert.ok(
      Math.abs(cToF(celsius) - fahrenheit) < 1e-10,
      `${celsius} C should convert to ${fahrenheit} F`,
    );
  }
});

test('fToC converts representative Fahrenheit values', () => {
  for (const [fahrenheit, celsius] of [
    [0, -17.7777777778],
    [100, 37.7777777778],
    [-40, -40],
    [32, 0],
  ]) {
    assert.ok(
      Math.abs(fToC(fahrenheit) - celsius) < 1e-10,
      `${fahrenheit} F should convert to ${celsius} C`,
    );
  }
});
