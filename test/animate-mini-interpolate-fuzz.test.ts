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
import { colorCodec } from '../src/animate/full-codecs.js';
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
      const interp = numberCodec.interpolate(from, to);
      const p = i % 40 === 0 ? HOSTILE_P[(i / 40) % HOSTILE_P.length]! : (rnd() - 0.5) * 2 + 0.5;
      const out = numberCodec.serialize(interp(p));
      expect(isFiniteSerialized(out), `from=${from} to=${to} p=${p} → ${out}`).toBe(true);
    }
  });

  it('вырожденное from==to даёт ровно from (0-дельта)', () => {
    const rnd = lcg(99);
    for (let i = 0; i < 2000; i++) {
      const v = (rnd() - 0.5) * 1e6;
      const interp = numberCodec.interpolate(v, v);
      expect(numberCodec.serialize(interp(rnd() * 3 - 1))).toBe(v);
    }
  });
});

describe('fuzz — cssVarCodec.interpolate финитность (12k)', () => {
  it('число+юнит на любом p сериализуется конечно', () => {
    const rnd = lcg(7654321);
    const units = ['px', '%', 'em', 'rem', 'vh', ''];
    for (let i = 0; i < N; i++) {
      const u = units[Math.floor(rnd() * units.length)]!;
      const from = cssVarCodec.parse(`${((rnd() - 0.5) * 2e4).toFixed(3)}${u}`, '--v');
      const to = cssVarCodec.parse(`${((rnd() - 0.5) * 2e4).toFixed(3)}${u}`, '--v');
      const interp = cssVarCodec.interpolate(from, to);
      const p = i % 40 === 0 ? HOSTILE_P[(i / 40) % HOSTILE_P.length]! : (rnd() - 0.5) * 2 + 0.5;
      const out = cssVarCodec.serialize(interp(p));
      expect(isFiniteSerialized(out), `p=${p} → ${out}`).toBe(true);
    }
  });
});

describe('fuzz — colorCodec.interpolate финитность (12k)', () => {
  it('rgb-интерполяция на любом p — конечная css-строка', () => {
    const rnd = lcg(555);
    const hx = (): string => {
      const c = (): string => Math.floor(rnd() * 256).toString(16).padStart(2, '0');
      return `#${c()}${c()}${c()}`;
    };
    for (let i = 0; i < N; i++) {
      const from = colorCodec.parse(hx(), 'color');
      const to = colorCodec.parse(hx(), 'color');
      const interp = colorCodec.interpolate(from, to);
      const p = i % 40 === 0 ? HOSTILE_P[(i / 40) % HOSTILE_P.length]! : (rnd() - 0.5) * 2 + 0.5;
      const out = colorCodec.serialize(interp(p));
      expect(isFiniteSerialized(out), `p=${p} → ${out}`).toBe(true);
    }
  });
});
