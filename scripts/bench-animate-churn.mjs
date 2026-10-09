/** Массовый retarget через публичный animate: подготовка, кадры и полное завершение. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus, release } from 'node:os';

const roots = process.argv.slice(2).map(path => resolve(path));
assert.equal(roots.length, 2, 'node scripts/bench-animate-churn.mjs BASELINE_PACKAGE CANDIDATE_PACKAGE');
assert.equal(typeof process.threadCpuUsage, 'function', 'Измерение thread CPU требует Node с process.threadCpuUsage');
const profile = { counts: [1, 128, 1024, 4096], forms: ['group', 'individual'],
  retargets: 4, targetLifecyclesPerSample: 4096, warmupPairs: 3, pairs: 24,
  durationMs: 1000, firstFrameMs: 0, activeFrameMs: 250, finalFrameMs: 1500 };
function fingerprint(root) {
  const dist = join(root, 'dist');
  const digest = createHash('sha256');
  for (const entry of readdirSync(dist, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()) {
    digest.update(relative(dist, entry)); digest.update('\0'); digest.update(readFileSync(entry));
  }
  return { package: JSON.parse(readFileSync(join(root, 'package.json'))).version, distSha256: digest.digest('hex') };
}
const identities = roots.map(fingerprint);
const modules = await Promise.all(roots.map(async root => ({
  ...await import(pathToFileURL(join(root, 'dist/animate/index.js'))),
  ...await import(pathToFileURL(join(root, 'dist/frame/index.js'))),
})));

async function sample(module, count, form) {
  let pending = [], rafCalls = 0, writes = 0, natural = 0, settled = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const clock = callback => { pending.push(callback); rafCalls++; return rafCalls; };
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: clock });
  const tick = time => {
    const callbacks = pending; pending = [];
    assert.ok(callbacks.length <= 1, 'Движения должны разделять один кадр');
    for (const callback of callbacks) callback(time);
  };
  const runs = Math.ceil(profile.targetLifecyclesPerSample / count);
  const handlesPerRun = form === 'group' ? 1 : count;
  let retargetMs = 0;
  const start = performance.now(), cpuStart = process.threadCpuUsage();
  try {
    for (let run = 0; run < runs; run++) {
      const elements = Array.from({ length: count }, () => {
        let value = '0';
        return { style: {
          getPropertyValue: () => value,
          setProperty(name, next) { assert.equal(name, 'opacity'); value = next; writes++; },
        } };
      });
      const options = { duration: profile.durationMs, ease: t => t, onComplete: () => { natural++; } };
      const startMotion = target => {
        const targets = form === 'group' ? [elements] : elements;
        for (const element of targets) {
          module.animate(element, { opacity: target }, options).finished.then(() => { settled++; });
        }
      };
      startMotion(1);
      tick(profile.firstFrameMs); tick(profile.activeFrameMs);
      for (const element of elements) assert.equal(Number(element.style.getPropertyValue()), 0.25);
      const before = performance.now();
      for (let change = 0; change < profile.retargets; change++) startMotion(change % 2 ? 0.8 : 0.2);
      retargetMs += performance.now() - before;
      tick(profile.activeFrameMs); tick(profile.activeFrameMs + 500);
      for (const element of elements) assert.ok(Math.abs(Number(element.style.getPropertyValue()) - 0.525) < 1e-12);
      tick(profile.finalFrameMs);
      for (const element of elements) assert.equal(Number(element.style.getPropertyValue()), 0.8);
      tick(profile.finalFrameMs + 1000);
      assert.equal(pending.length, 0, 'После завершения кадры остаются в очереди');
    }
    for (let checkpoint = 0; checkpoint < 8; checkpoint++) await Promise.resolve();
    const cpu = process.threadCpuUsage(cpuStart);
    const elapsedMs = performance.now() - start;
    assert.equal(natural, runs * handlesPerRun);
    assert.equal(settled, runs * handlesPerRun * (profile.retargets + 1));
    assert.equal(pending.length, 0);
    assert.equal(writes, runs * count * 5);
    assert.equal(rafCalls, runs * 5);
    return { retargetNs: retargetMs * 1e6 / (runs * count * profile.retargets),
      lifecycleNs: elapsedMs * 1e6 / (runs * count),
      lifecycleCpuNs: (cpu.user + cpu.system) * 1000 / (runs * count),
      work: { targets: runs * count, natural, settled, writes, rafCalls } };
  } finally {
    module.frame.cancelAll();
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original);
    else delete globalThis.requestAnimationFrame;
  }
}
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
const results = [];
for (const count of profile.counts) for (const form of profile.forms) {
  for (let pair = 0; pair < profile.warmupPairs; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) await sample(modules[index], count, form);
  }
  const pairs = [];
  for (let pair = 0; pair < profile.pairs; pair++) {
    const values = [];
    for (const index of pair % 2 ? [1, 0] : [0, 1]) values[index] = await sample(modules[index], count, form);
    assert.deepEqual(values[0].work, values[1].work);
    pairs.push({ order: pair % 2 ? 'candidate-baseline' : 'baseline-candidate', baseline: values[0], candidate: values[1] });
  }
  results.push({ count, form, medians: Object.fromEntries(['retargetNs', 'lifecycleNs', 'lifecycleCpuNs'].map(metric => [metric, {
    baseline: median(pairs.map(pair => pair.baseline[metric])),
    candidate: median(pairs.map(pair => pair.candidate[metric])),
    pairedRatio: median(pairs.map(pair => pair.candidate[metric] / pair.baseline[metric])),
  }])), pairs });
}
assert.deepEqual(roots.map(fingerprint), identities, 'Сборки изменились во время замера');
console.log(JSON.stringify({ profile, node: process.version, v8: process.versions.v8,
  kernel: release(), cpu: cpus()[0]?.model, baseline: identities[0], candidate: identities[1], results }, null, 2));
