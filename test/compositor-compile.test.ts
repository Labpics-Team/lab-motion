/**
 * test/compositor-compile.test.ts — компилятор пружина → linear() + сегментер + read.
 * Классы: А (известные числа), В (доказуемая граница ошибки / differential / fuzz),
 * Д (mutation-хуки в адаптивной выборке и денормализации).
 *
 * ── RED PROOF (авторские мутации, каждая роняет конкретный блок) ──────────────
 * - Заменить адаптивный RDP на фикс-число узлов → «адаптивность: bouncy > stiff» RED
 *   и «граница ошибки ≤ tolerance» RED (грубая сетка превысит бюджет).
 * - Убрать force хвоста в 1 (segmenter) → «последний узел = 1» RED.
 * - Сломать денормализацию read (from + p·range) → differential-против-solveSpring RED.
 * - Убрать финитный страж → finiteness-fuzz RED.
 * - Ослабить eps RDP до 10× → «interior ≤ tolerance» RED.
 *
 * Заземление: research «compass_395597» (адаптив по кривизне против фикс-точек;
 * субпиксельный перцептивный бюджет), закрытая форма solveSpring (ядро #64).
 */

import { describe, expect, it } from 'vitest';
import {
  compileSpringLinear,
  compileSpringPlan,
  readCompositorSpring,
  DEFAULT_TOLERANCE,
} from '../src/compositor/index.js';
import {
  buildSpringNodes,
  buildSpringNodesWithHorizon,
  baseGridSize,
  douglasPeuckerVertical,
  springCompileHorizon,
} from '../src/compositor/segmenter.js';
import { spring, settleTimeUpperBound, type SpringParams } from '../src/spring.js';
import { solveSpring } from '../src/internal/solver.js';
import { MotionParamError } from '../src/index.js';

// ─── Пружины-образцы (разные режимы) ─────────────────────────────────────────
const STIFF: SpringParams = { mass: 1, stiffness: 170, damping: 26 }; // ~критич (Framer default)
const BOUNCY: SpringParams = { mass: 1, stiffness: 180, damping: 8 }; // сильно underdamped
const GENTLE: SpringParams = { mass: 1, stiffness: 120, damping: 30 }; // мягкий
const OVER: SpringParams = { mass: 1, stiffness: 100, damping: 40 }; // передемпфированный
// Медленные режимы (ω₀ ≤ 1): у них остаток закона оседания равен полному ε и
// снап в 1 — самая крупная составляющая ошибки. Все четыре режима выше имеют
// ω₀ ≥ 10, где остаток вдесятеро меньше, поэтому корпус дефекта не видел.
const SLOW_REGIMES: SpringParams[] = [
  { mass: 1, stiffness: 1, damping: 1 },    // ω₀ = 1, ζ = 0.5
  { mass: 1, stiffness: 1, damping: 1.98 }, // ω₀ = 1, ζ = 0.99
  { mass: 1, stiffness: 1, damping: 4 },    // ω₀ = 1, ζ = 2
];

/** Разбирает linear()-строку в узлы {progress, percent}. */
function parseLinear(s: string): { progress: number; percent: number }[] {
  expect(s.startsWith('linear(')).toBe(true);
  expect(s.endsWith(')')).toBe(true);
  return s
    .slice(7, -1)
    .split(', ')
    .map((tok) => {
      const [p, pct] = tok.split(' ');
      return { progress: Number(p), percent: Number(pct!.replace('%', '')) };
    });
}

// ─── compileSpringLinear: форма и детерминизм ────────────────────────────────

describe('compositor: compileSpringLinear — форма', () => {
  it('валидная linear()-строка: старт 0 0%, финиш 1 100%', () => {
    const s = compileSpringLinear(STIFF);
    const nodes = parseLinear(s);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(nodes[0]).toEqual({ progress: 0, percent: 0 });
    expect(nodes[nodes.length - 1]).toEqual({ progress: 1, percent: 100 });
  });

  it('проценты неубывающие в [0,100], прогресс конечен', () => {
    for (const params of [STIFF, BOUNCY, GENTLE, OVER]) {
      const nodes = parseLinear(compileSpringLinear(params));
      for (let i = 0; i < nodes.length; i++) {
        expect(Number.isFinite(nodes[i]!.progress)).toBe(true);
        expect(nodes[i]!.percent).toBeGreaterThanOrEqual(0);
        expect(nodes[i]!.percent).toBeLessThanOrEqual(100);
        if (i > 0) expect(nodes[i]!.percent).toBeGreaterThanOrEqual(nodes[i - 1]!.percent);
      }
    }
  });

  it('детерминизм: две компиляции бит-в-бит равны', () => {
    expect(compileSpringLinear(BOUNCY)).toBe(compileSpringLinear(BOUNCY));
    expect(compileSpringLinear(BOUNCY, { tolerance: 0.001 })).toBe(
      compileSpringLinear(BOUNCY, { tolerance: 0.001 }),
    );
  });
});

