/**
 * scripts/bench-latency.mjs — латентный стенд M2: main-thread cost горячих путей
 * ретаргета и хендоффа (dependency-free, против собранного dist).
 *
 * Зачем ОТДЕЛЬНО от bench.mjs: bench.mjs меряет ПРОПУСКНУЮ способность (ns/оп,
 * ops/sec, медиана по батчам). Здесь — РАСПРЕДЕЛЕНИЕ латентности ОДНОЙ операции
 * (p50/p95/p99, НЕ средние — методология research-дайджеста «ТЕМА 2 → M2»):
 * one-shot событие (ретаргет, хендофф) должно уложиться в бюджет кадра, и важен
 * ХВОСТ (p99), а не среднее. Каждая операция таймится индивидуально через
 * process.hrtime.bigint() (наносекундное разрешение); warmup прогревает JIT;
 * репортится медиана каждого перцентиля по нескольким прогонам (устойчивость к
 * GC-паузам).
 *
 * Бюджеты кадра (research-дайджест): 16.66 / 8.33 / 4.17 ms при 60 / 120 / 240 Hz —
 * печатаются как ориентир: сколько таких операций влезает в кадр.
 *
 * ГЕЙТОМ НЕ ЯВЛЯЕТСЯ (ns wall-clock машинозависимы; тот же принцип, что bench.mjs).
 * Браузерный слой (PerformanceObserver LoAF / Event Timing, presentationTime) —
 * вне CI (нужен реальный Chrome + tracing для compositor-резидентности), ручная
 * валидация; см. README «Границы замера».
 *
 * Запуск: pnpm bench:latency (стенд пересобирает и fingerprint'ит checkout/dist)
 */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCheckoutUnchanged,
  prepareBenchmarkCheckout,
} from '../bench/compare/provenance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const distUrl = (p) => pathToFileURL(resolve(pkgRoot, p)).href;

const provenance = prepareBenchmarkCheckout({
  root: pkgRoot,
  benchDirectory: pkgRoot,
  requireClean: false,
  requiredDist: ['dist/compositor/index.js', 'dist/compositor/stagger/index.js'],
});

const {
  CompositorSpring,
  handoffToLive,
  readCompositorSpring,
} = await import(distUrl('dist/compositor/index.js'));
const {
  compileStaggerPlan,
  CompositorStaggerGroup,
} = await import(distUrl('dist/compositor/stagger/index.js'));

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

/** Фейк-Element: .animate возвращает лёгкий Animation, НИЧЕГО не удерживает. */
function fakeEl() {
  return { animate: () => ({ cancel() {} }) };
}
/** requestFrame-заглушка: ненулевой handle, НЕ копит замыкания (без утечки в цикле). */
const noopRF = () => 1;

/**
 * Перцентильный замер: warmup прогонов, затем `iters` ИНДИВИДУАЛЬНО таймленных
 * операций (hrtime.bigint, нс). Повторяется `runs` раз; возвращается медиана
 * каждого перцентиля по прогонам. `setup(i)` (вне тайминга) готовит состояние и
 * возвращает аргумент; `op(arg)` — измеряемое действие; `teardown(r)` (вне
 * тайминга) убирает за собой (destroy live-значения и т.п.).
 */
