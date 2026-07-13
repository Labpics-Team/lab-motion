/**
 * test/compositor-retarget-cache.test.ts — поведение кэша при ретаргете (M2).
 * Классы: А (кэш-ключ учитывает засеянную скорость v0), В (детерминизм эмиссии
 * ретаргета через кэш), Д (RED: ретаргет обходит кэш → рост size на повторе).
 *
 * Контекст: ретаргет пере-компилирует linear() с НОВОЙ начальной скоростью
 * (v0 = velocity/range) — тот же путь compileSpringLinear ЧЕРЕЗ кэш, БЕЗ обхода.
 * Ключ кэша хранит v0 точно, поэтому идентичные условия ретаргета делят план,
 * а даже соседние скорости получают свой (корректность важнее хит-рейта).
 */

import { describe, expect, it } from 'vitest';
import {
  createSpringLinearCache,
  compileSpringLinear,
  CompositorSpring,
} from '../src/compositor/index.js';
import type { SpringParams } from '../src/spring.js';

const STIFF: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

/** Фейк-Element со spy на .animate (для контроллера). */
function fakeElement() {
  const calls: { keyframes: Record<string, string | number>[]; timing: Record<string, unknown> }[] = [];
  return {
    calls,
    el: {
      animate(keyframes: Record<string, string | number>[], timing: Record<string, unknown>) {
        calls.push({ keyframes, timing });
        return { cancelled: false, cancel() { this.cancelled = true; } };
      },
    },
  };
}

describe('compositor retarget: кэш по засеянной скорости v0', () => {
  it('идентичные (spring, v0, tol) при ретаргете → попадание, size не растёт', () => {
    const c = createSpringLinearCache(16);
    const s1 = c.compile(STIFF, { v0: 1.5 });
    expect(c.size).toBe(1);
    const s2 = c.compile(STIFF, { v0: 1.5 });
    expect(c.size).toBe(1); // тот же ключ → попадание, не обход
    expect(s1).toBe(s2);
  });

  it('разные скорости ретаргета → разные планы и рост кэша (v0 в ключе)', () => {
    const c = createSpringLinearCache(16);
    const a = c.compile(STIFF, { v0: 0 });
    const b = c.compile(STIFF, { v0: 2 });
    const d = c.compile(STIFF, { v0: -2 });
    expect(a).not.toBe(b);
    expect(b).not.toBe(d);
    expect(c.size).toBe(3);
  });

  it('ретаргет-компиляция детерминирована: v0 через общий кэш бит-в-бит стабильна', () => {
    // Дважды «ретаргетим» те же условия через ОБЩИЙ compileSpringLinear — строка
    // байт-идентична (чистая функция поверх кэша).
    expect(compileSpringLinear(STIFF, { v0: 0.75 })).toBe(compileSpringLinear(STIFF, { v0: 0.75 }));
  });

  it('exact v0: соседние скорости не смешивают физику, повтор даёт hit', () => {
    const c = createSpringLinearCache(16);
    c.compile(STIFF, { v0: 1 });
    c.compile(STIFF, { v0: 1 + 1e-9 });
    expect(c.size).toBe(2);
    c.compile(STIFF, { v0: 1 });
    expect(c.size).toBe(2);
  });
});

describe('compositor retarget: контроллер эмитит через кэш (детерминизм)', () => {
  it('два одинаковых контроллера при равном elapsed и цели → идентичный easing ретаргета', () => {
    const mk = () => {
      const f = fakeElement();
      let nowMs = 0;
      const cs = new CompositorSpring({
        spring: STIFF,
        property: 'x',
        from: 0,
        to: 100,
        target: f.el,
        now: () => nowMs,
      });
      cs.start();
      nowMs = 90; // 0.09 с в полёте
      cs.retarget(300);
      return String(f.calls[1]!.timing['easing']);
    };
    // Один и тот же расчёт (та же математика через кэш) → байт-идентичная кривая.
    expect(mk()).toBe(mk());
  });
});
