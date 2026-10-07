/** Парное измерение привязки через собранные публичные входы; результат в stdout. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';

const [baselinePath, candidatePath] = process.argv.slice(2);
assert.ok(baselinePath && candidatePath, 'node scripts/bench-bindings-pair.mjs BASELINE_PACKAGE CANDIDATE_PACKAGE');
assert.equal(typeof process.threadCpuUsage, 'function', 'Для thread CPU требуется Node.js с process.threadCpuUsage');
const profile = Object.freeze({ roles: [1, 32], propertiesPerRole: 4,
  patterns: ['unchanged', 'one-role', 'all-roles'], changedProperties: ['x', 'opacity'], roleUpdatesPerBatch: 65_536, warmupPairs: 6, pairs: 40 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = [baselinePath, candidatePath].map(path => resolve(path));
const sources = paths.map(path => readFileSync(join(path, 'dist/bindings/index.js')));
const metadata = paths.map((path, i) => {
  const pkg = JSON.parse(readFileSync(join(path, 'package.json')));
  assert.equal(pkg.name, '@labpics/motion');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
  // Этот entry самодостаточен. Внешние imports требуют учёта их байтов в профиле.
  assert.ok(!/\b(?:import\s|from["'])/.test(sources[i].toString()), 'bindings entry должен быть самостоятельным');
  return { package: pkg.name, version: pkg.version, entrySha256: hash(sources[i]) };
});
const factories = await Promise.all(paths.map(async path =>
  (await import(pathToFileURL(join(path, 'dist/bindings/index.js')).href)).createMotionBinding));

function scenario(create, roles, pattern, changedKey) {
  const goals = Object.fromEntries(Array.from({ length: roles }, (_, i) =>
    ['role' + i, { x: i, y: 2, scale: 1, opacity: 1 }]));
  let calls = 0, checksum = 0, cancelled = 0;
  const handle = { cancel() { cancelled++; } };
  const targets = Object.fromEntries(Object.keys(goals).map(name => [name, goal => {
    calls++; checksum += goal.x + goal.y + goal.scale + goal.opacity;
    return handle;
  }]));
  const binding = create(model => model, targets);
  binding.update(goals);
  let step = 0;
  return {
    run() {
      for (let i = 0; i < profile.roleUpdatesPerBatch / roles; i++) {
        step++;
        if (pattern === 'one-role') goals['role' + (step % roles)][changedKey] = roles + step;
        else if (pattern === 'all-roles') {
          for (let role = 0; role < roles; role++) goals['role' + role][changedKey] = roles + step;
        }
        binding.update(goals);
      }
    },
    finish() {
      binding.destroy();
      const expected = roles + (pattern === 'unchanged' ? 0 : step * (pattern === 'all-roles' ? roles : 1));
      assert.equal(calls, expected, 'Количество полезных обновлений изменилось');
      assert.equal(cancelled, 1, 'Общий принятый handle отменяется один раз');
      return { calls, checksum, cancelled };
    },
  };
}
function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
function timed(action, calls) {
  const wall = performance.now();
  const before = process.threadCpuUsage();
  action();
  const cpu = process.threadCpuUsage(before);
  return { threadCpuNs: (cpu.user + cpu.system) * 1000 / calls,
    elapsedNs: (performance.now() - wall) * 1e6 / calls };
}
const results = [];
for (const roles of profile.roles) for (const pattern of profile.patterns)
  for (const changedKey of pattern === 'unchanged' ? ['x'] : profile.changedProperties) {
  const participants = factories.map(create => scenario(create, roles, pattern, changedKey));
  for (let i = 0; i < profile.warmupPairs; i++) {
    for (const index of i % 2 ? [1, 0] : [0, 1]) participants[index].run();
  }
  const pairs = [];
  for (let i = 0; i < profile.pairs; i++) {
    const samples = [];
    for (const index of i % 2 ? [1, 0] : [0, 1]) samples[index] = timed(() => participants[index].run(), profile.roleUpdatesPerBatch / roles);
    assert.ok(samples.every(sample => sample.threadCpuNs > 0 && sample.elapsedNs > 0));
    pairs.push({ order: i % 2 ? 'candidate-baseline' : 'baseline-candidate', baseline: samples[0], candidate: samples[1] });
  }
  const outcomes = participants.map(participant => participant.finish());
  assert.deepEqual(outcomes[1], outcomes[0]);
  const ratios = pairs.map(pair => pair.candidate.threadCpuNs / pair.baseline.threadCpuNs);
  results.push({ roles, pattern, changedProperty: pattern === 'unchanged' ? null : changedKey, outcomes: outcomes[0],
    medianThreadCpuNs: { baseline: quantile(pairs.map(pair => pair.baseline.threadCpuNs), 0.5),
      candidate: quantile(pairs.map(pair => pair.candidate.threadCpuNs), 0.5) },
    pairedRatio: { p05: quantile(ratios, 0.05), p50: quantile(ratios, 0.5), p95: quantile(ratios, 0.95) }, pairs });
}
for (let i = 0; i < paths.length; i++) {
  assert.equal(hash(readFileSync(join(paths[i], 'dist/bindings/index.js'))), metadata[i].entrySha256,
    'Измеряемый entry изменился во время прогона');
}
console.log(JSON.stringify({ schema: 1, profile,
  runtime: { node: process.version, v8: process.versions.v8, platform: platform(), kernel: release(), cpu: cpus()[0]?.model },
  participants: { baseline: metadata[0], candidate: metadata[1] }, results }, null, 2));
