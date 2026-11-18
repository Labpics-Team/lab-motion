import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Stryker from '@stryker-mutator/core';

const project = fileURLToPath(new URL('../../', import.meta.url));
const directory = process.argv[2];
assert.ok(directory, 'The caller owns and cleans the isolated fixture directory');
const started = performance.now();

await symlink(join(project, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
await writeFile(join(directory, 'subject.js'), [
  'export function nested(value) { return value + 1; }',
  'export function padded(value) { return value + 2; }',
  'export function anonymous(value) { return value + 3; }',
  'export function weak(left, right) { return left + right; }',
  '',
].join('\n'));
await writeFile(join(directory, 'selection.spec.js'), `
import { describe, expect, it } from 'vitest';
import { nested, padded, anonymous, weak } from './subject.js';

describe('driver [coverage]', () => {
describe('nested (suite) | ^ $', () => {
  it('selects the actual nested test', () => expect(nested(1)).toBe(2));
});
});
it('  retains boundary whitespace  ', () => expect(padded(1)).toBe(3));
describe('', () => {
it('retains the anonymous suite boundary', () => expect(anonymous(1)).toBe(4));
});
it('selected prefix', () => expect(weak(0, 0)).toBe(0));
it('selected prefix extra', () => expect(2 + 2).toBe(4));
`);
await writeFile(join(directory, 'vitest.config.mjs'), `
export default {
test: { include: ['selection.spec.js'], environment: 'node' },
};
`);
process.chdir(directory);
await new Stryker({
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.mjs' },
  mutate: ['subject.js'],
  coverageAnalysis: 'perTest',
  reporters: ['json'],
  jsonReporter: { fileName: 'mutation.json' },
  concurrency: 1,
  cleanTempDir: 'always',
  logLevel: 'off',
  // The weak control must survive; the product's 80% driver threshold is separate.
  thresholds: { break: 0 },
}).runMutationTest();
const report = JSON.parse(await readFile('mutation.json', 'utf8'));
// These fields are part of mutation-testing-report-schema, not runner internals.
const arithmetic = report.files['subject.js'].mutants.filter((mutant) => mutant.mutatorName === 'ArithmeticOperator');
assert.equal(arithmetic.length, 4);
const byLine = new Map(arithmetic.map((mutant) => [mutant.location.start.line, mutant]));
const observed = [];
for (const line of [1, 2, 3, 4]) {
  const mutant = byLine.get(line);
  assert.ok(mutant, 'Every fixture function must be instrumented');
  observed.push({ line, status: mutant.status, coveredBy: mutant.coveredBy, killedBy: mutant.killedBy, testsCompleted: mutant.testsCompleted });
}
console.log(JSON.stringify({ seconds: (performance.now() - started) / 1000, observed }));
for (const [index, mutant] of observed.entries()) {
  assert.equal(mutant.status, index === 3 ? 'Survived' : 'Killed');
  assert.equal(mutant.coveredBy?.length, 1);
  assert.equal(mutant.testsCompleted, 1);
  if (index < 3) {
    assert.equal(mutant.killedBy?.length, 1);
    assert.ok(mutant.coveredBy.includes(mutant.killedBy[0]));
  }
}
assert.equal(new Set(observed.flatMap((mutant) => mutant.coveredBy)).size, 4);
