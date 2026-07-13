/**
 * scripts/bench.mjs — микро/макро-бенчи горячих путей движка (dependency-free).
 *
 * Зачем: у пакета нет фикс-порогов рантайм-перфа (size-gate меряет ВЕС, не
 * скорость). Этот скрипт меряет РЕАЛЬНЫЕ горячие пути против собранного dist —
 * тот же артефакт, что шипится, — и печатает ns/операцию + ops/sec. Числа
 * стабилизируются warmup'ом (JIT прогревается) и медианой по нескольким сэмплам
 * (устойчива к GC-паузам). Sink-аккумулятор глушит dead-code-elimination V8.
 *
 * Запуск: pnpm bench (dist пересобирается; checkout/dist получают fingerprint)
 * Гейтом НЕ является (ns/op wall-clock машинозависимы) — сила seal'а в
 * test/perf-hot-path.test.ts: детерминированный инвариант работы (число кадров
 * до сходимости = вызовов солвера, машинонезависим). Здесь — справочные числа.
 *
 * Результаты — профиль текущей реализации, не вечный вердикт: оптимизация
 * принимается только после differential-паритета и повторного замера этого же
 * собранного артефакта. Машинозависимые числа не копируются в документацию.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  assertCheckoutUnchanged,
  prepareBenchmarkCheckout,
} from '../bench/compare/provenance.mjs';
import {
  assertBalancedRunBlocks,
  makeRoundRobinOrders,
} from '../bench/compare/methodology.mjs';
import {
  checksumTransformOutputs,
  createSeededTransformStates,
  createSeededUnitInputs,
  materializeTransformOutputs,
  reconstructedPartsBuildTransform,
  summarizeDistribution,
  TRANSFORM_FORMATTER_BENCH_PROFILE,
} from './bench-support.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const distUrl = (p) => pathToFileURL(resolve(pkgRoot, p)).href;

const provenance = prepareBenchmarkCheckout({
  root: pkgRoot,
  benchDirectory: pkgRoot,
  requireClean: false,
  requiredDist: [
    'dist/index.js',
    'dist/driver/index.js',
    'dist/utils/index.js',
    'dist/compositor/index.js',
    'dist/tokens/index.js',
    'dist/easing/index.js',
    'dist/value/index.js',
  ],
});

const { spring, drive, MotionValue } = await import(distUrl('dist/index.js'));
const { createDriver } = await import(distUrl('dist/driver/index.js'));
const utils = await import(distUrl('dist/utils/index.js'));
const compositor = await import(distUrl('dist/compositor/index.js'));
const tokenModule = await import(distUrl('dist/tokens/index.js'));
const easingModule = await import(distUrl('dist/easing/index.js'));
const valueModule = await import(distUrl('dist/value/index.js'));

/** Синхронные дренируемые часы: requestFrame копит cb, drain гоняет их без ts
 *  (→ solver двигается фикс-шагом FIXED_DT_S). Handle ненулевой — drive/MV не
 *  ставят setTimeout-фоллбек, прогон остаётся синхронным. */
function makeClock() {
  let queue = [];
  const requestFrame = (cb) => {
    queue.push(cb);
    return queue.length; // ненулевой handle
  };
  const drain = (cap = 100000) => {
    let n = 0;
    while (queue.length && n < cap) {
      const cb = queue.shift();
      cb();
      n++;
    }
    return n;
  };
  return { requestFrame, drain };
}

/**
 * Замер: median ns/op по `samples` сэмплам, в каждом — `iters` итераций.
 * Возвращает { nsPerOp, opsPerSec, sink }. `fn(i)` обязана возвращать число
 * (копится в sink → анти-DCE).
 */
function measure(fn, { iters, samples = 7, warmup = 2 }) {
  let sink = 0;
  for (let w = 0; w < warmup; w++) for (let i = 0; i < iters; i++) sink += fn(i);
  const times = [];
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) sink += fn(i);
    times.push((performance.now() - t0) * 1e6); // ns на сэмпл
  }
  times.sort((a, b) => a - b);
  const medNs = times[times.length >> 1];
  const nsPerOp = medNs / iters;
  return { nsPerOp, opsPerSec: 1e9 / nsPerOp, sink };
}

