/**
 * test/compositor-cold-compile-differential.test.ts
 *
 * Дифференциальный ГЕЙТ для перф-рефактора cold-compile (PR #69): доказывает, что
 * три «горячих» замены в компиляторе пружина→linear() дают ТОТ ЖЕ выход, что и
 * прежний путь. Заголовок PR заявляет «байт-идентично» — этот тест делает клейм
 * воспроизводимым фактом CI, а не текстом описания.
 *
 * Классы: В (differential — старый путь против нового), Д (mutation-хуки: любая
 * правка формул sampler/roundShortest/наклона RDP роняет соответствующую группу).
 *
 * Что именно фиксируется (ровно это, без фантомных мегасчётчиков):
 *   1. makeSpringValueSampler(params,v0)(t) === solveSpring(params,t,v0).value —
 *      ТОЧНОЕ равенство (Object.is: ловит и −0/+0, и NaN/NaN), все 3 режима
 *      солвера (under/critical/over) + undamped, сетка t включая t≤0 и большие t,
 *      разные v0. Обе функции — те же формулы в том же порядке ⇒ бит-в-бит.
 *   2. roundShortest(x,d) === String(Number(x.toFixed(d))) — ТОЧНОЕ равенство
 *      строк (прежний путь эмиссии был `${Number(x.toFixed(d))}`), фазз по x
 *      включая −0-производящие/целые/хвостовые-нули/около-100, обе точности d.
 *   3. douglasPeuckerVertical (наклон хойстнут, страж снят) даёт ИДЕНТИЧНЫЙ НАБОР
 *      оставленных индексов, что прежний per-точечный вариант — НА РЕАЛЬНОМ ДОМЕНЕ
 *      КОМПИЛЯТОРА (равномерная сетка xs, пружинные ys, все режимы × сетки × eps).
 *      Это несущий клейм: одинаковые узлы ⇒ одинаковая linear()-строка.
 *      ГРАНИЦА: замена (dy·Δx)/dx → (dy/dx)·Δx НЕ универсально бит-идентична —
 *      промежуточный lineY сдвигается на ULP, и на ПРОИЗВОЛЬНЫХ кривых с
 *      «почти-ничьей» отклонений argmax может уйти на соседний узел. Компилятор
 *      таких входов не подаёт (реальный домен точно совпадает); для произвольных
 *      гладких кривых фиксируем истинный слабый инвариант — новый RDP остаётся
 *      КОРРЕКТНЫМ ≤eps упрощением (доброкачественность, не регрессия).
 *
 * RED-доказательство (для каждой группы своя диверсия роняет ровно её):
 *   - Сломать любую ветку sampler (напр. B со знаком, decay без t) → группа 1 RED.
 *   - Убрать `-0`→`0` guard в roundShortest → группа 2 RED на −0-кейсах.
 *   - Вернуть в new-RDP формулу (dy*Δx)/dx НЕЛЬЗЯ (она и есть old) — но сломать
 *     хойст (slope на неверном интервале) → группа 3 RED.
 */

import { describe, expect, it } from 'vitest';
import { makeSpringValueSampler, solveSpring } from '../src/internal/solver.js';
import { roundShortest } from '../src/compositor/format.js';
import { douglasPeuckerVertical } from '../src/compositor/segmenter.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';

