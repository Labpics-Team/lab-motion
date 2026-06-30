/**
 * Тест: fuzz-тест конечности (FINITENESS GUARD) — 10k+ входов.
 * Класс В (Property/Fuzz): любые входы → никогда NaN/Infinity на выходе.
 *
 * Покрытые граничные случаи:
 *   1. Случайные числа из всего диапазона float64
 *   2. Overflow-края: |from| + |to| > Number.MAX_VALUE
 *      → range = to - from переполняется в ±Infinity
 *   3. Специальные значения: NaN, ±Infinity, ±0, subnormals
 *   4. Hostile t: NaN, ±Infinity, значения вне [0,1]
 *   5. Все единицы CSS
 *   6. Цветовые каналы: RGB и HSL интерполяция
 *   7. TransformState с экстремальными значениями
 *
 * RED-доказательство (mutation proof):
 *   Если УБРАТЬ строку `clampFinite(raw)` в interpolateUnit и заменить на `raw`:
 *     → overflow-входы (fuzz case 2) вернут Infinity
 *     → тест "вывод всегда конечен" упадёт.
 *   Если УБРАТЬ страж hostile-t в interpolateUnit:
 *     → t=NaN → result = NaN (NaN * range = NaN) → тест "t=NaN" упадёт.
 *
 * Детерминизм: используется LCG (линейный конгруэнтный генератор) с фиксированным
 * seed — результат одинаков на любой платформе (без Math.random).
 */

import { describe, expect, it } from 'vitest';
import {
  interpolateUnit,
  interpolateColor,
  interpolateTransform,
  interpolate,
  parseUnit,
  parseColor,
} from '../src/value/index.js';

// ── Детерминированный PRNG (LCG) ──────────────────────────────────────────────

/**
 * Линейный конгруэнтный генератор (Knuth).
 * Детерминированный: одинаковый seed → одинаковая последовательность.
 */
function makeLcg(seed: number) {
  let s = seed >>> 0; // uint32
  return {
    /** Следующий uint32 [0, 2^32) */
    next(): number {
      s = Math.imul(1664525, s) + 1013904223;
      return s >>> 0;
    },
    /** Float в [0,1) */
    nextFloat(): number {
      return this.next() / 0x100000000;
    },
    /** Float из всего диапазона float64 */
    nextFull(): number {
      const u = this.next();
      // Иногда возвращаем экстремальные значения
      const r = u % 16;
      if (r === 0) return NaN;
      if (r === 1) return Infinity;
      if (r === 2) return -Infinity;
      if (r === 3) return Number.MAX_VALUE;
      if (r === 4) return -Number.MAX_VALUE;
      if (r === 5) return Number.MIN_VALUE;
      if (r === 6) return 0;
      if (r === 7) return -0;
      // Случайный float от -1e308 до 1e308
      const sign = (this.next() & 1) === 0 ? 1 : -1;
      const exp = this.nextFloat() * 308;
      return sign * Math.pow(10, exp) * this.nextFloat();
    },
  };
}

// ── Утилиты проверки ──────────────────────────────────────────────────────────

function assertFiniteOutput(result: string | number, label: string): void {
  if (typeof result === 'number') {
    expect(Number.isFinite(result), `${label}: число должно быть конечным, получено ${result}`)
      .toBe(true);
  } else {
    // Строка не должна содержать NaN или Infinity
    expect(result.includes('NaN'), `${label}: строка содержит NaN: "${result}"`).toBe(false);
    expect(result.includes('Infinity'), `${label}: строка содержит Infinity: "${result}"`).toBe(false);
    // Числа в строке должны быть конечными
    const numPattern = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
    const nums = result.match(numPattern) ?? [];
    for (const n of nums) {
      const v = parseFloat(n);
      expect(Number.isFinite(v), `${label}: число ${n} в строке "${result}" не конечно`).toBe(true);
    }
  }
}

// ── FUZZ: interpolateUnit ─────────────────────────────────────────────────────

