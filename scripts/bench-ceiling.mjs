/**
 * Engine-only стенд: p50/p95/p99 массового старта и JS-кадра,
 * структурный rAF-фан-аут и алгоритмические hot-paths. Меряет собранный dist —
 * ровно тот код, который получает потребитель.
 *
 * Абсолютные наносекунды не являются CI-гейтом: они зависят от CPU/JIT/нагрева.
 * Жёсткий гейт здесь только машинонезависимый: N=1/100/1000 обязан давать один
 * native requestFrame на кадр; после cancel допустим ровно один уже queued drain,
 * но ни одной новой idle-заявки. p99 сравнивается
 * с бюджетами 120/240 Гц только как доля JS-engine работы: реальный DOM/style/
 * layout/paint здесь намеренно отсутствуют и проверяются browser-стендом.
 *
 * Запуск: pnpm bench:ceiling (dist пересобирается; checkout fingerprinted)
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import {
  assertCheckoutUnchanged,
  prepareBenchmarkCheckout,
} from '../bench/compare/provenance.mjs';
import {
  createBenchClock,
  interiorUnit,
  MASS_LIFECYCLE_PROFILE,
  runMassLifecycleSample,
  summarizeDistribution,
} from './bench-support.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (path) => pathToFileURL(resolve(ROOT, path)).href;

const provenance = prepareBenchmarkCheckout({
  root: ROOT,
  benchDirectory: ROOT,
  requireClean: false,
  requiredDist: [
    'dist/animate/index.js',
    'dist/animate/mini/index.js',
    'dist/utils/index.js',
    'dist/gestures/index.js',
  ],
});

const [{ animate: animateFull }, { animate: animateMini }, utils, gestures] =
  await Promise.all([
    import(dist('dist/animate/index.js')),
    import(dist('dist/animate/mini/index.js')),
    import(dist('dist/utils/index.js')),
    import(dist('dist/gestures/index.js')),
  ]);

const LINEAR = (t) => t;
const MASS_LIFECYCLE_RUNS = 120;
const MASS_LIFECYCLE_WARMUP_RUNS = 2;

const makeClock = createBenchClock;

// Один immutable/no-op style-шов не зашумляет engine-метрику тысячами Map и
// замыканий фейкового DOM. Цели остаются отдельными объектами/WeakMap-ключами.
const FAKE_STYLE = {
  getPropertyValue: () => '',
  setProperty: () => {},
};
function fakeTargets(count) {
  return Array.from({ length: count }, () => ({ style: FAKE_STYLE }));
}

/** Несколько вызовов и оба entry обязаны делить один package-level frame. */
function assertCrossEntryFanout() {
  const clock = makeClock();
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = clock.requestFrame;
  try {
    const full = animateFull(fakeTargets(1), { x: [0, 240] }, { duration: 1_000_000, ease: LINEAR });
    const mini = animateMini(fakeTargets(1), { x: [0, 240] }, { duration: 1_000_000, ease: LINEAR });
    if (clock.requests !== 1) throw new Error(`cross-entry: создано ${clock.requests} rAF вместо 1`);
    clock.step(16);
    if (clock.requests !== 2) throw new Error('cross-entry: кадр не сохранил единый rAF');
    full.cancel();
    mini.cancel();
    const executions = clock.executions;
    clock.step(32);
    if (clock.requests !== 2 || clock.executions !== executions + 1) {
      throw new Error('cross-entry: после cancel ожидался один queued drain без повторной заявки');
    }
  } finally {
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
  }
}

assertCrossEntryFanout();

const massRows = [];
let massChecksum = 0;
const massScenarios = [];
for (const [label, animate] of [['full', animateFull], ['mini', animateMini]]) {
  for (const motion of ['tween', 'spring']) {
    for (const count of MASS_LIFECYCLE_PROFILE.counts) {
      massScenarios.push({ id: `${label}-${motion}-${count}`, label, animate, motion, count });
    }
  }
}
const rawMass = Object.fromEntries(massScenarios.map((scenario) => [scenario.id, []]));
for (let warmup = 0; warmup < MASS_LIFECYCLE_WARMUP_RUNS; warmup++) {
  for (const scenario of massScenarios) {
    await runMassLifecycleSample(scenario);
  }
}
for (let run = 0; run < MASS_LIFECYCLE_RUNS; run++) {
  // Циклический сдвиг проводит каждый сценарий через каждую тепловую позицию.
  for (let position = 0; position < massScenarios.length; position++) {
    const scenario = massScenarios[(run + position) % massScenarios.length];
    const sample = await runMassLifecycleSample(scenario);
    rawMass[scenario.id].push({ run, ...sample });
    massChecksum +=
      sample.semantic.traceHashes.reduce((sum, hash) => sum + Number.parseInt(hash, 16), 0) +
      Number.parseInt(sample.semantic.lastValueHash, 16) +
      sample.semantic.totalWrites +
      sample.semantic.requests +
      sample.semantic.executions;
  }
}
for (const scenario of massScenarios) {
  const raw = rawMass[scenario.id];
  massRows.push({
    ...scenario,
    raw,
    start: summarizeDistribution(raw.map((sample) => sample.startNs)),
    frames60: summarizeDistribution(raw.map((sample) => sample.frames60Ns)),
    teardown: summarizeDistribution(raw.map((sample) => sample.teardownNs)),
  });
}

