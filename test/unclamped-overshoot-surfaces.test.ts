import { describe, expect, it } from 'vitest';
import { MotionValue } from '../src/motion-value.js';
import { createDriver } from '../src/driver.js';
import { createFlip } from '../src/flip/index.js';

/**
 * Test: clamp:false на остальных поверхностях — MotionValue, driver, flip
 * Class: contract (new capability) + regression pin легаси-дефолта
 * Пара к test/drive-unclamped-overshoot.test.ts (там — drive()): все четыре
 * драйвера получили опцию clamp (default true, легаси CSS-safe) и обязаны
 * под clamp:false эмитить ЧЕСТНУЮ underdamped-траекторию.
 *
 * Contract под clamp:false (един для всех поверхностей):
 *   (1) траектория выходит за цель (overshoot эмитится, не срезается);
 *   (2) возвращается ниже цели после пика (это bounce, не рампа);
 *   (3) финальный settle — ровно цель;
 *   (4) каждое эмитированное значение конечно.
 * Пин дефолта (clamp опущен): значения никогда не выходят за [from, to].
 *
 * RED proof (mutation targets):
 *   - Вернуть клэмп на bounded=false пути любого драйвера → (1) падает.
 *   - driver: вернуть visual-saturation gate (cv===to) БЕЗ проверки bounded
 *     → settle на первом касании цели, (1) падает (пик не эмитится) —
 *     это реальная латентная дыра, найденная при написании этих тестов.
 *   - flip: клампить p до вычисления converged → (1) падает.
 */

/** Заглушка matchMedia: без предпочтения reduced-motion. */
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

/** Ручной кадровый клок: собирает колбэки, дренится фиксированным шагом. */
function makeStepClock(): {
  clock: (cb: (ts?: number) => void) => number;
  drainUntilIdle: (maxFrames: number) => void;
} {
  const queue: Array<(ts?: number) => void> = [];
  let ts = 0;
  let handle = 0;
  return {
    clock: (cb) => {
      queue.push(cb);
      handle += 1;
      return handle;
    },
    drainUntilIdle: (maxFrames) => {
      for (let i = 0; i < maxFrames && queue.length > 0; i++) {
        ts += 1000 / 60;
        const cb = queue.shift();
        if (cb) cb(ts);
      }
    },
  };
}

/** Underdamped-пружина: ζ=0.25, ω₀=8 — пик overshoot ≈ +44% (exp(−πζ/√(1−ζ²))). */
const UNDERDAMPED = { mass: 1, stiffness: 64, damping: 4 } as const;

/** Общая проверка честной траектории 0→100: overshoot, bounce, точный settle. */
function expectHonestTrajectory(emitted: readonly number[]): void {
  for (const v of emitted) expect(Number.isFinite(v)).toBe(true);
  const peak = Math.max(...emitted);
  expect(peak).toBeGreaterThan(100 + 1); // (1) overshoot эмитится
  const afterPeak = emitted.slice(emitted.indexOf(peak) + 1);
  expect(Math.min(...afterPeak)).toBeLessThan(100); // (2) bounce назад
  expect(emitted[emitted.length - 1]).toBe(100); // (3) точный settle
}

// ─── MotionValue ─────────────────────────────────────────────────────────────

describe('MotionValue clamp:false — честная underdamped-пружина', () => {
  it('эмитит overshoot за target, возвращается, settle ровно в target', () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const mv = new MotionValue({
      initial: 0,
      spring: UNDERDAMPED,
      requestFrame: clock,
      clamp: false,
    });
    mv.onChange((v) => emitted.push(v));
    mv.setTarget(100);
    drainUntilIdle(2000);
    expectHonestTrajectory(emitted);
    mv.destroy();
  });

  it('дефолт (clamp опущен) пинит легаси-контракт: значения в [initial, target]', () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const mv = new MotionValue({ initial: 0, spring: UNDERDAMPED, requestFrame: clock });
    mv.onChange((v) => emitted.push(v));
    mv.setTarget(100);
    drainUntilIdle(2000);
    for (const v of emitted) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(emitted[emitted.length - 1]).toBe(100);
    mv.destroy();
  });
});

// ─── driver (createDriver) ───────────────────────────────────────────────────

describe('createDriver clamp:false — честная underdamped-пружина', () => {
  it('эмитит overshoot за to (saturation-gate не срезает на первом касании), settle ровно в to', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: UNDERDAMPED,
      clamp: false,
      onStep: (v) => emitted.push(v),
      matchMedia: noReduceMedia(),
      requestFrame: clock,
    });
    drainUntilIdle(4000);
    await controls;
    expectHonestTrajectory(emitted);
  });

  it('дефолт (clamp опущен) пинит легаси-контракт: значения в [from, to], settle на первом визуальном насыщении', async () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const emitted: number[] = [];
    const controls = createDriver({
      from: 0,
      to: 100,
      spring: UNDERDAMPED,
      onStep: (v) => emitted.push(v),
      matchMedia: noReduceMedia(),
      requestFrame: clock,
    });
    drainUntilIdle(4000);
    await controls;
    for (const v of emitted) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(emitted[emitted.length - 1]).toBe(100);
  });
});

// ─── flip (createFlip) ───────────────────────────────────────────────────────

const FIRST = { x: 0, y: 0, width: 100, height: 100 } as const;
const LAST = { x: 100, y: 0, width: 100, height: 100 } as const;
// Инверсия: dx = −100 → tx(p) = −100·(1−p). Overshoot p>1 даёт tx > 0:
// элемент упруго проскакивает своё НОВОЕ место и возвращается.

describe('createFlip clamp:false — упругий доезд', () => {
  it('transform проскакивает identity (tx > 0), возвращается и оседает ровно в identity', () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const txs: number[] = [];
    let rested = 0;
    const fl = createFlip({
      spring: UNDERDAMPED,
      clamp: false,
      requestFrame: clock,
      matchMedia: noReduceMedia(),
      onStep: (t) => txs.push(t.tx),
      onRest: () => rested++,
    });
    fl.play(FIRST, LAST);
    drainUntilIdle(3000);

    for (const v of txs) expect(Number.isFinite(v)).toBe(true);
    // (1) overshoot: доезд с −100 проскакивает 0 в плюс (ζ=0.25 → пик ≈ +44)
    const peak = Math.max(...txs);
    expect(peak).toBeGreaterThan(1);
    // (2) bounce: после пика траектория возвращается ниже identity
    const afterPeak = txs.slice(txs.indexOf(peak) + 1);
    expect(Math.min(...afterPeak)).toBeLessThan(-0.001);
    // (3) точный settle в identity, ровно один onRest
    expect(txs[txs.length - 1]).toBe(0);
    expect(rested).toBe(1);
    expect(fl.playing).toBe(false);
  });

  it('дефолт (clamp опущен) пинит легаси-контракт: tx монотонно в [−100, 0]', () => {
    const { clock, drainUntilIdle } = makeStepClock();
    const txs: number[] = [];
    const fl = createFlip({
      spring: UNDERDAMPED,
      requestFrame: clock,
      matchMedia: noReduceMedia(),
      onStep: (t) => txs.push(t.tx),
    });
    fl.play(FIRST, LAST);
    drainUntilIdle(3000);
    for (const v of txs) {
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(0);
    }
    expect(txs[txs.length - 1]).toBe(0);
  });
});