// ─── АДАПТИВНОСТЬ: число узлов выводится, не фиксировано ──────────────────────

describe('compositor: адаптивная выборка (ядро отличия M1)', () => {
  it('bouncy (много осцилляций) даёт БОЛЬШЕ узлов, чем critical при равной толерантности', () => {
    const bouncyNodes = parseLinear(compileSpringLinear(BOUNCY)).length;
    const stiffNodes = parseLinear(compileSpringLinear(STIFF)).length;
    // Если бы число узлов было фиксировано (как у Motion/Джейка Арчибальда),
    // они были бы равны — этот assert ловит регрессию адаптивности.
    expect(bouncyNodes).toBeGreaterThan(stiffNodes);
  });

  it('передемпфированный (гладкий монотон) — меньше bouncy и заметно ниже фикс-100', () => {
    // Узлы концентрируются у СТАРТА (x″(0)=ω₀² высока даже без осцилляций), не
    // равномерно — потому меньше, чем у bouncy, но не «пара точек».
    const overNodes = parseLinear(compileSpringLinear(OVER)).length;
    const bouncyNodes = parseLinear(compileSpringLinear(BOUNCY)).length;
    expect(overNodes).toBeLessThan(bouncyNodes);
    expect(overNodes).toBeLessThan(50);
  });

  it('гладкая пружина компилируется НАМНОГО дешевле фикс-100 генераторов', () => {
    // Research «compass_395597»: индустрия печёт ~40–100 точек. Мягкая пружина у
    // нас — двузначное число максимум (пере-сэмплинг фикс-генераторов реклеймится).
    const gentleNodes = parseLinear(compileSpringLinear(GENTLE)).length;
    expect(gentleNodes).toBeLessThan(50);
  });

  it('меньше tolerance → не меньше узлов (монотонность бюджета)', () => {
    const coarse = parseLinear(compileSpringLinear(BOUNCY, { tolerance: 0.02 })).length;
    const fine = parseLinear(compileSpringLinear(BOUNCY, { tolerance: 0.0005 })).length;
    expect(fine).toBeGreaterThanOrEqual(coarse);
  });
});

// ─── ФЛАГМАН: доказуемая граница ошибки реконструкции ─────────────────────────

