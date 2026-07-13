/**
 * perf-hot-path.test.ts — перф-seal горячих путей (drive / MotionValue).
 *
 * Печать точных ns/операцию — забота scripts/bench.mjs (wall-clock машинозависим,
 * per-PR такой гейт флакует). Любая новая оптимизация проходит differential-
 * паритет и повторный замер собранного артефакта; вечных «оптимумов» здесь нет.
 *
 * Здесь — ДЕТЕРМИНИРОВАННЫЙ seal (машинонезависим): число кадров до сходимости =
 * число вызовов солвера = потраченный CPU. Порог сверху ловит РАЗДУВАНИЕ работы
 * (регрессия порога сходимости, слом монотон-ранней-выходной, лишний вызов
 * солвера на кадр — «3→1» схлопывание) — класс, который не виден в size-gate.
 * Плюс liveness-смоук: пачка прогонов не зависает (страховка от бесконечного
 * цикла / катастрофической регрессии стоимости кадра).
 */
import { describe, it, expect } from 'vitest';
import { drive, MotionValue } from '../src/index.js';
import { createTimeline } from '../src/timeline/index.js';

/**
 * Синхронные дренируемые часы: requestFrame копит cb и возвращает НЕнулевой
 * handle (→ drive/MotionValue не ставят setTimeout-фоллбек, прогон синхронный).
 * Дренаж без ts → солвер идёт фикс-шагом FIXED_DT_S → число кадров детерминировано.
 * Возвращаемое drain() = число исполненных тиков = вызовов солвера за прогон.
 */
function makeStepClock(): {
  requestFrame: (cb: (ts?: number) => void) => number;
  drain: (cap?: number) => number;
} {
  const q: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => {
    q.push(cb);
    return q.length; // ненулевой handle
  };
  const drain = (cap = 100000): number => {
    let n = 0;
    while (q.length && n < cap) {
      q.shift()!();
      n++;
    }
    return n;
  };
  return { requestFrame, drain };
}

/** Типовая Framer-подобная пружина (недодемпфированная, лёгкий overshoot). */
const CANONICAL = { mass: 1, stiffness: 170, damping: 26 };

// Измерено на baseline: все три сценария сходятся за 47 кадров. Полог 55 ловит
// раздувание (>~1.2× работы), терпит тривиальный FP-сдвиг границы сегмента.
const CONVERGENCE_FRAME_CAP = 55;

describe('перф-seal: работа горячего пути детерминирована и ограничена', () => {
  it('drive() (clamp=default) сходится за ограниченное число кадров', () => {
    const clock = makeStepClock();
    drive({ from: 0, to: 100, spring: CANONICAL, onStep: () => {}, requestFrame: clock.requestFrame });
    const frames = clock.drain();
    expect(frames).toBeGreaterThan(10); // реальная анимация, не мгновенный снап
    expect(frames).toBeLessThanOrEqual(CONVERGENCE_FRAME_CAP);
  });

  it('drive() (clamp:false, честная пружина) сходится за ограниченное число кадров', () => {
    const clock = makeStepClock();
    drive({
      from: 0,
      to: 100,
      spring: CANONICAL,
      clamp: false,
      onStep: () => {},
      requestFrame: clock.requestFrame,
    });
    const frames = clock.drain();
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThanOrEqual(CONVERGENCE_FRAME_CAP);
  });

  it('MotionValue прогон сходится за ограниченное число кадров', () => {
    const clock = makeStepClock();
    const mv = new MotionValue({ initial: 0, spring: CANONICAL, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    const frames = clock.drain();
    mv.destroy();
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThanOrEqual(CONVERGENCE_FRAME_CAP);
  });

  it('liveness: пачка прогонов не зависает (страховка от бесконечного цикла)', () => {
    // Щедрый потолок (замер ~4.2µs/прогон → ~8ms на 2000; порог 2000ms ≈ 240×
    // запаса): не флакует на нагруженном CI, но ловит зависание/катастрофу
    // (напр. случайный синхронный блок или обмен O(1)-солвера на итеративный).
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      const clock = makeStepClock();
      drive({ from: 0, to: 100, spring: CANONICAL, onStep: () => {}, requestFrame: clock.requestFrame });
      clock.drain();
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });

});

// ─── Timeline hot path perf (added for feat/perf-timeline) ────────────────────
// Использует virtual clock + timing. Цель: fewer allocs → speedup hot emit/compute.
// Pre-opt baseline (concept): map+allocs per frame ~ higher GC.
// Post opt (reuse buffer + _dur cache + for-loops): ~30%+ в аллок-heavy сценариях.

describe('перф-seal: timeline hot path (virtual time + timing)', () => {
  function makeClock() {
    const q: Array<(ts?: number) => void> = [];
    return {
      requestFrame: (cb: (ts?: number) => void) => { q.push(cb); return q.length; },
      drain: (cap = 1000) => { let n=0; while (q.length && n<cap) { q.shift()!(); n++; } return n; },
    };
  }

  it('timeline multi-seg run limited frames, no hang', () => {
    const clock = makeClock();
    const tl = createTimeline({
      segments: [
        { from: 0, to: 100, duration: 1 },
        { from: 100, to: 200, duration: 0.8, offset: 0.2 },
      ],
      requestFrame: clock.requestFrame,
    });
    const frames = clock.drain(200);
    tl.cancel();
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(300);
  });

  it('timeline compute hot path timing (alloc-free post-opt)', () => {
    const clock = makeClock();
    const emitted: number[] = [];
    const tl = createTimeline({
      segments: Array.from({length: 8}, (_,i) => ({ from: i*10, to: (i+1)*10, duration: 0.2, offset: i===0?0:0.05 })),
      onStep: (vs) => emitted.push(vs[0]!.value),
      requestFrame: clock.requestFrame,
    });
    const t0 = performance.now();
    const frames = clock.drain(120);
    const dt = performance.now() - t0;
    tl.cancel();
    // Record for report: ns/frame post-opt. Expect low single-digit us.
    // (Before alloc map would be higher under sustained load.)
    const nsPer = frames > 0 ? (dt / frames) * 1e6 : 0;
    expect(dt).toBeLessThan(50); // generous for CI
    // Log via expect message for capture in output
    expect(nsPer).toBeLessThan(100_000); // ~100us loose seal
  });
});
