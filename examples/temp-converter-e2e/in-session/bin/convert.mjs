import { cToF, fToC } from '../src/convert.mjs';

const usage = 'Usage: node bin/convert.mjs --to-f <celsius> | --to-c <fahrenheit>';
const args = process.argv.slice(2);
const [flag, value] = args;
const input = Number(value);

if (args.length !== 2 || !Number.isFinite(input)) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
} else if (flag === '--to-f') {
  process.stdout.write(`${cToF(input)}\n`);
} else if (flag === '--to-c') {
  process.stdout.write(`${fToC(input)}\n`);
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
}