describe('compositor: граница ошибки кусочно-линейной реконструкции ≤ tolerance', () => {
  /** Реконструирует значение прогресса из узлов в момент τ∈[0,1]. */
  function reconstruct(nodes: { progress: number; percent: number }[], tau: number): number {
    const x = tau * 100;
    for (let i = 1; i < nodes.length; i++) {
      if (x <= nodes[i]!.percent) {
        const a = nodes[i - 1]!;
        const b = nodes[i]!;
        const dx = b.percent - a.percent;
        return dx === 0 ? a.progress : a.progress + ((b.progress - a.progress) * (x - a.percent)) / dx;
      }
    }
    return nodes[nodes.length - 1]!.progress;
  }

  it('УЗЛЫ сегментера: макс. отклонение реконструкции от истинной кривой ≤ tolerance (ВЕСЬ план)', () => {
    for (const params of [STIFF, BOUNCY, GENTLE, OVER, ...SLOW_REGIMES]) {
      for (const tol of [0.002, DEFAULT_TOLERANCE, 0.01]) {
        // Горизонт — ВОЗВРАЩАЕМЫЙ строителем: закон продлевает его до
        // доказанного остатка ≤ tolerance/2, и percent-шкала узлов живёт
        // именно на нём. Реплика settle-закона здесь разъедется.
        const [nodes, T] = buildSpringNodesWithHorizon(params, 0, tol);
        // ВЕСЬ план, включая хвост. Прежняя версия скана обрывалась на
        // предпоследнем узле «снап эндпоинта исключаем из ТОЧНОЙ границы» —
        // и ровно в вырезанном куске жил дефект 2026-07-25: снап в 1 давал до
        // 2.00× бюджета на медленных пружинах. Исключать из проверки часть
        // плана, которую пользователь видит, было нельзя.
        let maxDev = 0;
        for (let k = 0; k <= 2000; k++) {
          const tau = k / 2000;
          const truth = solveSpring(params, tau * T, 0).value;
          maxDev = Math.max(maxDev, Math.abs(reconstruct(nodes, tau) - truth));
        }
        expect(maxDev, `${params.stiffness}/${params.damping} tol=${tol}`)
          .toBeLessThanOrEqual(tol);
      }
    }
  });

  it('эндпоинт-снап хвоста укладывается в СВОЮ долю бюджета (tolerance/2)', () => {
    // Было: «истинный p(T) в пределах ~0.5% цели» с порогом 0.01 — константа,
    // не связанная с запрошенным бюджетом ВООБЩЕ. При дефолтном tolerance
    // 0.0025 такой порог разрешал вчетверо большую ошибку, чем обещано, и
    // именно он «подтверждал» корректность горизонта, пока тот её не давал.
    // Стало: снап меряется на ПРОИЗВОДСТВЕННОМ горизонте против доли бюджета,
    // которую закон ему выделяет.
    for (const params of [STIFF, BOUNCY, GENTLE, OVER, ...SLOW_REGIMES]) {
      for (const v0 of [0, 3, -3]) {
        for (const tol of [0.0005, DEFAULT_TOLERANCE, 0.01]) {
          const T = springCompileHorizon(params, v0, tol);
          const trueFinal = solveSpring(params, T, v0).value;
          expect(Math.abs(1 - trueFinal), `${params.stiffness}/${params.damping} v0=${v0} tol=${tol}`)
            // Граница строгая: у пружин, где deficit ровно ноль (2ε/tolerance
            // = max(1, ω₀)), остаток попадает В ТОЧКУ tolerance/2, и разница в
            // последнем ULP — не нарушение закона.
            .toBeLessThanOrEqual(tol / 2 * (1 + 1e-9));
        }
      }
    }
  });

  it('строка компилятора (округлённая) реконструирует истинную кривую в пределах бюджета+округление', () => {
    const tol = 0.003;
    const nodes = parseLinear(compileSpringLinear(BOUNCY, { tolerance: tol }));
    const T = springCompileHorizon(BOUNCY, 0, tol);
    let maxDev = 0;
    for (let k = 0; k <= 2000; k++) {
      const tau = k / 2000;
      const truth = solveSpring(BOUNCY, tau * T, 0).value;
      maxDev = Math.max(maxDev, Math.abs(reconstruct(nodes, tau) - truth));
    }
    // Замкнутая арифметика бюджета: сетка + RDP + сериализация + снап ≤ tolerance.
    // Прежний запас `tol + 0.012` был вчетверо шире самого бюджета — под него
    // помещалось любое нарушение обещания.
    expect(maxDev).toBeLessThanOrEqual(tol);
  });
});

// ─── Сегментер: юнит базовой сетки и RDP ─────────────────────────────────────

