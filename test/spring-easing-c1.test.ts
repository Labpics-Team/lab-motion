import { describe, expect, it, vi } from 'vitest';

import { springAsEasing } from '../src/spring/index.js';
import { solveSpring } from '../src/internal/solver.js';

/**
 * Issue #219. Прежняя финитная проекция масштабировала время как
 * ln(100)/(ω₀·slow) и принудительно возвращала 1 при t≥1, поэтому левый предел
 * для {m:1,k:100,c:20} равнялся 0.9439482981401192 — скачок 5.6% и ненулевая
 * скорость 0.212 в точке склейки. Кривая не была C¹-запечатанной.
 */
const CRITICAL = { mass: 1, stiffness: 100, damping: 20 };
const ZETAS = [0.05, 0.2, 0.5, 0.9, 0.999, 1, 1.001, 1.5, 4, 10];
const springAt = (zeta: number) => ({ mass: 1, stiffness: 100, damping: 2 * zeta * 10 });

describe('springAsEasing: C¹-запечатка на обоих концах', () => {
  it('правый конец сходится без скачка', () => {
    // Math.abs обязателен: без него проверка пропускает скачок ВВЕРХ.
    expect(Math.abs(1 - springAsEasing(CRITICAL)(1 - 1e-9))).toBeLessThan(1e-7);
  });

  it('скорость в правом конце гасится', () => {
    const e = springAsEasing(CRITICAL);
    expect(Math.abs((e(1) - e(1 - 1e-6)) / 1e-6)).toBeLessThan(1e-5);
  });

  it('оба конца запечатаны на всей сетке ζ', () => {
    for (const zeta of ZETAS) {
      const e = springAsEasing(springAt(zeta));
      expect(e(0)).toBe(0);
      expect(e(1)).toBe(1);
      expect(Math.abs(1 - e(1 - 1e-9))).toBeLessThan(1e-7);
      expect(Math.abs((e(1) - e(1 - 1e-6)) / 1e-6)).toBeLessThan(1e-5);
      // Старт из покоя: g′(0)=0. Проверяем именно предел, а не конечную
      // разность: у слабо демпфированной пружины горизонт достигает 295, и
      // на шаге h оценка ведёт себя как O(h) — поэтому требуем, чтобы при
      // уменьшении шага в сто раз оценка падала хотя бы на порядок.
      const at = (h: number) => Math.abs((e(h) - e(0)) / h);
      expect(at(1e-9)).toBeLessThan(at(1e-7) / 10);
    }
  });
});

describe('springAsEasing: коррекция не уводит от настоящей пружины', () => {
  it('отклонение не превышает допуск на плотной сетке', () => {
    // Горизонт для ζ=1 при допуске 0.005 равен 8.262347 в единицах τ=ω₀t.
    const settle = 8.262347 / 10;
    let maxDeviation = 0;
    const e = springAsEasing(CRITICAL);
    for (let i = 0; i <= 2000; i++) {
      const u = i / 2000;
      maxDeviation = Math.max(maxDeviation, Math.abs(e(u) - solveSpring(CRITICAL, u * settle, 0).value));
    }
    expect(maxDeviation).toBeLessThanOrEqual(0.005);
  });

  it('форма сохраняется: ζ≥1 монотонна, ζ<1 даёт овершут', () => {
    for (const zeta of [1, 1.5, 4, 10]) {
      const e = springAsEasing(springAt(zeta));
      let previous = -1;
      for (let i = 0; i <= 200; i++) {
        const value = e(i / 200);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
        expect(value).toBeLessThanOrEqual(1 + 1e-9);
        previous = value;
      }
    }
    const wobbly = springAsEasing(springAt(0.5));
    let peak = 0;
    for (let i = 0; i <= 200; i++) peak = Math.max(peak, wobbly(i / 200));
    expect(peak).toBeGreaterThan(1.01);
  });
});

describe('springAsEasing: горизонт зависит только от формы', () => {
  it('scale-equivalent пружины дают бит-в-бит одну кривую', () => {
    for (const lambda of [1e-3, 1, 1e3]) {
      const scaled = springAsEasing({
        mass: lambda * CRITICAL.mass,
        stiffness: lambda * CRITICAL.stiffness,
        damping: lambda * CRITICAL.damping,
      });
      const reference = springAsEasing(CRITICAL);
      for (let i = 0; i <= 20; i++) {
        expect(Object.is(scaled(i / 20), reference(i / 20))).toBe(true);
      }
    }
  });

  it('горизонт непрерывен через критическое демпфирование', () => {
    // Наивная per-branch огибающая имеет полюс 1/√|ζ²−1| и давала разрыв
    // 12.93 → 8.26 → 12.22. Меряем через значение кривой в середине.
    const mid = (zeta: number) => springAsEasing(springAt(zeta))(0.5);
    expect(Math.abs(mid(1 - 1e-6) - mid(1))).toBeLessThan(1e-3);
    expect(Math.abs(mid(1 + 1e-6) - mid(1))).toBeLessThan(1e-3);
  });
});

