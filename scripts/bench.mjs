/**
 * scripts/bench.mjs — микро/макро-бенчи горячих путей движка (dependency-free).
 *
 * Зачем: у пакета нет фикс-порогов рантайм-перфа (size-gate меряет ВЕС, не
 * скорость). Этот скрипт меряет РЕАЛЬНЫЕ горячие пути против собранного dist —
 * тот же артефакт, что шипится, — и печатает ns/операцию + ops/sec. Числа
 * стабилизируются warmup'ом (JIT прогревается) и медианой по нескольким сэмплам
 * (устойчива к GC-паузам). Sink-аккумулятор глушит dead-code-elimination V8.
 *
 * Запуск: pnpm build && node scripts/bench.mjs
 * Гейтом НЕ является (ns/op wall-clock машинозависимы) — сила seal'а в
 * test/perf-hot-path.test.ts: детерминированный инвариант работы (число кадров
 * до сходимости = вызовов солвера, машинонезависим). Здесь — справочные числа.
 *
 * ВЕРДИКТ по перфу (замер 2026-07-08): движок в физическом оптимуме. Гипотеза
 * «precompute инвариантов пружины раз на прогон» ОТВЕРГНУТА — прототип замерен
 * как −24.6% РЕГРЕССИЯ (19.4→24.2 ns/кадр) при бит-точности 0 (600k пар
 * Object.is-идентичны naive vs prepared): V8 инлайнит монопоморфный naive-солвер,
 * 2×sqrt почти бесплатны на железе, замыкание+индирект-вызов дороже сэкономленного.
 * Ядро solver.ts не тронуто.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const distUrl = (p) => pathToFileURL(resolve(pkgRoot, p)).href;

const { spring, drive, MotionValue } = await import(distUrl('dist/index.js'));
const utils = await import(distUrl('dist/utils/index.js'));

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

const SPRING = { mass: 1, stiffness: 170, damping: 26 }; // типовой Framer-подобный

const results = [];
let sinkChecksum = 0; // потребляется в выводе → V8 не может DCE чистые микро-бенчи
function row(name, unit, { nsPerOp, opsPerSec, sink }) {
  sinkChecksum += sink;
  results.push({ name, unit, nsPerOp, opsPerSec });
}

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

// ── D. spring() публичный (микро: solver + валидация на каждый вызов) ──
{
  const r = measure((i) => spring(SPRING, (i % 2000) * (1 / 60)).value, {
    iters: 200000,
    samples: 9,
  });
  row('spring() публичный вызов (solver+validate)', 'вызов', r);
}

// ── E. utils.interpolate 5-стоп (новый субпуть) ──
{
  const f = utils.interpolate([0, 0.25, 0.5, 0.75, 1], [0, 40, 20, 90, 100]);
  const r = measure((i) => f((i % 1000) / 1000), { iters: 200000, samples: 9 });
  row('utils.interpolate 5-стоп запрос', 'запрос', r);
}

// ── Печать ──
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(0));
console.log('\nlab-motion bench — горячие пути против dist (медиана по сэмплам)\n');
console.log('  ' + 'путь'.padEnd(48) + 'ns/оп'.padStart(12) + 'ops/sec'.padStart(14));
console.log('  ' + '-'.repeat(72));
for (const { name, nsPerOp, opsPerSec } of results) {
  console.log('  ' + name.padEnd(48) + fmt(nsPerOp).padStart(12) + fmt(opsPerSec).padStart(14));
}
// checksum печатается → sink-аккумуляторы всех замеров живые (анти-DCE)
console.log(`\n  (sink-checksum ${Number.isFinite(sinkChecksum) ? 'ok' : 'NaN'})\n`);