/**
 * Детерминированный LCG (тот же, что в остальном сьюте): seed фиксирован ⇒ сетка
 * фазза воспроизводима на каждом прогоне CI, без флака.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

// ─── Группа 1: makeSpringValueSampler ≡ solveSpring().value (Object.is) ───────

describe('differential: makeSpringValueSampler(t) === solveSpring(t).value (точно)', () => {
  // Явные фикстуры по режимам — гарантируют, что КАЖДАЯ ветвь sampler исполнится
  // (случайный фазз почти никогда не даст zeta===1 точно, а критическую ветвь
  // надо покрыть для mutation). Для m=1, k — точный квадрат: omega0=√k точен,
  // damping=2·omega0 ⇒ zeta = 2·omega0/(2·1·omega0) = 1 бит-в-бит.
  const REGIMES: { name: string; p: SpringParams }[] = [
    { name: 'undamped (zeta=0)', p: { mass: 1, stiffness: 100, damping: 0 } },
    { name: 'underdamped bouncy', p: { mass: 1, stiffness: 180, damping: 8 } },
    { name: 'underdamped near-critical', p: { mass: 1, stiffness: 100, damping: 19 } },
    { name: 'critical (zeta=1) k=100', p: { mass: 1, stiffness: 100, damping: 20 } },
    { name: 'critical (zeta=1) k=400', p: { mass: 1, stiffness: 400, damping: 40 } },
    { name: 'critical (zeta=1) k=25', p: { mass: 1, stiffness: 25, damping: 10 } },
    { name: 'overdamped', p: { mass: 1, stiffness: 100, damping: 40 } },
    { name: 'overdamped strong', p: { mass: 2, stiffness: 90, damping: 120 } },
  ];

  // Сетка t: t≤0 (страж), около-ноль, малые, средние, большие (за оседанием).
  const T_GRID = [
    -1e300, -1, -1e-9, 0, 1e-300, 1e-9, 1e-4, 0.01, 0.1, 0.5, 1, 2, 5, 12, 50, 1e3,
  ];
  const V0_GRID = [0, 2, -2, 0.001, -0.001, 50, -50];

  it('все режимы × сетка t × v0 — бит-в-бит равны', () => {
    for (const { p } of REGIMES) {
      for (const v0 of V0_GRID) {
        const sample = makeSpringValueSampler(p, v0);
        for (const t of T_GRID) {
          const expected = solveSpring(p, t, v0).value;
          const actual = sample(t);
          // Object.is: отличает −0 от +0 и трактует NaN как равный NaN — точнее
          // toBe для этого инварианта (обычный === считал бы 0===−0 истиной).
          expect(Object.is(actual, expected)).toBe(true);
        }
      }
    }
  });

  it('seeded-фазз параметров (валидный диапазон) × v0 × t — 0 расхождений', () => {
    const rnd = makeRng(20260708);
    let checks = 0;
    for (let n = 0; n < 500; n++) {
      const p: SpringParams = {
        mass: 0.1 + rnd() * 5,
        stiffness: 1 + rnd() * 900,
        damping: rnd() * 120,
      };
      const v0 = (rnd() - 0.5) * 40;
      const sample = makeSpringValueSampler(p, v0);
      // Оседание параметр-зависимо — покрываем t от 0 до за-оседания.
      const T = settleTimeUpperBound(p);
      for (let m = 0; m < 12; m++) {
        const t = m === 0 ? 0 : (m / 11) * T * 1.3;
        expect(Object.is(sample(t), solveSpring(p, t, v0).value)).toBe(true);
        checks++;
      }
    }
    // Санити: цикл реально прогонял сравнения (ловит вырожденный no-op).
    expect(checks).toBe(500 * 12);
  });
});

// ─── Группа 2: roundShortest ≡ String(Number(x.toFixed(d))) (строка, точно) ───

describe('differential: roundShortest(x,d) === String(Number(x.toFixed(d)))', () => {
  /** Прежний путь эмиссии: Number(toFixed) затем стрингификация шаблоном. */
  const ref = (x: number, d: number): string => String(Number(x.toFixed(d)));

  const EDGE = [
    0, -0, 1, -1, 10, 100, 1000,
    1.2, 1.20000001, 1.2345, 1.23456, 0.12345, 0.123, 0.1235,
    99.9995, 99.99949, 100.00049,
    -0.00001, -0.0004, -0.00005, -0.000049, // около −0 после округления
    0.00001, 0.00004, 0.00005,
    -1.23456, -99.9995, 1234.56789, -1234.56789,
    0.9999, 1.0001, 0.05, 0.005, 0.0005,
  ];

  it('крайние случаи (−0, целые, хвостовые нули, около-100) — точное равенство строк', () => {
    for (const d of [3, 4]) {
      for (const x of EDGE) {
        expect(roundShortest(x, d)).toBe(ref(x, d));
      }
    }
  });

  it('seeded-фазз по x (домен эмиссии и шире) × d∈{3,4} — 0 расхождений', () => {
    const rnd = makeRng(770708);
    let checks = 0;
    for (let n = 0; n < 4000; n++) {
      // Смесь диапазонов: домен linear() (progress≈[-0.3,1.3], percent[0,100]),
      // около-ноль (кандидаты в −0), и широкий хвост для устойчивости контракта.
      const bucket = n % 5;
      let x: number;
      if (bucket === 0) x = rnd() * 1.3 - 0.3; // progress с оверслутом
      else if (bucket === 1) x = rnd() * 100; // percent
      else if (bucket === 2) x = (rnd() - 0.5) * 2e-3; // около нуля → −0-кейсы
      else if (bucket === 3) x = (rnd() - 0.5) * 2000; // широкий
      else x = (rnd() - 0.5) * 4; // средний со знаком
      for (const d of [3, 4]) {
        expect(roundShortest(x, d)).toBe(ref(x, d));
        checks++;
      }
    }
    expect(checks).toBe(4000 * 2);
  });
});