/**
 * Парный замер двух отгруженных реализаций на одной фиксированной выборке.
 * Полные циклические блоки гасят перекос позиции, контрольная сумма — DCE.
 */
function measureDefaultEasingPair() {
  const seed = 0x51f15e;
  const ids = ['tokens.standard', 'easing.cubicBezier'];
  const rounds = 22;
  const warmupRounds = 6;
  const repetitions = 8;
  const inputs = createSeededUnitInputs(65_536, seed);
  const participants = {
    'tokens.standard': tokenModule.easing.standard.fn,
    'easing.cubicBezier': easingModule.cubicBezier(0.2, 0, 0, 1),
  };
  const evaluate = (fn) => {
    let sum = 0;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (let i = 0; i < inputs.length; i++) sum += fn(inputs[i]);
    }
    return sum;
  };

  assertBalancedRunBlocks('default easing warmup', warmupRounds, ids.length);
  for (const order of makeRoundRobinOrders(ids, warmupRounds, seed ^ 0xa5a5a5)) {
    for (const id of order) evaluate(participants[id]);
  }

  assertBalancedRunBlocks('default easing publish', rounds, ids.length);
  const samples = Object.fromEntries(ids.map((id) => [id, []]));
  const checksums = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const order of makeRoundRobinOrders(ids, rounds, seed)) {
    for (const id of order) {
      const t0 = performance.now();
      checksums[id] += evaluate(participants[id]);
      samples[id].push(((performance.now() - t0) * 1e6) / (inputs.length * repetitions));
    }
  }
  const checksum = checksums['tokens.standard'] + checksums['easing.cubicBezier'];
  if (!Number.isFinite(checksum)) throw new Error('default easing benchmark: нечисловой checksum');

  const specialized = summarizeDistribution(samples['tokens.standard']);
  const generic = summarizeDistribution(samples['easing.cubicBezier']);
  return {
    seed,
    rounds,
    warmupRounds,
    repetitions,
    inputs: inputs.length,
    checksum,
    checksums,
    specialized,
    generic,
    ratio: {
      p50: generic.p50 / specialized.p50,
      p95: generic.p95 / specialized.p95,
    },
  };
}

/**
 * Парный formatter+materialization-бенч: один seeded набор, полные
 * position-balanced блоки, полное посимвольное чтение внутри тайминга и
 * отдельный provenance-checksum. Parts+join — реконструкция эквивалентного
 * алгоритма, не ранее опубликованный артефакт; current берётся из fresh dist.
 */
function measureTransformFormatterPair() {
  const {
    seed,
    inputs,
    repetitions,
    warmupRounds,
    rounds,
  } = TRANSFORM_FORMATTER_BENCH_PROFILE;
  const ids = ['parts-reconstruction', 'current-dist'];
  const states = createSeededTransformStates(inputs, seed);
  const participants = {
    'parts-reconstruction': reconstructedPartsBuildTransform,
    'current-dist': valueModule.buildTransform,
  };
  if (typeof participants['current-dist'] !== 'function') {
    throw new Error('transform formatter benchmark: dist/value не экспортирует buildTransform');
  }
  const evaluate = (formatter) =>
    materializeTransformOutputs(formatter, states, repetitions);

  const outputChecksums = Object.fromEntries(ids.map((id) => [
    id,
    checksumTransformOutputs(participants[id], states),
  ]));
  if (outputChecksums['parts-reconstruction'] !== outputChecksums['current-dist']) {
    throw new Error('transform formatter benchmark: reconstruction/current строки неэквивалентны');
  }

  assertBalancedRunBlocks('transform formatter warmup', warmupRounds, ids.length);
  for (const order of makeRoundRobinOrders(ids, warmupRounds, seed ^ 0xa5a5a5)) {
    for (const id of order) evaluate(participants[id]);
  }

  assertBalancedRunBlocks('transform formatter publish', rounds, ids.length);
  const samples = Object.fromEntries(ids.map((id) => [id, []]));
  const sinkChecksums = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const order of makeRoundRobinOrders(ids, rounds, seed)) {
    for (const id of order) {
      const started = performance.now();
      sinkChecksums[id] += evaluate(participants[id]);
      samples[id].push(
        ((performance.now() - started) * 1e6) / (states.length * repetitions),
      );
    }
  }
  if (
    !Number.isFinite(sinkChecksums['parts-reconstruction']) ||
    sinkChecksums['parts-reconstruction'] !== sinkChecksums['current-dist']
  ) {
    throw new Error('transform formatter benchmark: невалидный timed checksum');
  }

  const reconstruction = summarizeDistribution(samples['parts-reconstruction']);
  const current = summarizeDistribution(samples['current-dist']);
  return {
    seed,
    rounds,
    warmupRounds,
    repetitions,
    inputs: states.length,
    outputChecksum: outputChecksums['current-dist'],
    sinkChecksum: sinkChecksums['current-dist'],
    reconstruction,
    current,
    ratio: {
      p50: reconstruction.p50 / current.p50,
      p95: reconstruction.p95 / current.p95,
    },
    provenance: {
      reconstruction: 'scripts/bench-support.mjs#reconstructedPartsBuildTransform',
      current: 'dist/value/index.js#buildTransform',
    },
  };
}

