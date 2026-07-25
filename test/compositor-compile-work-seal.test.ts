/**
 * compositor-compile-work-seal.test.ts — ДЕТЕРМИНИРОВАННЫЙ перф-seal
 * compositor-компиляции: сколько раз зовётся солвер на один план.
 *
 * ЗАЧЕМ ИМЕННО ТАК. Wall-clock машинозависим и флакует per-PR, поэтому пакет
 * пинит РАБОТУ, а не время (та же дисциплина, что в perf-hot-path.test.ts:
 * «число кадров = число вызовов солвера = потраченный CPU»). Но прежний seal
 * покрывал только drive/MotionValue/timeline — то есть ГОРЯЧИЙ путь main-потока,
 * и ничего не говорил о ХОЛОДНОЙ компиляции пружина → CSS linear().
 *
 * Цена пробела уже реализовалась. В #228 предикат компилируемости стал самой
 * попыткой построения сетки, и путь ОТКАЗА начал честно доходить до
 * BASE_GRID_MAX: 1.43 мкс → 625 мкс на вызов, ×440. Зовётся он на КАЖДОМ
 * animate()/retarget, то есть быстрый fling-жест платил бы это на каждом
 * событии. Нашло это состязательное ревью, а не гейт: класс «компиляция стала
 * дороже» не виден ни size-gate, ни функциональным тестам, ни coverage.
 *
 * Здесь три утверждения, и каждое ловит свой класс регрессии:
 *   1. ХОЛОДНАЯ компиляция ограничена сверху — ловит раздувание сетки,
 *      лишний проход по узлам, потерю адаптивности шага;
 *   2. ПОВТОРНАЯ компиляция тех же входов = РОВНО НОЛЬ вызовов солвера —
 *      ловит слом кэша артефактов (класс «всё работает, но втрое медленнее»,
 *      абсолютно невидимый функционально);
 *   3. ОТКАЗ по капу тоже мемоизируется — повторный непосильный запрос стоит
 *      ноль. Это пин на sentinel-мемо over-cap: без него fling-жест с
 *      непосильным бюджетом платил бы 4095 вызовов солвера НА КАЖДОМ событии.
 *
 * Mutation proof: снять мемо артефактов → RED на (2); вернуть отказ без
 * OVER_CAP-часового → RED на (3); поднять плотность сетки вдвое → RED на (1).
 */

import { describe, expect, it, vi } from 'vitest';

/** Счётчик обёрнут вокруг НАСТОЯЩЕГО солвера: поведение не меняется. */
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/internal/solver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/internal/solver.js')>();
  return {
    ...actual,
    solveSpring(...args: Parameters<typeof actual.solveSpring>) {
      calls.n++;
      return actual.solveSpring(...args);
    },
    sampleSpringBasisUnchecked(
      ...args: Parameters<typeof actual.sampleSpringBasisUnchecked>
    ) {
      calls.n++;
      return actual.sampleSpringBasisUnchecked(...args);
    },
  };
});

const { compileSpringPlan } = await import('../src/compositor/core.js');
const { __resetSpringExecutionCache } = await import('../src/compositor/execution.js');
const { BASE_GRID_MAX } = await import('../src/compositor/segmenter.js');

import type { SpringParams } from '../src/spring.js';

/**
 * Потолки — от ФАКТА с запасом на вариативность числа узлов между режимами.
 * Хронология: 2026-07-25 первые факты — дефолтный бюджет 40…64 вызова,
 * строгий (2.5e-4) 87…175. Потолки поставлены на ~25 % выше худшего факта:
 * пружины различаются числом узлов законно, а вот удвоение — уже регрессия.
 */
const COLD_DEFAULT_CAP = 80;
const COLD_STRICT_CAP = 220;

const CORPUS: [name: string, spring: SpringParams][] = [
  ['канон {1,170,26}', { mass: 1, stiffness: 170, damping: 26 }],
  ['мягкая {1,40,12}', { mass: 1, stiffness: 40, damping: 12 }],
  ['жёсткая {1,900,30}', { mass: 1, stiffness: 900, damping: 30 }],
  ['медленная {1,1,1}', { mass: 1, stiffness: 1, damping: 1 }],
  ['передемпфированная {1,100,40}', { mass: 1, stiffness: 100, damping: 40 }],
  ['критическая {1,100,20}', { mass: 1, stiffness: 100, damping: 20 }],
];