// ─── Группа 3: douglasPeuckerVertical — kept-индексы new ≡ old ────────────────

/**
 * Прежняя реализация douglasPeuckerVertical (ДО PR #69): per-точечный страж
 * `dx===0?yi:` и деление НА КАЖДОЙ точке скана. Воспроизведена дословно, чтобы
 * сверять НАБОР оставленных индексов с текущей (хойст наклона + снятый страж).
 * Отличие только во внутренней строке lineY — остальной алгоритм идентичен.
 */
function douglasPeuckerVerticalOld(
  xs: readonly number[],
  ys: readonly number[],
  eps: number,
): number[] {
  const n = xs.length;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j <= i + 1) continue;
    const xi = xs[i]!;
    const yi = ys[i]!;
    const dx = xs[j]! - xi;
    const dy = ys[j]! - yi;
    let maxDev = -1;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const lineY = dx === 0 ? yi : yi + (dy * (xs[k]! - xi)) / dx;
      const dev = Math.abs(ys[k]! - lineY);
      if (dev > maxDev) {
        maxDev = dev;
        idx = k;
      }
    }
    if (maxDev > eps && idx > i) {
      keep[idx] = 1;
      stack.push(i, idx, idx, j);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k] === 1) out.push(k);
  return out;
}

describe('differential: douglasPeuckerVertical — kept-индексы идентичны прежним', () => {
  const REGIMES: SpringParams[] = [
    { mass: 1, stiffness: 170, damping: 26 },
    { mass: 1, stiffness: 180, damping: 8 },
    { mass: 1, stiffness: 120, damping: 30 },
    { mass: 1, stiffness: 100, damping: 40 },
    { mass: 1, stiffness: 100, damping: 20 }, // critical
    { mass: 1, stiffness: 100, damping: 0 }, // undamped (сильно осциллирует)
  ];
  const SIZES = [17, 33, 65, 129, 257];
  const EPS = [1e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2];

  it('реальный домен компилятора: равномерная сетка × пружинные ys × режимы × eps', () => {
    for (const p of REGIMES) {
      const T = settleTimeUpperBound(p);
      for (const count of SIZES) {
        const intervals = count - 1;
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < count; i++) {
          const tau = i / intervals;
          xs.push(tau);
          const v = solveSpring(p, tau * T, 0).value;
          ys.push(Number.isFinite(v) ? v : 1);
        }
        for (const eps of EPS) {
          expect(douglasPeuckerVertical(xs, ys, eps)).toEqual(
            douglasPeuckerVerticalOld(xs, ys, eps),
          );
        }
      }
    }
  });

  /**
   * Реконструирует y в узле k линейной интерполяцией между соседними
   * ОСТАВЛЕННЫМИ индексами. Для корректного вертикального RDP отклонение каждого
   * отброшенного узла от такой реконструкции ≤ eps по построению.
   */
  function maxReconDev(xs: readonly number[], ys: readonly number[], kept: number[]): number {
    let dev = 0;
    for (let s = 0; s < kept.length - 1; s++) {
      const a = kept[s]!;
      const b = kept[s + 1]!;
      const xa = xs[a]!;
      const dxab = xs[b]! - xa;
      const dyab = ys[b]! - ys[a]!;
      for (let k = a + 1; k < b; k++) {
        const recon = dxab === 0 ? ys[a]! : ys[a]! + (dyab * (xs[k]! - xa)) / dxab;
        dev = Math.max(dev, Math.abs(ys[k]! - recon));
      }
    }
    return dev;
  }

  // ЧЕСТНАЯ ГРАНИЦА КЛЕЙМА: замена (dy·Δx)/dx → (dy/dx)·Δx НЕ универсально
  // бит-идентична — на произвольных кривных с «почти-ничьей» в отклонениях
  // суб-ULP сдвиг перекидывает argmax на СОСЕДНИЙ узел (наблюдалось: индексы
  // сдвигаются на ±1). На реальном домене компилятора (пружинные ys, тест выше)
  // этого не происходит — там new≡old бит-в-бит. Для произвольных гладких кривых
  // фиксируем более слабый, но ИСТИННЫЙ инвариант: новый RDP остаётся КОРРЕКТНЫМ
  // упрощением — каждый отброшенный узел в пределах eps от реконструкции. Это
  // доказывает, что редкие расхождения с old доброкачественны (эквивалентное
  // качество), а не регрессия. Проверять здесь мнимую бит-идентичность = ложный
  // клейм сильнее, чем заявляет PR («идентичен ВЫХОД компилятора», не helper на
  // любом входе).
  it('гладкие синтетические кривые: новый RDP — валидное ≤eps упрощение', () => {
    const rnd = makeRng(430708);
    const curves: ((t: number) => number)[] = [
      (t) => t * t,
      (t) => t * t * t - 0.5 * t,
      (t) => Math.sin(t * Math.PI * 3) * Math.exp(-t * 2),
      (t) => 1 - Math.exp(-t * 5),
      (t) => Math.cos(t * Math.PI * 5) * (1 - t),
    ];
    for (let n = 0; n < 300; n++) {
      const f = curves[n % curves.length]!;
      const count = 9 + (n % 120); // 9..128 точек
      const intervals = count - 1;
      const amp = 0.5 + rnd() * 4;
      const phase = rnd() * 6.28;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < count; i++) {
        const tau = i / intervals;
        xs.push(tau);
        ys.push(amp * f(tau + phase * 0.01));
      }
      const eps = [1e-4, 5e-4, 1e-3, 5e-3, 2e-2][n % 5]!;
      const kept = douglasPeuckerVertical(xs, ys, eps);
      // Новый RDP корректен: реконструкция по оставленным узлам ≤ eps (+float-люфт).
      expect(maxReconDev(xs, ys, kept)).toBeLessThanOrEqual(eps + 1e-9);
      // И упрощение реально (концы всегда есть, порядок строгий, в границах).
      expect(kept[0]).toBe(0);
      expect(kept[kept.length - 1]).toBe(count - 1);
    }
  });

  it('вырожденные размеры (n≤2) обрабатываются как прежде', () => {
    expect(douglasPeuckerVertical([], [], 1e-3)).toEqual(douglasPeuckerVerticalOld([], [], 1e-3));
    expect(douglasPeuckerVertical([0], [0.5], 1e-3)).toEqual(
      douglasPeuckerVerticalOld([0], [0.5], 1e-3),
    );
    expect(douglasPeuckerVertical([0, 1], [0, 1], 1e-3)).toEqual(
      douglasPeuckerVerticalOld([0, 1], [0, 1], 1e-3),
    );
  });
});