const SPRING = { mass: 1, stiffness: 170, damping: 26 }; // типовой Framer-подобный

const results = [];
let sinkChecksum = 0; // потребляется в выводе → V8 не может DCE чистые микро-бенчи
function row(name, unit, { nsPerOp, opsPerSec, sink }) {
  sinkChecksum += sink;
  results.push({ name, unit, nsPerOp, opsPerSec });
}

// Контроль измерителя: для однозначных ns/op виден вклад пустого цикла+sink.
row('пустой loop/sink baseline', 'итерация', measure((i) => i & 1, {
  iters: 200000,
  samples: 9,
}));

// ── A. drive() полный прогон (макро: реальный per-frame путь + Promise/clamp) ──
{
  let frames = 0;
  const r = measure(
    () => {
      const clock = makeClock();
      let last = 0;
      drive({ from: 0, to: 100, spring: SPRING, onStep: (v) => (last = v), requestFrame: clock.requestFrame });
      frames = clock.drain();
      return last;
    },
    { iters: 2000, samples: 7 },
  );
  row(`drive() полный прогон (${frames} кадров, clamp=default)`, 'прогон', r);
}

// ── B. drive() clamp:false (честная пружина — длиннее хвост осцилляции) ──
{
  let frames = 0;
  const r = measure(
    () => {
      const clock = makeClock();
      let last = 0;
      drive({ from: 0, to: 100, spring: SPRING, clamp: false, onStep: (v) => (last = v), requestFrame: clock.requestFrame });
      frames = clock.drain();
      return last;
    },
    { iters: 1500, samples: 7 },
  );
  row(`drive() clamp:false (${frames} кадров)`, 'прогон', r);
}

// ── C. MotionValue прогон (макро: второй горячий цикл, v0-путь) ──
{
  let frames = 0;
  const r = measure(
    () => {
      const clock = makeClock();
      let last = 0;
      const mv = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
      mv.onChange((v) => (last = v));
      mv.setTarget(100);
      frames = clock.drain();
      mv.destroy();
      return last;
    },
    { iters: 2000, samples: 7 },
  );
  row(`MotionValue прогон (${frames} кадров)`, 'прогон', r);
}

// ── D. createDriver clamp:false (горячий путь: солвер+сходимость+эмит) ──
{
  let frames = 0;
  const r = measure(
    () => {
      const clock = makeClock();
      let last = 0;
      createDriver({
        from: 0,
        to: 100,
        spring: SPRING,
        clamp: false,
        onStep: (v) => (last = v),
        requestFrame: clock.requestFrame,
      });
      frames = clock.drain();
      return last;
    },
    { iters: 1500, samples: 7 },
  );
  row(`createDriver clamp:false (${frames} кадров)`, 'прогон', r);
}