describe('FUZZ interpolateUnit: 10 000 входов никогда не дают NaN/Infinity', () => {
  const UNITS = ['px', '%', 'deg', 'rem', 'vh', 'vw', 'em', 'rad', 'turn', ''];
  const N = 10_000;

  it(`${N} случайных пар (from, to, t) → всегда конечный вывод`, () => {
    const rng = makeLcg(0xdeadbeef);
    let count = 0;

    for (let i = 0; i < N; i++) {
      const fromVal = rng.nextFull();
      const toVal = rng.nextFull();
      const t = rng.nextFull();
      const unit = UNITS[rng.next() % UNITS.length];

      // Создаём ParsedUnit напрямую (обходим parse, чтобы тестировать interpolate в чистом виде)
      const from = { kind: 'unit' as const, value: isNaN(fromVal) ? 0 : isFinite(fromVal) ? fromVal : (fromVal > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE), unit };
      const to   = { kind: 'unit' as const, value: isNaN(toVal) ? 0 : isFinite(toVal) ? toVal : (toVal > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE), unit };

      const result = interpolateUnit(from, to, t);
      assertFiniteOutput(result, `iter ${i}: from=${fromVal} to=${toVal} t=${t} unit=${unit}`);
      count++;
    }

    expect(count).toBe(N);
  });

  it('overflow-края: |from| + |to| > MAX_VALUE → конечный вывод', () => {
    // Именно этот класс вызывает переполнение range = to - from → ±Infinity
    const overflowCases: Array<[number, number, number]> = [
      [Number.MAX_VALUE * 0.9, -Number.MAX_VALUE * 0.9, 0.5],
      [Number.MAX_VALUE, 0, 0.5],
      [0, Number.MAX_VALUE, 0.5],
      [-Number.MAX_VALUE, Number.MAX_VALUE, 0.5],
      [Number.MAX_VALUE, Number.MAX_VALUE, 0.5],
      [-Number.MAX_VALUE, -Number.MAX_VALUE, 0.5],
      [Number.MAX_VALUE * 0.6, Number.MAX_VALUE * 0.6, 0.5],
      [Number.MAX_VALUE, -Number.MAX_VALUE, 0.0],
      [Number.MAX_VALUE, -Number.MAX_VALUE, 1.0],
      [Number.MAX_VALUE, -Number.MAX_VALUE, 0.5],
    ];

    for (const [fv, tv, t] of overflowCases) {
      const from = { kind: 'unit' as const, value: fv, unit: 'px' };
      const to   = { kind: 'unit' as const, value: tv, unit: 'px' };
      const result = interpolateUnit(from, to, t);
      assertFiniteOutput(
        result,
        `overflow: from=${fv} to=${tv} t=${t}`,
      );
    }
  });

  it('t = Infinity → конечный вывод (равен to)', () => {
    const from = { kind: 'unit' as const, value: 0, unit: 'px' };
    const to   = { kind: 'unit' as const, value: 100, unit: 'px' };
    const result = interpolateUnit(from, to, Infinity);
    assertFiniteOutput(result, 't=+Infinity');
    expect(result).toBe('100px');
  });

  it('t = -Infinity → конечный вывод (равен from)', () => {
    const from = { kind: 'unit' as const, value: 0, unit: 'px' };
    const to   = { kind: 'unit' as const, value: 100, unit: 'px' };
    const result = interpolateUnit(from, to, -Infinity);
    assertFiniteOutput(result, 't=-Infinity');
    expect(result).toBe('0px');
  });

  it('t = NaN → конечный вывод (равен from)', () => {
    const from = { kind: 'unit' as const, value: 42, unit: 'px' };
    const to   = { kind: 'unit' as const, value: 100, unit: 'px' };
    const result = interpolateUnit(from, to, NaN);
    assertFiniteOutput(result, 't=NaN');
    expect(result).toBe('42px');
  });
});

// ── FUZZ: interpolateColor ────────────────────────────────────────────────────

