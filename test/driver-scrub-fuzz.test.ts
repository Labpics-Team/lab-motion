/**
 * test/driver-scrub-fuzz.test.ts
 * Class: В (property/fuzz — закрывает КЛАСС, а не одиночный вход)
 *
 * Invariant 2 — NaN/∞-safe: driver НИКОГДА не эмитирует NaN или ±Infinity.
 *
 * Тесты охватывают:
 *   a) seek(t) — экстремальные входы: 0, отрицательные, очень большие, +Infinity, NaN, -Infinity
 *   b) timeScale — экстремальные: ±1, ±1e15, 0, ±Infinity, (NaN отклоняется setter'ом)
 *   c) overflow-края from/to: фикс-pair с конечным range (регрессионный guard)
 *   d) 10 000+ seeded LCG fuzz: seek(t) при случайных t из широкого диапазона
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Убрать `if (!Number.isFinite(raw)) return to;` из computeAt() в driver.ts:
 *   → При seek к большому t пружина может вернуть Infinity-производное значение
 *     (когда decay переполняется в Inf/NaN на экстремальных t) → fuzz RED.
 *
 * Убрать `if (Number.isNaN(t)) return;` из seek():
 *   → `computeAt(NaN)` даёт значение из from (через springUnchecked → clampFinite=0),
 *     которое само конечно; НО если убрать NaN-guard И убрать finiteness guard —
 *     возможна цепочка NaN → onStep(NaN) → RED.
 *
 * Mutation proof (убрать finiteness guard в computeAt + убрать NaN guard в seek):
 *   → 1-й же fuzz-sample с seek(NaN) эмитирует NaN → RED немедленно.
 */

import { describe, expect, it } from 'vitest';
import { createDriver } from '../src/driver.js';
import type { DriverOptions } from '../src/driver.js';

// ─── LCG (то же что animate-overflow-finiteness-fuzz.test.ts) ────────────────

function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(48271, s) + 0) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function lerp(u: number, min: number, max: number): number {
  return min + u * (max - min);
}

// ─── Константы ────────────────────────────────────────────────────────────────

const MAX = Number.MAX_VALUE;

/** Стандартный spring: ω₀=10 > MIN=2; ζ=1 (критическое). */
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

/** Создать driver в неиграющем (settled) состоянии через cancel(). */
function makeSeekDriver(from: number, to: number): {
  emitted: number[];
  seek: (t: number) => void;
} {
  const emitted: number[] = [];
  const c = createDriver({
    from,
    to,
    spring: STD_SPRING,
    matchMedia: noReduceMedia(),
    onStep: (v) => emitted.push(v),
    requestFrame: (_cb) => 0, // non-draining
  });
  // Пауза сразу, чтобы frame loop не вмешивался в тесты scrub.
  c.pause();
  // Очистим накопившиеся эмиты от bootstrap-кадра.
  emitted.length = 0;
  return {
    emitted,
    seek: (t: number) => {
      c.seek(t);
    },
  };
}

// ─── 1. Ручные edge-cases seek ────────────────────────────────────────────────