// ── E. spring() публичный (микро: solver + валидация на каждый вызов) ──
{
  const r = measure((i) => spring(SPRING, (i % 2000) * (1 / 60)).value, {
    iters: 200000,
    samples: 9,
  });
  row('spring() публичный вызов (solver+validate)', 'вызов', r);
}

// ── F. utils.interpolate 5-стоп (новый субпуть) ──
{
  const f = utils.interpolate([0, 0.25, 0.5, 0.75, 1], [0, 40, 20, 90, 100]);
  const r = measure((i) => f((i % 1000) / 1000), { iters: 200000, samples: 9 });
  row('utils.interpolate 5-стоп запрос', 'запрос', r);
}

// ── G. compositor: холодная компиляция пружина → linear() (uncached) ──
// Изолированный кэш ёмкости 1 + чередование двух пружин → КАЖДЫЙ вызов промах
// (одна вытесняет другую), измеряется реальная стоимость компиляции (сетка+RDP).
{
  const springsF = [
    { mass: 1, stiffness: 170, damping: 26 },
    { mass: 1, stiffness: 180, damping: 8 },
  ];
  const c = compositor.createSpringLinearCache(1);
  const r = measure((i) => c.compile(springsF[i & 1]).length, { iters: 20000, samples: 7 });
  row('compositor.compileSpringLinear COLD (сетка+RDP)', 'компиляция', r);
}

// ── H. compositor: попадание в кэш (zero-alloc hot-path) ──
{
  const c = compositor.createSpringLinearCache(8);
  const sG = { mass: 1, stiffness: 170, damping: 26 };
  c.compile(sG); // прогрев
  const r = measure(() => c.compile(sG).length, { iters: 200000, samples: 9 });
  row('compositor.compileSpringLinear HIT (кэш)', 'попадание', r);
}

// ── I. compositor: readCompositorSpring — O(1) чтение (механизм хендоффа) ──
{
  const sH = { mass: 1, stiffness: 170, damping: 26 };
  const r = measure(
    (i) => compositor.readCompositorSpring(sH, { from: 0, to: 100, v0: 0, t: (i % 120) * (1 / 60) }).value,
    { iters: 200000, samples: 9 },
  );
  row('compositor.readCompositorSpring O(1) read', 'чтение', r);
}

// ── Справка: число узлов linear() и hit-rate типового stagger ──
const NODE_SPRINGS = {
  'critical (k170 c26)': { mass: 1, stiffness: 170, damping: 26 },
  'bouncy   (k180 c8)': { mass: 1, stiffness: 180, damping: 8 },
  'over     (k100 c40)': { mass: 1, stiffness: 100, damping: 40 },
};
const nodeCounts = Object.fromEntries(
  Object.entries(NODE_SPRINGS).map(([name, s]) => [
    name,
    compositor.compileSpringLinear(s).split(',').length,
  ]),
);
// Типовой stagger: N элементов делят ОДНУ пружину → 1 компиляция + (N−1) попаданий.
const STAGGER_N = 50;
const staggerHitRate = ((STAGGER_N - 1) / STAGGER_N) * 100;
const defaultEasingPair = measureDefaultEasingPair();
sinkChecksum += defaultEasingPair.checksum;
const transformFormatterPair = measureTransformFormatterPair();
sinkChecksum += transformFormatterPair.sinkChecksum;

