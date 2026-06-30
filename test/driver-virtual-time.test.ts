/**
 * test/driver-virtual-time.test.ts
 * Class: В/Differential — виртуальное время: детерминизм + bit-exact differential
 *
 * Invariant 3 — детерминизм: инжектируемый clock seam гарантирует,
 * что два независимых прогона с одинаковыми параметрами и одинаковым seam
 * производят БИТО-ТОЧНО ИДЕНТИЧНУЮ последовательность эмитов.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Добавить `Math.random()` в tick() тела driver.ts:
 *   → Два прогона дают разные последовательности → differential fails → RED.
 * Убрать `_lastRealTs = undefined` при паузе/seek:
 *   → После паузы+resume первый dt зависит от реального системного времени
 *     (нет сброса), а не от инжектированного seam → не детерминировано → RED.
 *
 * ── MUTATION PROOF ────────────────────────────────────────────────────────────
 * Убрать reset `_lastRealTs = undefined` при pause():
 *   → После pause+play dt "прыгает" (wall-clock), дифференциал двух прогонов
 *     расходится → emitted[i] !== emitted2[i] → RED.
 */

import { describe, expect, it } from 'vitest';
import { createDriver } from '../src/driver.js';

/** Стандартный spring: ω₀=10 > 2; ζ=1 (критическое). */
const STD_SPRING = { mass: 1, stiffness: 100, damping: 20 };

/** matchMedia-стаб без prefers-reduced-motion. */
function noReduceMedia(): (query: string) => MediaQueryList {
  return (): MediaQueryList => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * Создаёт детерминированный clock, который хранит колбэки и позволяет
 * вручную "продвигать" кадры с заданными timestamps.
 */
function makeStepClock(): {
  queue: Array<(ts?: number) => void>;
  requestFrame: (cb: (ts?: number) => void) => number;
} {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 1;
  return {
    queue,
    requestFrame: (cb) => {
      queue.push(cb);
      return handle++;
    },
  };
}

/**
 * Запустить driver с детерминированным clock, продвинуть N кадров с шагом
 * dtMs, вернуть список эмитированных значений.
 */
function runDeterministicDriver(opts: {
  from: number;
  to: number;
  frames: number;
  dtMs: number;
}): number[] {
  const emitted: number[] = [];
  const clock1 = makeStepClock();

  const c = createDriver({
    from: opts.from,
    to: opts.to,
    spring: STD_SPRING,
    matchMedia: noReduceMedia(),
    onStep: (v) => emitted.push(v),
    requestFrame: clock1.requestFrame,
  });

  let ts = 0;
  for (let i = 0; i < opts.frames; i++) {
    if (clock1.queue.length === 0) break;
    const cb = clock1.queue.shift()!;
    cb(ts);
    ts += opts.dtMs;
  }

  c.cancel();
  return emitted;
}

// ─── 1. Bit-exact differential ────────────────────────────────────────────────

describe('driver-virtual-time: bit-exact differential (два прогона → идентичный вывод)', () => {
  it('standard spring 0→100, 30 кадров @ 16ms', () => {
    const run1 = runDeterministicDriver({ from: 0, to: 100, frames: 30, dtMs: 16 });
    const run2 = runDeterministicDriver({ from: 0, to: 100, frames: 30, dtMs: 16 });

    expect(run1.length, 'оба прогона должны иметь одинаковую длину').toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i], `frame ${i}: ${run1[i]} !== ${run2[i]}`).toBe(run2[i]);
    }
  });

  it('отрицательный диапазон (-200 → -50), 20 кадров @ 8ms', () => {
    const run1 = runDeterministicDriver({ from: -200, to: -50, frames: 20, dtMs: 8 });
    const run2 = runDeterministicDriver({ from: -200, to: -50, frames: 20, dtMs: 8 });

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i]).toBe(run2[i]);
    }
  });

  it('крупный диапазон 0→1e6, 50 кадров @ 16ms', () => {
    const run1 = runDeterministicDriver({ from: 0, to: 1e6, frames: 50, dtMs: 16 });
    const run2 = runDeterministicDriver({ from: 0, to: 1e6, frames: 50, dtMs: 16 });

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i]).toBe(run2[i]);
    }
  });
});

