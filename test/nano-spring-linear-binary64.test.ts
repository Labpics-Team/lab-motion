import { describe, expect, it } from 'vitest';
import { BASE_GRID_MAX } from '../src/compositor/segmenter.js';
import {
  springLinear,
  type NanoSpring,
} from '../src/nano/spring-linear.js';

const EPSILON = 1e-3;

/**
 * Независимый reference старого underdamped-закона до size-only переписывания.
 * Намеренно не вызывает production duration logic: этот тест должен стать RED,
 * если algebraic golf изменит хотя бы один binary64 бит или CSS-артефакт.
 */
function referenceUnderdamped(
  input: NanoSpring,
  durationScale = 1,
): [number, string] {
  const w = Math.sqrt(input.stiffness / input.mass);
  const a = input.damping / input.mass / 2;
  const d = Math.sqrt(Math.abs(w * w - a * a));
  const critical = d <= w * Math.sqrt(Number.EPSILON);
  if (!(a < w && !critical)) throw new Error('reference expects underdamped input');

  const duration = Math.max(
    Math.log(w / d / EPSILON) / a,
    Math.log(w * w / d / (30 * EPSILON)) / a,
  ) * durationScale;
  if (!Number.isFinite(duration)) throw new RangeError('spring is not representable');

  const count = Math.ceil(duration * w / Math.sqrt(8 * EPSILON));
  if (!(count <= BASE_GRID_MAX)) throw new RangeError('spring is not representable');

  const sample = (t: number) => 1 - Math.exp(-a * t)
    * (Math.cos(d * t) + a / d * Math.sin(d * t));
  const points: number[] = [];
  for (let index = 0; index <= count; index++) {
    points.push(Math.round(sample(duration * index / count) * 1e4) / 1e4);
  }
  points[count] = 1;
  return [duration * 1000, `linear(${points})`];
}

function expectBitExact(input: NanoSpring): void {
  const expected = referenceUnderdamped(input);
  const actual = springLinear(input);
  expect(Object.is(actual[0], expected[0])).toBe(true);
  expect(actual[1]).toBe(expected[1]);
}

describe('nano springLinear: binary64 underdamped envelope', () => {
  it.each([
    [{ mass: 1, stiffness: 100, damping: 10 }, 'position bound'],
    [{ mass: 1, stiffness: 10_000, damping: 100 }, 'velocity bound'],
    [{ mass: 1, stiffness: 100, damping: 20 * (1 - 1e-8) }, 'near critical'],
    [{ mass: 1, stiffness: 400, damping: 2 }, 'light damping'],
  ] as const)('совпадает со старым законом бит-в-бит: %s (%s)', (input) => {
    expectBitExact(input);
  });

  it('2^-26 бит-в-бит равен sqrt(EPSILON) и различает критическую границу', () => {
    const root = 2 ** -26;
    expect(Object.is(root, Math.sqrt(Number.EPSILON))).toBe(true);

    // Один ULP ниже a=w даёт d между правильным корнем и намеренно удвоенным
    // порогом: 2^-25 ошибочно классифицировал бы этот underdamped случай critical.
    const a = 1 - Number.EPSILON;
    const d = Math.sqrt(1 - a * a);
    expect(d).toBeGreaterThan(root);
    expect(d).toBeLessThan(2 ** -25);
    expectBitExact({ mass: 1, stiffness: 1, damping: 2 * a });
  });

  it('сохраняет округлённое w*w, а не подменяет его исходным k/m', () => {
    const input = { mass: 1, stiffness: 902, damping: 60 } satisfies NanoSpring;
    const ratio = input.stiffness / input.mass;
    const roundedSquare = Math.sqrt(ratio) ** 2;

    // sqrt → square уже округлился на один ULP: именно это значение исторически
    // использует формула, и замена кэша на k/m изменила бы duration bit-pattern.
    expect(Object.is(roundedSquare, ratio)).toBe(false);
    expectBitExact(input);
  });

  it('держит seeded-класс обоих settle bounds без расхождений', () => {
    let seed = 0x6e61_6e6f;
    const random = () => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0)
      / 2 ** 32;
    let positionBoundCases = 0;
    let velocityBoundCases = 0;

    for (let sample = 0; sample < 512; sample++) {
      const mass = 10 ** (-3 + 6 * random());
      const w = 10 ** (-1 + 4 * random());
      const dampingRatio = 0.05 + 0.949_999 * random();
      const input = {
        mass,
        stiffness: mass * w * w,
        damping: 2 * mass * w * dampingRatio,
      } satisfies NanoSpring;

      if (w <= 30) positionBoundCases++;
      else velocityBoundCases++;
      expectBitExact(input);
    }

    expect(positionBoundCases).toBeGreaterThan(0);
    expect(velocityBoundCases).toBeGreaterThan(0);
  });

  it('positive controls ловят exact-duration и артефактный sabotage', () => {
    const input = { mass: 1, stiffness: 170, damping: 26 } satisfies NanoSpring;
    const actual = springLinear(input);
    const durationSabotage = referenceUnderdamped(input, 1 + 1e-12);
    const artifactSabotage = referenceUnderdamped(input, 1.001);

    expect(Object.is(durationSabotage[0], actual[0])).toBe(false);
    expect(artifactSabotage[1]).not.toBe(actual[1]);
  });
});