// ── Атомарный отчёт: provenance проверяется до первого байта результатов ──
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(0));
const output = [];
const line = (value = '') => output.push(value);
line('\nlab-motion bench — горячие пути против dist (медиана по сэмплам)\n');
line(`  checkout ${provenance.revisionLabel}; worktree ${provenance.worktreeSha256}; dist ${provenance.distRuntime.sha256}`);
line(`  ${os.cpus()[0]?.model?.trim() ?? 'unknown CPU'}; ${process.version}; pnpm ${provenance.environment.pnpm}\n`);
line('  ' + 'путь'.padEnd(48) + 'ns/оп'.padStart(12) + 'ops/sec'.padStart(14));
line('  ' + '-'.repeat(72));
for (const { name, nsPerOp, opsPerSec } of results) {
  line('  ' + name.padEnd(48) + fmt(nsPerOp).padStart(12) + fmt(opsPerSec).padStart(14));
}
line('\nизинг по умолчанию: отгруженные dist/tokens против dist/easing');
line('  ' + 'реализация'.padEnd(28) + 'p50 ns'.padStart(12) + 'p95 ns'.padStart(12));
line('  ' + '-'.repeat(52));
line(
  '  ' + 'tokens.standard'.padEnd(28) +
    defaultEasingPair.specialized.p50.toFixed(2).padStart(12) +
    defaultEasingPair.specialized.p95.toFixed(2).padStart(12),
);
line(
  '  ' + 'easing.cubicBezier'.padEnd(28) +
    defaultEasingPair.generic.p50.toFixed(2).padStart(12) +
    defaultEasingPair.generic.p95.toFixed(2).padStart(12),
);
line(
  `  ускорение specialized: ${defaultEasingPair.ratio.p50.toFixed(3)}× p50 / ` +
    `${defaultEasingPair.ratio.p95.toFixed(3)}× p95`,
);
line(
  `  seed=0x${defaultEasingPair.seed.toString(16)}, inputs=${defaultEasingPair.inputs}, ` +
    `repetitions=${defaultEasingPair.repetitions}, warmup=${defaultEasingPair.warmupRounds}, ` +
    `сбалансированных раундов=${defaultEasingPair.rounds}`,
);
line(
  `  checksum tokens=${defaultEasingPair.checksums['tokens.standard'].toPrecision(17)}; ` +
    `generic=${defaultEasingPair.checksums['easing.cubicBezier'].toPrecision(17)}`,
);
line(`  dist SHA-256=${provenance.distRuntime.sha256}`);
line('\ntransform formatter+materialization: parts+join reconstruction против current dist/value');
line('  ' + 'реализация'.padEnd(28) + 'p50 ns'.padStart(12) + 'p95 ns'.padStart(12));
line('  ' + '-'.repeat(52));
line(
  '  ' + 'parts-reconstruction'.padEnd(28) +
    transformFormatterPair.reconstruction.p50.toFixed(2).padStart(12) +
    transformFormatterPair.reconstruction.p95.toFixed(2).padStart(12),
);
line(
  '  ' + 'current-dist'.padEnd(28) +
    transformFormatterPair.current.p50.toFixed(2).padStart(12) +
    transformFormatterPair.current.p95.toFixed(2).padStart(12),
);
line(
  `  отношение reconstruction/current: ${transformFormatterPair.ratio.p50.toFixed(3)}× p50 / ` +
    `${transformFormatterPair.ratio.p95.toFixed(3)}× p95`,
);
line(
  `  seed=0x${transformFormatterPair.seed.toString(16)}, inputs=${transformFormatterPair.inputs}, ` +
    `repetitions=${transformFormatterPair.repetitions}, warmup=${transformFormatterPair.warmupRounds}, ` +
    `сбалансированных раундов=${transformFormatterPair.rounds}`,
);
line(
  `  checksum=${transformFormatterPair.outputChecksum}; ` +
    `reconstruction=${transformFormatterPair.provenance.reconstruction}; ` +
    `current=${transformFormatterPair.provenance.current}`,
);
line('  тайминг включает formatter и полное посимвольное чтение результата.');
line(`  свежий dist SHA-256=${provenance.distRuntime.sha256}; speed hard gate: нет`);
// ── Справка compositor: узлы linear() (адаптив) + hit-rate stagger ──
line('\ncompositor: число стопов linear() (адаптив, tol=default 0.25px@100px)');
line('  ' + '-'.repeat(48));
for (const [name, count] of Object.entries(nodeCounts)) {
  line('  ' + name.padEnd(24) + String(count).padStart(6) + ' стопов');
}
line(
  `  hit-rate типового stagger (${STAGGER_N} элементов, 1 пружина): ${staggerHitRate.toFixed(0)}% ` +
    `(1 компиляция + ${STAGGER_N - 1} попаданий).`,
);

line(`\n  (sink-checksum ${Number.isFinite(sinkChecksum) ? 'ok' : 'NaN'})\n`);

assertCheckoutUnchanged(pkgRoot, provenance);
process.stdout.write(output.join('\n') + '\n');
