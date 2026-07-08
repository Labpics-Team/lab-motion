/**
 * test/animate-facade-finiteness-fuzz.test.ts — property/fuzz финитности ./animate.
 *
 * Класс: В (property + seeded fuzz) — канон fuzz-гейтов пакета (инвариант 2):
 *   P1. НИ ОДНА запись в стиль не содержит NaN/Infinity — на ВСЁМ props-спейсе
 *       (transform-шортхенды, opacity, юниты, цвета; враждебные величины,
 *       произвольные dt кадров, stagger, оба режима spring/tween).
 *   P2. Не-конечный вход (NaN/±Infinity в props/options) → РАННИЙ
 *       MotionParamError, ноль записей — либо вход валиден и записи конечны.
 *   P3. Детерминизм: один seed + инжектируемый requestFrame → бит-идентичный
 *       журнал записей на повторном прогоне.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Рождён на пустой заглушке — красный. Mutation proof: убрать финитный страж
 * в рендере канала (писать сырое значение) и скормить 1e308-пары → P1 красный.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import {
  allWritesFinite,
  fakeEl,
  lcg,
  makeClock,
  pickAnimate,
  type StyleWrite,
} from './animate-facade-helpers.js';

const animate = pickAnimate(animateApi as Record<string, unknown>);

/** Генератор одного fuzz-сценария по PRNG. */
function scenario(rnd: () => number) {
  const hostileNumbers = [
    0, 1, -1, 0.5, 100, -100, 1e-12, -1e-12, 1e6, 1e150, 1e308, -1e308,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 5e-324,
  ];
  const num = () => hostileNumbers[Math.floor(rnd() * hostileNumbers.length)]!;
  const colors = ['rgb(0, 0, 0)', 'rgb(255, 255, 255)', '#ff8800', 'hsl(200, 50%, 50%)'];

  const props: Record<string, unknown> = {};
  const propPool: Array<() => void> = [
    () => (props['x'] = num()),
    () => (props['y'] = num()),
    () => (props['scale'] = Math.abs(num())),
    () => (props['rotate'] = num()),
    () => (props['opacity'] = rnd()),
    () => (props['width'] = `${Math.abs(num())}px`),
    () => (props['backgroundColor'] = colors[Math.floor(rnd() * colors.length)]!),
    () => (props['x'] = [num(), num()]),
  ];
  const nProps = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < nProps; i++) propPool[Math.floor(rnd() * propPool.length)]!();

  const useSpring = rnd() < 0.5;
  const options: Record<string, unknown> = useSpring
    ? { spring: { mass: 1, stiffness: 50 + rnd() * 400, damping: 5 + rnd() * 40 } }
    : { duration: 50 + rnd() * 500 };
  if (rnd() < 0.3) options['delay'] = rnd() * 100;
  if (rnd() < 0.3) options['stagger'] = rnd() * 60;

  const nEls = 1 + Math.floor(rnd() * 3);
  return { props, options, nEls };
}

/** Прогоняет сценарий на шаг-часах, возвращает объединённый журнал записей. */
function run(seed: number, samples: number): StyleWrite[] {
  const rnd = lcg(seed);
  const log: StyleWrite[] = [];
  for (let s = 0; s < samples; s++) {
    const { props, options, nEls } = scenario(rnd);
    const els = Array.from({ length: nEls }, () =>
      fakeEl({ width: '10px', 'background-color': 'rgb(10, 20, 30)', opacity: '1' }),
    );
    const clock = makeClock();
    try {
      animate(
        els.map((e) => e.el),
        props as Record<string, unknown>,
        { ...options, requestFrame: clock.requestFrame },
      );
    } catch {
      // Валидация имеет право отклонить враждебную комбинацию — но тогда
      // записей быть не должно (проверяется в P2 отдельно).
    }
    // Недетерминированные dt: 1..49 мс из того же PRNG.
    for (let i = 0; i < 40; i++) clock.step(1 + Math.floor(rnd() * 49));
    for (const e of els) log.push(...e.writes);
  }
  return log;
}

describe('./animate — финитность и детерминизм (Класс В, property/fuzz)', () => {
  it('P1: seeded fuzz 400 сценариев — ни одной NaN/Infinity-записи на всём props-спейсе', () => {
    const log = run(0xa11ce, 400);
    expect(log.length).toBeGreaterThan(1000); // fuzz реально что-то гонял
    expect(allWritesFinite(log)).toBe(true);
  });

  it('P2: не-конечные входы → ранний MotionParamError и ноль записей', () => {
    const hostile = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const bad of hostile) {
      for (const props of [
        { x: bad },
        { opacity: bad },
        { x: [bad, 100] },
        { x: [0, bad] },
      ] as const) {
        const f = fakeEl();
        expect(() => animate(f.el, props as unknown as Record<string, unknown>)).toThrow();
        expect(f.writes.length).toBe(0);
      }
      const f2 = fakeEl();
      expect(() => animate(f2.el, { x: 1 }, { duration: bad })).toThrow();
      expect(() => animate(f2.el, { x: 1 }, { delay: bad })).toThrow();
    }
  });

  it('P3: детерминизм — один seed → бит-идентичный журнал записей', () => {
    const a = run(0xdec0de, 60);
    const b = run(0xdec0de, 60);
    expect(a.length).toBe(b.length);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('P1-направленный: экстремальные пары from/to не пробивают финитный страж', () => {
    // |from| + |to| > MAX_VALUE → range переполняется; канал обязан снапнуться
    // к цели, а не эмитить Infinity (канон motion-value safety net).
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: [-Number.MAX_VALUE, Number.MAX_VALUE] }, { requestFrame: clock.requestFrame });
    clock.drain(16);
    expect(allWritesFinite(f.writes)).toBe(true);
  });
});
