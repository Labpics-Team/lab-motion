/**
 * test/animate-mini-interpolate-fuzz.test.ts — фаззинг финитности codec.interpolate.
 *
 * Инвариант кодека: interpolate(from, to) на ЛЮБОМ прогрессе p (включая
 * враждебные −∞/+∞/NaN/за-края) даёт КОНЕЧНЫЙ сериализуемый результат — движок
 * никогда не эмитит NaN/Infinity в стиль. Seeded-LCG (Park-Miller, конвенция
 * пакета) — детерминированный прогон ≥10k на каждый кодек mini.
 *
 * Вырожденное (from==to, |range|→0, hostile-p) → ровно 0-дельта или finite(...),
 * НЕ NaN. MUTATION: снять finite-страж serialize/parse → фаззер ловит NaN.
 */

import { describe, expect, it } from 'vitest';
import { cssVarCodec, numberCodec } from '../src/animate/mini-codecs.js';
import { lcg } from './animate-facade-helpers.js';

const N = 12_000;

/** Враждебные значения прогресса, подмешиваемые в равномерный [−0.5, 1.5]. */
const HOSTILE_P = [0, 1, -0, NaN, Infinity, -Infinity, 1e308, -1e308, 1 + 1e-16, -1e-16];

function isFiniteSerialized(v: string | number): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return !/NaN|Infinity/i.test(v) && [...v.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].every((m) => Number.isFinite(Number(m[0])));
}

describe('fuzz — numberCodec.interpolate финитность (12k)', () => {
  it('любой p даёт конечное число', () => {
    const rnd = lcg(1234567);
    for (let i = 0; i < N; i++) {
      const from = (rnd() - 0.5) * 2e6;
      const to = (rnd() - 0.5) * 2e6;
      const interp = numberCodec._interpolate(from, to);
      const p = i % 40 === 0 ? HOSTILE_P[(i / 40) % HOSTILE_P.length]! : (rnd() - 0.5) * 2 + 0.5;
      const out = numberCodec._serialize(interp(p));
      expect(isFiniteSerialized(out), `from=${from} to=${to} p=${p} → ${out}`).toBe(true);
    }
  });

  it('вырожденное from==to даёт ровно from (0-дельта)', () => {
    const rnd = lcg(99);
    for (let i = 0; i < 2000; i++) {
      const v = (rnd() - 0.5) * 1e6;
      const interp = numberCodec._interpolate(v, v);
      expect(numberCodec._serialize(interp(rnd() * 3 - 1))).toBe(v);
    }
  });
});

describe('fuzz — cssVarCodec.interpolate финитность (12k)', () => {
  it('число+юнит на любом p сериализуется конечно', () => {
    const rnd = lcg(7654321);
    const units = ['px', '%', 'em', 'rem', 'vh', ''];
    for (let i = 0; i < N; i++) {
      const u = units[Math.floor(rnd() * units.length)]!;
      const from = cssVarCodec._parse(`${((rnd() - 0.5) * 2e4).toFixed(3)}${u}`, '--v');
      const to = cssVarCodec._parse(`${((rnd() - 0.5) * 2e4).toFixed(3)}${u}`, '--v');
      const interp = cssVarCodec._interpolate(from, to);
      const p = i % 40 === 0 ? HOSTILE_P[(i / 40) % HOSTILE_P.length]! : (rnd() - 0.5) * 2 + 0.5;
      const out = cssVarCodec._serialize(interp(p));
      expect(isFiniteSerialized(out), `p=${p} → ${out}`).toBe(true);
    }
  });

  // Зеркало numberCodec-регресса: вырожденное from==to (|range|=0) на ЛЮБОМ p
  // (включая враждебный) сериализуется конечно — 0-дельта не течёт NaN/∞ в CSS.
  it('вырожденное from==to на hostile p сериализуется конечно', () => {
    const rnd = lcg(202406);
    const units = ['px', '%', 'em', 'rem', ''];
    for (let i = 0; i < 2000; i++) {
      const u = units[Math.floor(rnd() * units.length)]!;
      const v = cssVarCodec._parse(`${((rnd() - 0.5) * 1e4).toFixed(2)}${u}`, '--v');
      const interp = cssVarCodec._interpolate(v, v);
      const p = i % 10 === 0 ? HOSTILE_P[(i / 10) % HOSTILE_P.length]! : rnd() * 3 - 1;
      const out = cssVarCodec._serialize(interp(p));
      expect(isFiniteSerialized(out), `u=${u} p=${p} → ${out}`).toBe(true);
      // Конечный p → ровно исходное значение (0-дельта, без дрейфа юнита/числа).
      if (Number.isFinite(p)) expect(out).toBe(cssVarCodec._serialize(v));
    }
  });
});