function measureLatency(label, { setup, op, teardown, iters = 2000, warmup = 500, runs = 5 }) {
  const nearestRank = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  // Warmup: греем JIT (результаты не собираем).
  for (let i = 0; i < warmup; i++) {
    const arg = setup ? setup(i) : undefined;
    const r = op(arg);
    if (teardown) teardown(r);
  }

  const p50s = [], p95s = [], p99s = [], meds = [];
  for (let run = 0; run < runs; run++) {
    const samples = new Float64Array(iters);
    for (let i = 0; i < iters; i++) {
      const arg = setup ? setup(i) : undefined;
      const t0 = process.hrtime.bigint();
      const r = op(arg);
      const t1 = process.hrtime.bigint();
      samples[i] = Number(t1 - t0); // нс
      if (teardown) teardown(r);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    p50s.push(nearestRank(sorted, 50));
    p95s.push(nearestRank(sorted, 95));
    p99s.push(nearestRank(sorted, 99));
    meds.push(sorted[sorted.length >> 1]);
  }
  return { label, p50: median(p50s), p95: median(p95s), p99: median(p99s) };
}

const results = [];

// ── A. readCompositorSpring — O(1) аналитический снимок (ядро retarget И handoff) ──
{
  let now = 0;
  results.push(
    measureLatency('readCompositorSpring (аналитич. снимок)', {
      setup: (i) => (now = (i % 120) * (1 / 60)),
      op: (t) => readCompositorSpring(SPRING, { from: 0, to: 100, v0: 0, t }),
      iters: 5000,
      warmup: 2000,
    }),
  );
}

// ── B. CompositorSpring.retarget — one-shot: read + cancel + РЕКОМПИЛЯЦИЯ + re-emit ──
// Контроллер держится в полёте: каждый retarget пере-эмитит новую Animation, часы
// сдвигаются → elapsed>0. Скорость (v0) меняется каждый раз → в основном промах
// кэша = честная стоимость перекомпиляции кривой (реалистичный верхний край).
{
  let now = 1000;
  const cs = new CompositorSpring({
    spring: SPRING, property: 'x', from: 0, to: 100, target: fakeEl(), now: () => now,
  });
  cs.start();
  const targets = [50, 220, 130, 300, 90, 260];
  results.push(
    measureLatency('CompositorSpring.retarget one-shot (recompile)', {
      setup: (i) => { now += 16; return targets[i % targets.length]; },
      op: (target) => cs.retarget(target),
    }),
  );
}

// ── C. handoffToLive — сборка live-пружины из снимка (alloc MotionValue + setTarget) ──
{
  const snap = readCompositorSpring(SPRING, { from: 0, to: 100, v0: 0, t: 0.1 });
  results.push(
    measureLatency('handoffToLive build (снимок→live MotionValue)', {
      op: () => handoffToLive({
        spring: SPRING, value: snap.value, velocity: snap.velocity, target: 100, requestFrame: noopRF,
      }),
      teardown: (mv) => mv.destroy(),
    }),
  );
}

// ── D. CompositorSpring.handoffToLive — ПОЛНЫЙ хендофф: read + cancel + build ──
// Контроллер пере-вооружается start() каждую итерацию (ВНЕ тайминга); таймится
// только сам хендофф из полёта.
{
  let now = 1000;
  const cs = new CompositorSpring({
    spring: SPRING, property: 'x', from: 0, to: 100, target: fakeEl(), now: () => now, requestFrame: noopRF,
  });
  results.push(
    measureLatency('CompositorSpring.handoffToLive (read+cancel+build)', {
      setup: () => { cs.start(); now += 16; },
      op: () => cs.handoffToLive(),
      teardown: (mv) => mv.destroy(),
    }),
  );
}

// ── E. compileStaggerPlan — расписание stagger N элементов (компиляция+планирование) ──
// M3: чистый планировщик caskад'а. Пружина компилируется ОДИН раз (общий кэш), далее
// per-element задержки из ./stagger. Меряем ПОЛНУЮ стоимость планирования группы —
// это main-thread cost построения каскада; per-frame cost = НОЛЬ (каскад гоняет браузер).
for (const N of [10, 50, 200]) {
  results.push(
    measureLatency(`compileStaggerPlan N=${N} (компиляция+планирование)`, {
      op: () => compileStaggerPlan({ spring: SPRING, property: 'transform', from: 0, to: 100, count: N, gap: 40 }),
      iters: 3000,
      warmup: 1000,
    }),
  );
}

// ── F. CompositorStaggerGroup.start() — коммит N Element.animate с per-element delay ──
// Полный запуск каскада: планирование + N нативных Element.animate (fake-цели, ничего
// не удерживают). Свежая группа на итерацию (setup вне тайминга), таймится start().
{
  const fakeEls = (n) => Array.from({ length: n }, () => ({ animate: () => ({ cancel() {} }) }));
  for (const N of [10, 50]) {
    results.push(
      measureLatency(`CompositorStaggerGroup.start N=${N} (план+коммит)`, {
        setup: () => new CompositorStaggerGroup({ spring: SPRING, property: 'transform', from: 0, to: 100, targets: fakeEls(N), gap: 40 }),
        op: (g) => g.start(),
        teardown: (_r) => {},
        iters: 2000,
        warmup: 500,
      }),
    );
  }
}

// ── Печать ──
const fmtNs = (n) => (n >= 1e3 ? (n / 1e3).toFixed(2) + ' µs' : n.toFixed(0) + ' ns');
console.log('\nlab-motion латентный стенд M2 — main-thread cost горячих путей (dist)\n');
console.log(`  checkout ${provenance.revisionLabel}; worktree ${provenance.worktreeSha256}; dist ${provenance.distRuntime.sha256}\n`);
console.log('  распределение ОДНОЙ операции: p50/p95/p99 (не средние), медиана по прогонам\n');
console.log('  ' + 'путь'.padEnd(46) + 'p50'.padStart(11) + 'p95'.padStart(11) + 'p99'.padStart(11));
console.log('  ' + '-'.repeat(79));
for (const { label, p50, p95, p99 } of results) {
  console.log('  ' + label.padEnd(46) + fmtNs(p50).padStart(11) + fmtNs(p95).padStart(11) + fmtNs(p99).padStart(11));
}

// ── Бюджеты кадра: сколько операций p99 влезает в кадр ──
const FRAME_BUDGETS = { '60 Hz': 16.66, '120 Hz': 8.33, '240 Hz': 4.17 };
console.log('\n  бюджет кадра vs p99 хендоффа (мс):');
const handoffP99Ns = results.find((r) => r.label.startsWith('CompositorSpring.handoffToLive')).p99;
for (const [hz, ms] of Object.entries(FRAME_BUDGETS)) {
  const share = ((handoffP99Ns / 1e6) / ms) * 100;
  console.log('  ' + hz.padEnd(10) + `${ms} ms — хендофф p99 = ${share.toFixed(2)}% кадра`);
}
console.log(
  '\n  примечание: числа машинозависимы, гейтом НЕ являются; compositor-резидентность\n' +
    '  и input→photon НЕ наблюдаемы из Node — только реальный Chrome + tracing (см. README).\n',
);

assertCheckoutUnchanged(pkgRoot, provenance);