describe('springAsEasing: горячий путь и краевые входы', () => {
  it('валидация выполняется один раз на конструкцию, а не на сэмпл', async () => {
    vi.resetModules();
    const spy = vi.fn();
    vi.doMock('../src/spring.js', async () => {
      const actual = await vi.importActual<typeof import('../src/spring.js')>('../src/spring.js');
      return { ...actual, spring: (...args: Parameters<typeof actual.spring>) => (spy(), actual.spring(...args)) };
    });
    const { springAsEasing: mocked } = await import('../src/spring/index.js');
    const easing = mocked(CRITICAL);
    for (let i = 0; i < 1000; i++) easing(i / 1000);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.doUnmock('../src/spring.js');
    vi.resetModules();
  });

  it('незатухающая пружина отвергается собственным кодом easing', () => {
    expect(() => springAsEasing({ mass: 1, stiffness: 100, damping: 0 })).toThrow(
      expect.objectContaining({ code: 'LM169' }),
    );
  });

  it('NaN трактуется как ноль, края клампятся', () => {
    const e = springAsEasing(CRITICAL);
    expect(e(Number.NaN)).toBe(0);
    expect(e(-5)).toBe(0);
    expect(e(5)).toBe(1);
  });
});

/**
 * Канонический приоритет ошибок (бриф D2): LM088 → LM089 → LM090 → LM169 →
 * LM091. Табличный корпус перебирает сочетания нескольких невалидных полей:
 * побеждать обязан код старшего приоритета, а не порядок проверок в коде.
 */
describe('приоритет ошибок при нескольких невалидных полях', () => {
  const CASES: readonly [label: string, p: { mass: number; stiffness: number; damping: number }, code: string][] = [
    ['масса 0 + демпфирование 0', { mass: 0, stiffness: 100, damping: 0 }, 'LM088'],
    ['масса NaN + жёсткость −1', { mass: Number.NaN, stiffness: -1, damping: 20 }, 'LM088'],
    ['масса ∞ + демпфирование −5', { mass: Number.POSITIVE_INFINITY, stiffness: 100, damping: -5 }, 'LM088'],
    ['жёсткость −1 + демпфирование 0', { mass: 1, stiffness: -1, damping: 0 }, 'LM089'],
    ['жёсткость NaN + демпфирование −5', { mass: 1, stiffness: Number.NaN, damping: -5 }, 'LM089'],
    ['демпфирование −5 (поле бьёт LM169)', { mass: 1, stiffness: 100, damping: -5 }, 'LM090'],
    ['демпфирование NaN', { mass: 1, stiffness: 100, damping: Number.NaN }, 'LM090'],
    ['демпфирование ровно 0 при валидных полях', { mass: 1, stiffness: 100, damping: 0 }, 'LM169'],
    ['валидные поля, бюджет не выполняется', { mass: 100, stiffness: 100, damping: 2 }, 'LM091'],
  ];

  for (const [label, params, code] of CASES) {
    it(`${label} → ${code}`, () => {
      expect(() => springAsEasing(params)).toThrow(expect.objectContaining({ code }));
    });
  }
});

/**
 * Пин формы ζ = c/(2m·ω₀) (заметка ревью #267): прежняя запись c/(2√(km))
 * переполняла произведение k·m, и на валидной пружине m=k=c=1e200 (ζ=0.5)
 * давала ζ=0 — кривая ломалась. Возврат той формы обязан краснить этот тест.
 */
describe('ζ не переполняется на масштабных краях', () => {
  it('m=k=c=1e200 даёт ту же кривую, что m=k=c=1', () => {
    const reference = springAsEasing({ mass: 1, stiffness: 1, damping: 1 });
    const extreme = springAsEasing({ mass: 1e200, stiffness: 1e200, damping: 1e200 });
    for (let i = 0; i <= 20; i++) {
      expect(Object.is(extreme(i / 20), reference(i / 20))).toBe(true);
    }
  });
});
