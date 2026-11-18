import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/convert.mjs', import.meta.url));

test('CLI converts Celsius to Fahrenheit', () => {
  const result = spawnSync(process.execPath, [cli, '--to-f', '100'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '212\n');
  assert.equal(result.stderr, '');
});

test('CLI converts Fahrenheit to Celsius', () => {
  const result = spawnSync(process.execPath, [cli, '--to-c', '32'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0\n');
  assert.equal(result.stderr, '');
});

test('CLI prints usage and fails when the flag is missing', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage: /);
});

test('CLI prints usage and fails for an unknown flag', () => {
  const result = spawnSync(process.execPath, [cli, '--unknown', '100'], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage: /);
});