describe('FUZZ interpolateColor: 2 000 входов', () => {
  const N = 2_000;

  it(`${N} случайных пар rgb-цветов → вывод всегда конечный`, () => {
    const rng = makeLcg(0xcafe1234);

    for (let i = 0; i < N; i++) {
      const fr = rng.next() % 256;
      const fg = rng.next() % 256;
      const fb = rng.next() % 256;
      const fa = rng.nextFloat();
      const tr = rng.next() % 256;
      const tg = rng.next() % 256;
      const tb = rng.next() % 256;
      const ta = rng.nextFloat();
      const t = rng.nextFull();

      const from = { kind: 'color' as const, r: fr, g: fg, b: fb, a: fa, format: 'rgb' as const };
      const to   = { kind: 'color' as const, r: tr, g: tg, b: tb, a: ta, format: 'rgb' as const };

      const result = interpolateColor(from, to, t);
      assertFiniteOutput(result, `rgb iter ${i}`);
    }
  });

  it('HSL-интерполяция 1 000 входов → конечный вывод', () => {
    const rng = makeLcg(0xbeefdead);

    for (let i = 0; i < 1_000; i++) {
      const fh = rng.nextFloat() * 360;
      const fs = rng.nextFloat();
      const fl = rng.nextFloat();
      const th = rng.nextFloat() * 360;
      const ts = rng.nextFloat();
      const tl = rng.nextFloat();
      const t = rng.nextFull();

      const from = parseColor(`hsl(${fh}, ${fs * 100}%, ${fl * 100}%)`);
      const to_  = parseColor(`hsl(${th}, ${ts * 100}%, ${tl * 100}%)`);

      if (!from || !to_) continue;

      const result = interpolateColor(from, to_, t);
      assertFiniteOutput(result, `hsl iter ${i}`);
    }
  });
});

// ── FUZZ: interpolateTransform ────────────────────────────────────────────────

describe('FUZZ interpolateTransform: 2 000 входов', () => {
  const N = 2_000;

  it(`${N} случайных TransformState → вывод всегда конечный`, () => {
    const rng = makeLcg(0x12345678);

    for (let i = 0; i < N; i++) {
      const t = rng.nextFull();
      const from = {
        x: rng.nextFull(),
        y: rng.nextFull(),
        scale: rng.nextFloat() * 5,
        rotate: rng.nextFull(),
        skewX: rng.nextFull(),
        skewY: rng.nextFull(),
      };
      const to = {
        x: rng.nextFull(),
        y: rng.nextFull(),
        scale: rng.nextFloat() * 5,
        rotate: rng.nextFull(),
        skewX: rng.nextFull(),
        skewY: rng.nextFull(),
      };

      const result = interpolateTransform(from, to, t);
      if (result !== 'none') {
        assertFiniteOutput(result, `transform iter ${i}`);
      }
    }
  });

  it('overflow-края в TransformState → "none" или конечная строка', () => {
    const extremes = [
      { x: Number.MAX_VALUE, y: -Number.MAX_VALUE },
      { rotate: Number.MAX_VALUE },
      { scale: Number.MAX_VALUE },
      { skewX: Number.MAX_VALUE, skewY: -Number.MAX_VALUE },
    ];

    for (const state of extremes) {
      const r = interpolateTransform({}, state, 0.5);
      expect(['none', ...[]].includes(r) || typeof r === 'string').toBe(true);
      if (r !== 'none') {
        assertFiniteOutput(r, `extreme transform: ${JSON.stringify(state)}`);
      }
    }
  });
});

// ── FUZZ: unified interpolate ─────────────────────────────────────────────────

describe('FUZZ unified interpolate: 3 000 смешанных входов', () => {
  const N = 3_000;

  it(`${N} смешанных пар ValueAST → вывод всегда конечный`, () => {
    const rng = makeLcg(0xabcdef01);

    for (let i = 0; i < N; i++) {
      const kind = rng.next() % 3;
      const t = rng.nextFull();

      let from: Parameters<typeof interpolate>[0];
      let to: Parameters<typeof interpolate>[1];

      if (kind === 0) {
        // unit × unit
        const fv = rng.nextFull();
        const tv = rng.nextFull();
        from = { kind: 'unit', value: isFinite(fv) ? fv : 0, unit: 'px' };
        to   = { kind: 'unit', value: isFinite(tv) ? tv : 0, unit: 'px' };
      } else if (kind === 1) {
        // color × color
        from = { kind: 'color', r: rng.next() % 256, g: rng.next() % 256,
                 b: rng.next() % 256, a: rng.nextFloat(), format: 'rgb' };
        to   = { kind: 'color', r: rng.next() % 256, g: rng.next() % 256,
                 b: rng.next() % 256, a: rng.nextFloat(), format: 'rgb' };
      } else {
        // unit × color (дискретный свап)
        from = { kind: 'unit', value: rng.nextFloat() * 100, unit: 'px' };
        to   = { kind: 'color', r: rng.next() % 256, g: rng.next() % 256,
                 b: rng.next() % 256, a: 1, format: 'rgb' };
      }

      const result = interpolate(from, to, t);
      assertFiniteOutput(result, `unified iter ${i} kind=${kind}`);
    }
  });
});
