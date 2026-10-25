import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [baseArgument, candidateArgument, output] = process.argv.slice(2);
assert.ok(baseArgument && candidateArgument && output, 'Нужны baseline, candidate и JSON-результат');
const roots = [baseArgument, candidateArgument].map(root => realpathSync(root));
assert.notEqual(roots[0], roots[1]);
const profile = { inputs: 4096, repeats: 32, warmups: 4, pairs: 32,
  curves: [[.2, 0, 0, 1], [.25, .1, .25, 1], [.42, 0, 1, 1], [0, 0, .58, 1],
    [.42, 0, .58, 1], [.1, -1, .8, 2], [0, 0, 0, 1], [1, 0, 1, 1], [1, 0, 0, 1]] };
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const identities = roots.map(root => ({
  revision: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  entrySha256: hash(join(root, 'dist/easing/index.js')),
}));
const factories = await Promise.all(roots.map(async root =>
  (await import(pathToFileURL(join(root, 'dist/easing/index.js')).href)).cubicBezier));
const inputs = Float64Array.from({ length: profile.inputs }, (_, i) => (i + .5) / profile.inputs);
const boundary = [NaN, -Infinity, Infinity, -1, -0, 0, Number.MIN_VALUE, Number.EPSILON,
  .5 - Number.EPSILON, .5, .5 + Number.EPSILON, 1 - Number.EPSILON, 1, 2];
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const results = [];
let observed = 0;
for (const coordinates of profile.curves) {
  const curves = factories.map(factory => factory(...coordinates));
  for (const input of [...inputs, ...boundary]) {
    assert.ok(Object.is(curves[0](input), curves[1](input)),
      'Изменилось значение кривой ' + coordinates + ' при ' + input);
  }
  const run = curve => {
    let sum = 0;
    for (let repeat = 0; repeat < profile.repeats; repeat++)
      for (const input of inputs) sum += curve(input);
    return sum;
  };
  for (let i = 0; i < profile.warmups; i++) {
    for (const index of i % 2 ? [1, 0] : [0, 1]) observed += run(curves[index]);
  }
  const samples = [];
  for (let pair = 0; pair < profile.pairs; pair++) {
    const order = (pair + Math.floor(pair / 2)) % 2 ? [1, 0] : [0, 1];
    const values = [];
    for (const index of order) {
      const start = performance.now();
      const checksum = run(curves[index]);
      const nsPerSample = (performance.now() - start) * 1e6 / (profile.inputs * profile.repeats);
      assert.ok(Number.isFinite(nsPerSample) && nsPerSample > 0);
      values[index] = { nsPerSample, checksum };
      observed += checksum;
    }
    assert.equal(values[0].checksum, values[1].checksum);
    samples.push({ order, baseline: values[0], candidate: values[1] });
  }
  const ratios = samples.map(pair => pair.baseline.nsPerSample / pair.candidate.nsPerSample);
  results.push({ coordinates, samples,
    baselineNs: quantile(samples.map(pair => pair.baseline.nsPerSample), .5),
    candidateNs: quantile(samples.map(pair => pair.candidate.nsPerSample), .5),
    pairedSpeedup: { p05: quantile(ratios, .05), p50: quantile(ratios, .5), p95: quantile(ratios, .95) } });
}
for (let i = 0; i < roots.length; i++)
  assert.equal(hash(join(roots[i], 'dist/easing/index.js')), identities[i].entrySha256);
const report = { schema: 1, profile, identities, runtime: { node: process.version, v8: process.versions.v8, cpu: cpus()[0]?.model },
  semantics: { exactSamplesPerCurve: inputs.length + boundary.length, exact: true }, observed, results };
writeFileSync(resolve(output), JSON.stringify(report));
console.table(results.map(({ coordinates, baselineNs, candidateNs, pairedSpeedup }) => ({
  curve: coordinates.join(','), baselineNs, candidateNs, speedup: pairedSpeedup.p50,
})));
