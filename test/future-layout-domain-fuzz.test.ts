/**
 * test/future-layout-domain-fuzz.test.ts — GREEN: 10 000 seeded-кейсов
 * сопряжённого домена (спека «Fuzz»).
 *
 * Покрытие режимов: underdamped / near-critical / critical / overdamped;
 * малые/большие ширины; малый/большой span; near-singular ширины;
 * отрицательная стартовая скорость (fail-closed); serialization boundaries
 * (повторные offsets через cache). Содержательность домена обязательна:
 * ассерт, что принятые кейсы — большинство, а не мгновенно отклонённые входы.
 */

import { describe, expect, it } from 'vitest';
import {
  certifyPositivity,
  SURFACE_PRECISION_BUDGET_PX,
  tryCompileSurfaceArtifact,
} from '../src/future-layout/index.js';
import { lcg } from './projection-helpers.js';

const SEEDS = 10_000;

interface Case {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly w0: number;
  readonly w1: number;
  readonly v0: number;
}

function makeCase(rand: () => number, regime: number): Case {
  const mass = 0.5 + rand() * 2.5;
  const stiffness = 20 * Math.pow(50, rand());
  const zeta = regime === 0
    ? 0.15 + rand() * 0.7 // underdamped
    : regime === 1
      ? 0.9 + rand() * 0.2 // near-critical
      : regime === 2
        ? 0.98 + rand() * 0.04 // critical
        : 1.2 + rand() * 1.8; // overdamped
  const damping = zeta * 2 * Math.sqrt(mass * stiffness);

  const singular = rand() < 0.12;
  const w0 = singular
    ? 1 + rand() * 1.5 // near-singular
    : Math.exp(rand() * Math.log(4000));
  let w1: number;
  const kind = rand();
  if (kind < 0.25) {
    // Малый span (в т.ч. serialization boundary: повторяемый offset):
    const deltaPx = (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 3);
    w1 = Math.max(0.5, w0 + deltaPx);
  } else if (kind < 0.45) {
    w1 = w0 * (0.2 + rand() * 0.6); // сжатие, риск overshoot через ноль
  } else {
    w1 = w0 * (1.2 + rand() * 5); // расширение
  }
  const v0 = rand() < 0.15 ? -rand() * 30 : 0;
  return { mass, stiffness, damping, w0, w1, v0 };
}

/** Независимая плотная проверка coupling-bound между reciprocal stops. */
function verifyCouplingBound(a: NonNullable<ReturnType<typeof tryCompileSurfaceArtifact>>): number {
  const delta = 1 / a.toWidth - 1 / a.fromWidth;
  const contentW = Math.max(a.fromWidth, a.toWidth);
  let maxErr = 0;
  const pCount = a.samples.length / 2;
  const rCount = a.reciprocalSamples.length / 2;
  const qAt = (percent: number): number => {
    let lo = 0;
    let hi = rCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a.reciprocalSamples[mid * 2] < percent) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo > 0 && a.reciprocalSamples[lo * 2] > percent ? lo - 1 : lo;
    const next = Math.min(idx + 1, rCount - 1);
    const x0 = a.reciprocalSamples[idx * 2];
    const x1 = a.reciprocalSamples[next * 2];
    if (x1 === x0) return a.reciprocalSamples[idx * 2 + 1];
    const q0 = a.reciprocalSamples[idx * 2 + 1];
    const q1 = a.reciprocalSamples[next * 2 + 1];
    return q0 + (q1 - q0) * ((percent - x0) / (x1 - x0));
  };
  for (let i = 0; i < pCount - 1; i++) {
    const x0 = a.samples[i * 2];
    const x1 = a.samples[(i + 1) * 2];
    const p0 = a.samples[i * 2 + 1];
    const p1 = a.samples[(i + 1) * 2 + 1];
    for (let k = 0; k <= 16; k++) {
      const percent = x0 + ((x1 - x0) * k) / 16;
      const w = a.fromWidth + (a.toWidth - a.fromWidth) * (p0 + ((p1 - p0) * k) / 16);
      const qTrue = (1 / w - 1 / a.fromWidth) / delta;
      const err = w * contentW * Math.abs(delta) * Math.abs(qAt(percent) - qTrue);
      if (err > maxErr) maxErr = err;
    }
  }
  return maxErr;
}

describe('fuzz: 10 000 seeded сопряжённых артефактов', () => {
  it('fail-closed позитивность, coupling budget, монотонность A, содержательный домен', () => {
    const rand = lcg(20260804);
    let accepted = 0;
    let rejectedZeroCrossing = 0;
    let rejectedBudget = 0;
    let v0Cases = 0;

    for (let seed = 0; seed < SEEDS; seed++) {
      const regime = seed % 4;
      const c = makeCase(rand, regime);
      if (c.v0 !== 0) v0Cases++;
      const artifact = tryCompileSurfaceArtifact(
        { mass: c.mass, stiffness: c.stiffness, damping: c.damping },
        c.w0,
        c.w1,
        undefined,
        undefined,
        c.v0,
      );
      if (artifact === undefined) {
        // Fail-closed обязан быть наблюдаем (особенно при v0<0 и сжатии):
        if (c.v0 < 0 || c.w1 < c.w0) rejectedZeroCrossing++;
        else rejectedBudget++;
        continue;
      }
      accepted++;

      // Позитивность: независимый пересчёт min W по serialized stops.
      let minW = Number.POSITIVE_INFINITY;
      for (let i = 0; i < artifact.samples.length / 2; i++) {
        const w = c.w0 + (c.w1 - c.w0) * artifact.samples[i * 2 + 1];
        if (w < minW) minW = w;
      }
      expect(minW).toBeGreaterThan(0);
      expect(artifact.minWidth).toBeCloseTo(minW, 12);
      expect(certifyPositivity(artifact, 0)).toBe(true);

      // Монотонная A с точными endpoints.
      expect(artifact.blendSamples[0]).toBe(0);
      expect(artifact.blendSamples[artifact.blendSamples.length - 1]).toBe(1);
      for (let i = 1; i < artifact.blendSamples.length; i++) {
        expect(artifact.blendSamples[i]).toBeGreaterThanOrEqual(artifact.blendSamples[i - 1]);
      }

      // Ни один CSS-токен не несёт Infinity/NaN.
      expect(/NaN|Infinity/.test(artifact.reciprocalEasing + artifact.easing + artifact.blendEasing)).toBe(false);

      // Плотный независимый differential coupling-bound (каждый 20-й кейс).
      if (seed % 20 === 0) {
        const maxErr = verifyCouplingBound(artifact);
        expect(maxErr).toBeLessThanOrEqual(SURFACE_PRECISION_BUDGET_PX * (1 + 1e-9));
      }
    }

    // Содержательность домена: не преимущественно отклонённые входы.
    expect(accepted).toBeGreaterThan(SEEDS * 0.5);
    expect(v0Cases).toBeGreaterThan(SEEDS * 0.1);
    // Fail-closed реально срабатывал на v0<0/сжатии:
    expect(rejectedZeroCrossing + rejectedBudget).toBeGreaterThan(0);
  }, 120_000);
});