describe('compositor: сегментер — базовая сетка и RDP', () => {
  it('baseGridSize растёт при более тугой tolerance (плотность из бонда кривизны)', () => {
    const coarse = baseGridSize(BOUNCY, settleTimeUpperBound(BOUNCY), 0.01);
    const fine = baseGridSize(BOUNCY, settleTimeUpperBound(BOUNCY), 0.0005);
    expect(fine).toBeGreaterThan(coarse); // ∝ 1/√tol
    expect(coarse).toBeGreaterThanOrEqual(32); // пол сетки
    expect(fine).toBeLessThanOrEqual(4096); // потолок
  });

  it('douglasPeuckerVertical: прямая линия сжимается до двух концов', () => {
    const xs = [0, 0.25, 0.5, 0.75, 1];
    const ys = [0, 0.25, 0.5, 0.75, 1]; // идеально линейно
    expect(douglasPeuckerVertical(xs, ys, 1e-9)).toEqual([0, 4]);
  });

  it('douglasPeuckerVertical: пик сохраняется, если превышает eps', () => {
    const xs = [0, 0.5, 1];
    const ys = [0, 1, 0]; // треугольник — середина отклоняется на 0.5 от хорды y=0
    // Отклонение середины от хорды y=0 равно ровно 1.0 → при eps<1 сохраняется.
    expect(douglasPeuckerVertical(xs, ys, 0.1)).toEqual([0, 1, 2]);
    expect(douglasPeuckerVertical(xs, ys, 0.9)).toEqual([0, 1, 2]);
    // При eps>1 пик (dev=1.0) отбрасывается.
    expect(douglasPeuckerVertical(xs, ys, 1.5)).toEqual([0, 2]);
  });

  it('douglasPeuckerVertical: защищённый tangent-anchor не удаляется RDP', () => {
    const xs = [0, 0.125, 0.25, 0.5, 1];
    const ys = [0, 0.125, 0.25, 0.5, 1];
    expect(douglasPeuckerVertical(xs, ys, 1, 1)).toEqual([0, 1, 4]);
  });

  it('buildSpringNodes: первый прогресс 0, последний ровно 1', () => {
    const nodes = buildSpringNodes(BOUNCY, 0, 0.002);
    expect(nodes[0]!.progress).toBe(0);
    expect(nodes[0]!.percent).toBe(0);
    expect(nodes[nodes.length - 1]!.progress).toBe(1);
    expect(nodes[nodes.length - 1]!.percent).toBe(100);
  });
});

// ─── readCompositorSpring: O(1) чтение (механизм ретаргета) ───────────────────

describe('compositor: readCompositorSpring — closed-form (value, velocity)', () => {
  it('t=0: value=from, velocity=v0·range', () => {
    const r = readCompositorSpring(STIFF, { from: 10, to: 110, v0: 0, t: 0 });
    expect(r.value).toBe(10);
    expect(r.velocity).toBe(0);
    const rv = readCompositorSpring(STIFF, { from: 0, to: 100, v0: 2, t: 0 });
    expect(rv.velocity).toBeCloseTo(2 * 100, 9); // v0·range
  });

  it('differential: денормализация ≡ solveSpring·range бит-в-бит (случайные t)', () => {
    const from = 20;
    const to = 220;
    const range = to - from;
    for (const t of [0.05, 0.13, 0.3, 0.7, 1.2]) {
      const raw = solveSpring(STIFF, t, 0);
      const r = readCompositorSpring(STIFF, { from, to, v0: 0, t });
      expect(r.value).toBe(from + raw.value * range);
      expect(r.velocity).toBe(raw.velocity * range);
    }
  });

  it('большой t: оседает в цель, скорость → 0', () => {
    const r = readCompositorSpring(STIFF, { from: 0, to: 100, v0: 0, t: 50 });
    expect(r.value).toBeCloseTo(100, 3);
    expect(Math.abs(r.velocity)).toBeLessThan(1e-3);
  });

  it('НЕПРЕРЫВНОСТЬ C¹ ретаргета: reseed сохраняет позицию И скорость', () => {
    // Прогон 1: 0→100, покой. В момент t*=0.1 читаем (val, vel).
    const t1 = 0.1;
    const r1 = readCompositorSpring(STIFF, { from: 0, to: 100, v0: 0, t: t1 });
    // Пере-засев на новую цель 250 со скоростью r1.velocity.
    const newFrom = r1.value;
    const newTo = 250;
    const range2 = newTo - newFrom;
    const v0n = r1.velocity / range2;
    // Прогон 2 в t=0: позиция должна СОВПАСТЬ (C⁰), скорость — СОВПАСТЬ (C¹).
    const r2 = readCompositorSpring(STIFF, { from: newFrom, to: newTo, v0: v0n, t: 0 });
    expect(r2.value).toBe(newFrom); // C⁰
    expect(r2.velocity).toBeCloseTo(r1.velocity, 6); // C¹
  });

  it('финитность: враждебные конечные входы никогда не дают NaN/∞', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 500; n++) {
      const p: SpringParams = {
        mass: 0.1 + rnd() * 5,
        stiffness: 1 + rnd() * 900,
        damping: rnd() * 120,
      };
      // Пропускаем не представимые у ЭТОГО исполнителя: с #218 чистый spring()
      // принимает всю физику, бюджет — граница compositor (validateSpringParams).
      try {
        validateSpringParams(p);
      } catch {
        continue;
      }
      const r = readCompositorSpring(p, {
        from: (rnd() - 0.5) * 1e5,
        to: (rnd() - 0.5) * 1e5,
        v0: (rnd() - 0.5) * 20,
        t: rnd() * 40,
      });
      expect(Number.isFinite(r.value)).toBe(true);
      expect(Number.isFinite(r.velocity)).toBe(true);
    }
  });
});