/** Работа одной компиляции в вызовах солвера. */
function work(run: () => void): number {
  calls.n = 0;
  try {
    run();
  } catch {
    // Отказ — тоже работа, и она тоже обязана быть ограничена.
  }
  return calls.n;
}

describe('compositor: seal работы холодной компиляции', () => {
  it('холодная компиляция ограничена сверху на всех режимах и бюджетах', () => {
    const over: string[] = [];
    for (const [name, spring] of CORPUS) {
      __resetSpringExecutionCache();
      const cheap = work(() => {
        compileSpringPlan({ spring, property: 'opacity', from: 0, to: 1 });
      });
      if (cheap > COLD_DEFAULT_CAP) over.push(`${name} дефолт: ${cheap} > ${COLD_DEFAULT_CAP}`);

      __resetSpringExecutionCache();
      const strict = work(() => {
        compileSpringPlan({
          spring, property: 'opacity', from: 0, to: 1000, maxValueError: 0.25,
        });
      });
      if (strict > COLD_STRICT_CAP) over.push(`${name} строгий: ${strict} > ${COLD_STRICT_CAP}`);
    }
    expect(over, `компиляция подорожала:\n${over.join('\n')}`).toEqual([]);
  });

  it('повторная компиляция тех же входов не зовёт солвер НИ РАЗУ', () => {
    for (const [name, spring] of CORPUS) {
      __resetSpringExecutionCache();
      const compile = (): void => {
        compileSpringPlan({ spring, property: 'opacity', from: 0, to: 1 });
      };
      expect(work(compile), `${name}: холодная должна что-то считать`).toBeGreaterThan(0);
      // Ровно ноль, а не «мало»: артефакт обязан отдаваться из кэша целиком.
      expect(work(compile), `${name}: кэш артефактов не сработал`).toBe(0);
      expect(work(compile), `${name}: кэш не удержал второй раз`).toBe(0);
    }
  });

  it('отказ по капу стоит ограниченно и МЕМОИЗИРУЕТСЯ', () => {
    // ζ=2, ω₀=10 при effective 6.25e-8: доказанная сетка не влезает в
    // BASE_GRID_MAX, и это законный LM016 — но платить за него дважды нельзя.
    const impossible = (): void => {
      compileSpringPlan({
        spring: { mass: 1, stiffness: 100, damping: 40 },
        property: 'opacity', from: 0, to: 4_000_000, maxValueError: 0.25,
      });
    };
    __resetSpringExecutionCache();
    const first = work(impossible);
    // Отказ доходит до капа сетки — это его честная цена, но НЕ БОЛЬШЕ неё.
    expect(first).toBeGreaterThan(1000);
    expect(first).toBeLessThanOrEqual(BASE_GRID_MAX);
    // Второй такой же запрос (fling-жест шлёт их десятками) — бесплатен.
    expect(work(impossible), 'over-cap отказ не мемоизирован').toBe(0);
    expect(work(impossible), 'мемо отказа не удержало').toBe(0);
  });

  it('строгий бюджет дороже дефолтного, но не катастрофически', () => {
    // Закон «строже бюджет → плотнее сетка» обязан быть монотонным и
    // ПОЛИНОМИАЛЬНЫМ (h ∝ √tol): десятикратное ужесточение бюджета не должно
    // давать больше чем ~×4 работы. Экспоненциальный рост означал бы, что
    // адаптивность шага сломалась и сетка вернулась к worst-case.
    const spring = CORPUS[0]![1];
    __resetSpringExecutionCache();
    const cheap = work(() => {
      compileSpringPlan({ spring, property: 'opacity', from: 0, to: 1 });
    });
    __resetSpringExecutionCache();
    const strict = work(() => {
      compileSpringPlan({
        spring, property: 'opacity', from: 0, to: 1000, maxValueError: 0.25,
      });
    });
    expect(strict).toBeGreaterThan(cheap);
    expect(strict / cheap).toBeLessThan(4);
  });
});