describe('driver-scrub-fuzz: seek() edge cases', () => {
  it('seek(0) → эмитирует from (конечное)', () => {
    const { emitted, seek } = makeSeekDriver(10, 200);
    seek(0);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    // При t=0 пружина в начале → значение near from (зажато к from)
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(0) emitted non-finite: ${v}`).toBe(true);
    }
    expect(emitted[0]).toBe(10); // от=from
  });

  it('seek(очень малое t > 0) → конечное значение', () => {
    const { emitted, seek } = makeSeekDriver(0, 1);
    seek(1e-300);
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(1e-300) emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('seek(1.0) → конечное значение', () => {
    const { emitted, seek } = makeSeekDriver(0, 100);
    seek(1.0);
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(1.0) emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('seek(очень большое t) → конечное значение ≈ to', () => {
    const { emitted, seek } = makeSeekDriver(0, 100);
    seek(1e10);
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(1e10) emitted non-finite: ${v}`).toBe(true);
    }
    // При t→∞ пружина → to.
    expect(emitted[0]).toBeCloseTo(100, 1);
  });

  it('seek(Infinity) → complete() — эмитирует to, Promise резолвится', async () => {
    const emitted: number[] = [];
    const c = createDriver({
      from: 0,
      to: 50,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame: (_cb) => 0,
    });
    c.pause();
    emitted.length = 0;

    c.seek(Infinity);
    await c;
    // seek(Infinity) триггерит complete() → snap to to=50.
    expect(emitted.some((v) => v === 50)).toBe(true);
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(Inf) emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('seek(NaN) → игнорируется (нет эмита, нет краша)', () => {
    const { emitted, seek } = makeSeekDriver(0, 100);
    seek(NaN);
    // NaN должен быть silently ignored.
    // Последний кадр мог быть при bootstrap, очищали.
    // Нет новых эмитов.
    expect(emitted.length).toBe(0);
  });

  it('seek(-1) → clamp to 0, эмитирует from', () => {
    const { emitted, seek } = makeSeekDriver(5, 50);
    seek(-1);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0]).toBe(5); // from
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(-1) emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('seek(-Infinity) → clamp to 0, эмитирует from', () => {
    const { emitted, seek } = makeSeekDriver(5, 50);
    seek(-Infinity);
    expect(emitted[0]).toBe(5);
    for (const v of emitted) {
      expect(Number.isFinite(v), `seek(-Inf) emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('seek(t) после settled → no-op (нет дополнительных эмитов)', () => {
    const emitted: number[] = [];
    const c = createDriver({
      from: 0, to: 10,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame: (_cb) => 0,
    });
    c.complete();
    emitted.length = 0;
    c.seek(0.5);
    expect(emitted.length).toBe(0);
  });
});

// ─── 2. timeScale edge cases ──────────────────────────────────────────────────

describe('driver-scrub-fuzz: timeScale edge cases', () => {
  /** Прогнать 1 кадр через setTimeout-fallback (non-draining clock). */
  async function runOneFrame(opts: Partial<DriverOptions> = {}): Promise<number[]> {
    const emitted: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame: (_cb) => 0,
      ...opts,
    });
    // complete() сразу, чтобы Promise резолвился.
    c.complete();
    await c;
    return emitted;
  }

  it('timeScale=0 → не бросает, не эмитирует NaN/Infinity', async () => {
    const emitted = await runOneFrame({ initialTimeScale: 0 });
    for (const v of emitted) {
      expect(Number.isFinite(v), `timeScale=0 emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('timeScale=Infinity → не бросает, не эмитирует NaN/Infinity', async () => {
    const emitted = await runOneFrame({ initialTimeScale: Infinity });
    for (const v of emitted) {
      expect(Number.isFinite(v), `timeScale=Inf emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('timeScale=-Infinity → не бросает, не эмитирует NaN/Infinity', async () => {
    const emitted = await runOneFrame({ initialTimeScale: -Infinity });
    for (const v of emitted) {
      expect(Number.isFinite(v), `timeScale=-Inf emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('timeScale setter NaN → игнорируется, timeScale не меняется', () => {
    const c = createDriver({ from: 0, to: 100, spring: STD_SPRING, onStep: () => {}, requestFrame: (_cb) => 0 });
    const prev = c.timeScale;
    c.timeScale = NaN;
    expect(c.timeScale).toBe(prev); // не изменилось
    c.cancel();
  });

  it('timeScale setter Infinity → принимается', () => {
    const c = createDriver({ from: 0, to: 100, spring: STD_SPRING, onStep: () => {}, requestFrame: (_cb) => 0 });
    c.timeScale = Infinity;
    expect(c.timeScale).toBe(Infinity);
    c.cancel();
  });

  it('timeScale=1e15 → не бросает, не эмитирует NaN/Infinity', async () => {
    const emitted = await runOneFrame({ initialTimeScale: 1e15 });
    for (const v of emitted) {
      expect(Number.isFinite(v), `timeScale=1e15 emitted non-finite: ${v}`).toBe(true);
    }
  });

  it('reverse() инвертирует знак timeScale', () => {
    const c = createDriver({ from: 0, to: 100, spring: STD_SPRING, onStep: () => {}, requestFrame: (_cb) => 0 });
    expect(c.timeScale).toBe(1);
    c.reverse();
    expect(c.timeScale).toBe(-1);
    c.reverse();
    expect(c.timeScale).toBe(1);
    c.cancel();
  });

  it('timeScale отрицательный → не бросает, не эмитирует NaN/Infinity', async () => {
    const emitted = await runOneFrame({ initialTimeScale: -1 });
    for (const v of emitted) {
      expect(Number.isFinite(v), `timeScale=-1 emitted non-finite: ${v}`).toBe(true);
    }
  });
});

// ─── 3. Seeded LCG fuzz (10 000+ seek-образцов) ───────────────────────────────

describe('driver-scrub-fuzz: seeded LCG fuzz ≥10 000 seek-образцов (invariant 2)', () => {
  it('все seek(t) эмитируют конечное значение (seed=0xDEAD_BEEF)', () => {
    const rand = lcg(0xdead_beef);
    const SAMPLES = 10_000;
    const failures: string[] = [];

    const emitted: number[] = [];
    const c = createDriver({
      from: -50,
      to: 250,
      spring: STD_SPRING,
      matchMedia: noReduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame: (_cb) => 0,
    });
    c.pause();
    emitted.length = 0;

    for (let i = 0; i < SAMPLES; i++) {
      emitted.length = 0;

      const kind = i % 5;
      let t: number;
      if (kind === 0) {
        // Нормальный диапазон [0, 100с]
        t = lerp(rand(), 0, 100);
      } else if (kind === 1) {
        // Очень маленький [0, 1e-10]
        t = lerp(rand(), 0, 1e-10);
      } else if (kind === 2) {
        // Отрицательный [-100, 0) → должен clamp к 0
        t = lerp(rand(), -100, 0);
      } else if (kind === 3) {
        // Очень большой [1e6, 1e15]
        t = lerp(rand(), 1e6, 1e15);
      } else {
        // MAX/2 диапазон (конечный, но большой)
        t = lerp(rand(), 0, MAX / 2);
      }

      c.seek(t);

      for (const v of emitted) {
        if (!Number.isFinite(v)) {
          failures.push(`sample ${i}: seek(${t}) → non-finite: ${v}`);
          break;
        }
      }

      if (failures.length >= 20) break;
    }

    c.cancel();

    expect(
      failures,
      `Invariant 2 violated — non-finite driver output:\n${failures.join('\n')}`,
    ).toHaveLength(0);
  });

  it('seek-fuzz с очень крупными конечными from/to (seed=0xCAFE_BABE)', () => {
    const rand = lcg(0xcafe_babe);
    const SAMPLES = 1_000;
    const failures: string[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const from = lerp(rand(), -MAX * 0.4, MAX * 0.4);
      const to = lerp(rand(), -MAX * 0.4, MAX * 0.4);

      // Пропускаем overflow-pairs (range = ±Infinity) — они тестируются отдельно.
      if (!Number.isFinite(to - from)) continue;

      const emitted: number[] = [];
      let threw = false;
      let c;
      try {
        c = createDriver({
          from, to,
          spring: STD_SPRING,
          matchMedia: noReduceMedia(),
          onStep: (v) => emitted.push(v),
          requestFrame: (_cb) => 0,
        });
        c.pause();
        emitted.length = 0;
        const t = lerp(rand(), 0, 10);
        c.seek(t);
      } catch {
        threw = true;
      }

      if (!threw && c) c.cancel();

      if (!threw) {
        for (const v of emitted) {
          if (!Number.isFinite(v)) {
            failures.push(`sample ${i}: from=${from} to=${to} → emitted non-finite: ${v}`);
            break;
          }
        }
      }

      if (failures.length >= 10) break;
    }

    expect(
      failures,
      `Invariant 2 — seek-fuzz (крупные конечные from/to):\n${failures.join('\n')}`,
    ).toHaveLength(0);
  });
});

// ─── 4. Overflow from/to pairs ────────────────────────────────────────────────

describe('driver-scrub-fuzz: overflow from/to pairs — snap to to (инвариант 2)', () => {
  const OVERFLOW_PAIRS = [
    { from: MAX, to: -MAX },
    { from: -MAX, to: MAX },
    { from: 1e308, to: -1e308 },
    { from: -1e308, to: 1e308 },
  ];

  for (const { from, to } of OVERFLOW_PAIRS) {
    it(`createDriver(${from} → ${to}) эмитирует конечное (snap to to)`, async () => {
      const emitted: number[] = [];
      const c = createDriver({
        from, to,
        spring: STD_SPRING,
        matchMedia: noReduceMedia(),
        onStep: (v) => emitted.push(v),
        requestFrame: (_cb) => 0,
      });
      await c;
      expect(emitted.length).toBeGreaterThanOrEqual(1);
      for (const v of emitted) {
        expect(Number.isFinite(v), `overflow pair emitted non-finite: ${v}`).toBe(true);
      }
      expect(emitted[emitted.length - 1]).toBe(to);
    });
  }
});