// ─── compileSpringPlan: полный план ──────────────────────────────────────────

describe('compositor: compileSpringPlan', () => {
  it('два кейфрейма [from,to], easing=linear(), duration=settle·1000, defaults', () => {
    const plan = compileSpringPlan({ spring: STIFF, property: 'opacity', from: 0, to: 1 });
    expect(plan.keyframes).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 1, opacity: 1 },
    ]);
    expect(plan.easing.startsWith('linear(')).toBe(true);
    expect(plan.duration).toBeCloseTo(settleTimeUpperBound(STIFF) * 1000, 6);
    expect(plan.iterations).toBe(1);
    expect(plan.fill).toBe('both');
    expect(plan.composite).toBe('replace');
    expect(plan.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('format форматирует значения (единицы)', () => {
    const plan = compileSpringPlan({
      spring: STIFF,
      property: 'transform',
      from: 0,
      to: 240,
      format: (v) => `translateX(${v}px)`,
    });
    expect(plan.keyframes[0]!['transform']).toBe('translateX(0px)');
    expect(plan.keyframes[1]!['transform']).toBe('translateX(240px)');
  });

  it('fill/composite переопределяемы', () => {
    const plan = compileSpringPlan({
      spring: STIFF,
      property: 'opacity',
      from: 0,
      to: 1,
      fill: 'forwards',
      composite: 'add',
    });
    expect(plan.fill).toBe('forwards');
    expect(plan.composite).toBe('add');
  });

  it("property, конфликтующее с полями кейфрейма ('offset'/'easing'/'composite') → MotionParamError", () => {
    for (const property of ['offset', 'easing', 'composite']) {
      expect(() => compileSpringPlan({ spring: STIFF, property, from: 0, to: 1 })).toThrow(
        MotionParamError,
      );
    }
  });
});

// ─── Валидация входов ────────────────────────────────────────────────────────

describe('compositor: валидация → MotionParamError рано', () => {
  it('невалидные параметры пружины', () => {
    expect(() => compileSpringLinear({ mass: -1, stiffness: 100, damping: 10 })).toThrow(
      MotionParamError,
    );
    expect(() => compileSpringLinear({ mass: 1, stiffness: 0, damping: 10 })).toThrow(
      MotionParamError,
    );
  });

  it('невалидная tolerance (0, ≥1, NaN, отрицательная)', () => {
    for (const tolerance of [0, 1, 1.5, -0.1, NaN, Infinity]) {
      expect(() => compileSpringLinear(STIFF, { tolerance })).toThrow(MotionParamError);
    }
  });

  it('невалидная v0 (NaN/∞)', () => {
    expect(() => compileSpringLinear(STIFF, { v0: NaN })).toThrow(MotionParamError);
    expect(() => compileSpringLinear(STIFF, { v0: Infinity })).toThrow(MotionParamError);
  });

  it('невалидные from/to/t в readCompositorSpring / compileSpringPlan', () => {
    expect(() => readCompositorSpring(STIFF, { from: NaN, to: 1, t: 0 })).toThrow(MotionParamError);
    expect(() => readCompositorSpring(STIFF, { from: 0, to: 1, t: NaN })).toThrow(MotionParamError);
    expect(() => compileSpringPlan({ spring: STIFF, property: 'x', from: 0, to: Infinity })).toThrow(
      MotionParamError,
    );
    expect(() => compileSpringPlan({ spring: STIFF, property: '', from: 0, to: 1 })).toThrow(
      MotionParamError,
    );
  });

  it('DEFAULT_TOLERANCE в разумных пределах (субпиксель при типичной амплитуде)', () => {
    expect(DEFAULT_TOLERANCE).toBeGreaterThan(0);
    expect(DEFAULT_TOLERANCE).toBeLessThan(0.01);
  });
});