/** Черезput-бенч без хрупкого гейта: медиана батчей после JIT-прогрева. */
function measureHot(fn, iters, runs = 7) {
  let sink = 0;
  for (let i = 0; i < iters; i++) sink += fn(i);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const before = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) sink += fn(i);
    samples.push(Number(process.hrtime.bigint() - before) / iters);
  }
  samples.sort((a, b) => a - b);
  return { ns: samples[samples.length >> 1], sink };
}

const stops = Array.from({ length: 1000 }, (_, i) => i / 999);
const values = stops.map((x) => Math.sin(x * Math.PI * 4));
const interpolate1000 = utils.interpolate(stops, values);
const hotBaseline = measureHot((i) => i & 1, 200_000);
const largeInterpolate = measureHot((i) => interpolate1000(interiorUnit(i + 1)), 200_000);

const tracker = gestures.createVelocityTracker(0.1);
let trackerSample = 0;
const highRateTracker = measureHot(() => {
  const i = trackerSample++;
  tracker.push({ x: i, y: i * 0.5, t: i / 8000 });
  return i & 1023 ? 0 : tracker.velocity().vx;
}, 200_000);

const fmt = (ns) =>
  ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(0)} ns`;
const share240 = (ns) => `${((ns / 1e6 / (1000 / 240)) * 100).toFixed(1)}%`;

const output = [];
const line = (value = '') => output.push(value);
line('\nlab-motion — engine-only performance profile (fresh dist)\n');
line(`  checkout ${provenance.revisionLabel}; worktree ${provenance.worktreeSha256}; dist ${provenance.distRuntime.sha256}`);
line(`  ${os.cpus()[0]?.model?.trim() ?? 'unknown CPU'}; ${process.version}; pnpm ${provenance.environment.pnpm}`);
line('  массовый путь'.padEnd(25) + 'p50'.padStart(12) + 'p95'.padStart(12) + 'p99'.padStart(12) + '240 Гц'.padStart(10));
line('  ' + '-'.repeat(69));
for (const row of massRows) {
  for (const [kind, result] of [
    ['start', row.start],
    ['frames-60', row.frames60],
    ['teardown', row.teardown],
  ]) {
    const name = `${row.label} ${row.motion} ${kind} N=${row.count}`;
    const budget = kind === 'frames-60' ? share240(result.p99 / MASS_LIFECYCLE_PROFILE.frames) : '-';
    line(
      '  ' + name.padEnd(36) + fmt(result.p50).padStart(12) + fmt(result.p95).padStart(12) +
        fmt(result.p99).padStart(12) + budget.padStart(10),
    );
  }
}

line('\n  структурный гейт: full/mini/cross-entry — 1 rAF/кадр; cancel: 1 queued drain, 0 повторных заявок ✓');
line(`  mass methodology: N=1/100/1000 × tween/spring; ${MASS_LIFECYCLE_RUNS} paired lifecycle clusters; start + 60 frames + teardown p50/p95/p99`);
line(`  raw paired clusters: ${JSON.stringify(rawMass)}`);
line(`  interpolate 1000 стопов: ${fmt(largeInterpolate.ns)}/запрос`);
line(`  velocity window @ 8 kHz: ${fmt(highRateTracker.ns)}/push`);
line(`  empty-loop baseline: ${fmt(hotBaseline.ns)}/итерацию`);
line(`  бюджеты кадра: 120 Гц ${(1000 / 120).toFixed(2)} ms; 240 Гц ${(1000 / 240).toFixed(2)} ms`);
line('  240 Гц — справочная доля synthetic JS-engine времени, без DOM/render.');
line(`  checksum mass=${massChecksum}; sink: ${Number.isFinite(massChecksum + hotBaseline.sink + largeInterpolate.sink + highRateTracker.sink) ? 'ok' : 'NaN'}\n`);

assertCheckoutUnchanged(ROOT, provenance);
process.stdout.write(output.join('\n') + '\n');