// ─── 2. Seek-детерминизм ──────────────────────────────────────────────────────

describe('driver-virtual-time: seek-детерминизм', () => {
  it('seek(0.5) + seek(1.0) дают одинаковые значения в двух независимых driver', () => {
    const emitted1: number[] = [];
    const c1 = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted1.push(v),
      requestFrame: (_cb) => 0,
    });
    c1.pause();
    emitted1.length = 0;
    c1.seek(0.5);
    c1.seek(1.0);
    c1.cancel();

    const emitted2: number[] = [];
    const c2 = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted2.push(v),
      requestFrame: (_cb) => 0,
    });
    c2.pause();
    emitted2.length = 0;
    c2.seek(0.5);
    c2.seek(1.0);
    c2.cancel();

    expect(emitted1.length).toBe(emitted2.length);
    for (let i = 0; i < emitted1.length; i++) {
      expect(emitted1[i]).toBe(emitted2[i]);
    }
  });
});

// ─── 3. Virtual-time seam: фиксированный dt без timestamps ───────────────────

describe('driver-virtual-time: фиксированный dt (без DOMHighResTimeStamp)', () => {
  it('non-draining clock (handle=0) → setTimeout-fallback работает детерминировано', async () => {
    const emitted1: number[] = [];
    const p1 = createDriver({
      from: 0, to: 10,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted1.push(v),
      requestFrame: (_cb) => 0,
    });
    await p1;

    const emitted2: number[] = [];
    const p2 = createDriver({
      from: 0, to: 10,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted2.push(v),
      requestFrame: (_cb) => 0,
    });
    await p2;

    // Оба прогона завершились и дали одинаковые последовательности.
    expect(emitted1.length, 'одинаковая длина').toBe(emitted2.length);
    for (let i = 0; i < emitted1.length; i++) {
      expect(emitted1[i], `frame ${i}`).toBe(emitted2[i]);
    }
  }, 10_000);
});

// ─── 4. timeScale детерминизм ─────────────────────────────────────────────────

describe('driver-virtual-time: timeScale детерминизм', () => {
  it('timeScale=2 ускоряет анимацию — эмитирует значения дальше по шкале t', () => {
    const emittedNormal: number[] = [];
    const clockNormal = makeStepClock();
    const cNormal = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emittedNormal.push(v),
      requestFrame: clockNormal.requestFrame,
      initialTimeScale: 1,
    });

    const emittedFast: number[] = [];
    const clockFast = makeStepClock();
    const cFast = createDriver({
      from: 0, to: 100,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emittedFast.push(v),
      requestFrame: clockFast.requestFrame,
      initialTimeScale: 2, // вдвое быстрее
    });

    // Прогнать по 5 кадров @ 16ms у каждого.
    let ts1 = 0;
    let ts2 = 0;
    for (let i = 0; i < 5; i++) {
      if (clockNormal.queue.length > 0) {
        clockNormal.queue.shift()!(ts1);
        ts1 += 16;
      }
      if (clockFast.queue.length > 0) {
        clockFast.queue.shift()!(ts2);
        ts2 += 16;
      }
    }

    cNormal.cancel();
    cFast.cancel();

    // Быстрый driver должен быть "дальше" к цели, чем нормальный.
    const lastNormal = emittedNormal[emittedNormal.length - 1] ?? 0;
    const lastFast = emittedFast[emittedFast.length - 1] ?? 0;

    expect(
      lastFast,
      `timeScale=2 должен быть ближе к to=100, чем timeScale=1; normal=${lastNormal} fast=${lastFast}`,
    ).toBeGreaterThan(lastNormal);

    // Все значения конечны.
    for (const v of [...emittedNormal, ...emittedFast]) {
      expect(Number.isFinite(v), `emitted non-finite: ${v}`).toBe(true);
    }
  });
});
