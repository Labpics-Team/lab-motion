/**
 * compositor/segmenter.ts — адаптивная выборка узлов пружина → CSS linear().
 *
 * Ядро отличия M1 (см. research «compass_395597 / компилятор перцептивного
 * времени»): генераторы индустрии (Джейк Арчибальд, MDN, Motion) сэмплируют
 * пружину ФИКСИРОВАННЫМ числом равноудалённых точек (~33–100), пере-сэмплируя
 * пологие кривые и недо-сэмплируя жёсткие. Здесь число узлов ВЫВОДИТСЯ из
 * бюджета ошибки: узлы ставятся там, где кривизна прогресса |p″| высока (старт,
 * пики перелёта) и разрежены в экспоненциальном хвосте.
 *
 * Метод — вертикальный Дуглас–Пекер (RDP) поверх плотной аналитической сетки:
 * для функции-графика p(τ) ошибка кусочно-линейной реконструкции в точке τ —
 * это ВЕРТИКАЛЬНОЕ отклонение |p(τ) − lerp(τ)| (не перпендикулярное: нас
 * интересует ошибка значения в данный момент времени, а не геометрия кривой).
 * RDP жадно оставляет точку максимального отклонения, пока каждый сегмент не
 * уложится в eps. Бюджет ошибки делится ПОПОЛАМ: eps RDP = tolerance/2 (ошибка
 * прореживания на узлах сетки), а плотность базовой сетки выводится из бонда
 * кривизны так, что её СОБСТВЕННАЯ кусочно-линейная ошибка ≤ tolerance/2 —
 * суммарно реконструкция ≤ tolerance на всей непрерывной кривой (не только в
 * узлах сетки). Плотность НЕ из числа полуволн: доминирующая кривизна прогресса
 * — на СТАРТЕ (начальное ускорение ~T²ω₀²), а не в осцилляциях (см. baseGridSize).
 *
 * Длительность плана = settleTimeUpperBound (запечатанный канонический закон
 * оседания spring.ts, ≤ бюджета кадра-капа, валидирован бенчами #64) — не новая
 * параллельная константа. Хвостовой узел форсится в ровно 1 (дисциплина
 * эндпоинтов, как springAsEasing): аналитический p(T) в пределах ~0.5% цели,
 * снап к 1 субпиксельный при типичной амплитуде.
 *
 * Всё — на этапе КОМПИЛЯЦИИ (раз на пружину, кэшируется): аллокации сетки/RDP
 * амортизированы; горячий путь (compositor-воспроизведение) не делает работы
 * вовсе, путь попадания в кэш — без аллокаций (см. cache.ts).
 */

import { makeSpringValueSampler } from '../internal/solver.js';
import { settleTimeUpperBound, type SpringParams } from '../spring.js';

/** Один узел linear(): нормализованный прогресс + доля времени в процентах. */
export interface SpringNode {
  /** Значение прогресса p(τ) ∈ ℝ (может >1/<0 при перелёте underdamped). */
  readonly progress: number;
  /** Доля времени τ·100 ∈ [0, 100] — input-процент стопа CSS linear(). */
  readonly percent: number;
}

// ─── Плотность базовой сетки (из бонда кривизны, не из числа осцилляций) ─────
//
// Ошибка реконструкции = (ошибка RDP на узлах сетки) + (кусочно-линейная ошибка
// САМОЙ базовой сетки МЕЖДУ её узлами). Второе — дискретизация: для C²-функции
// ≤ (h²/8)·max|d²p/dτ²| на шаге h (ед. τ). ДОМИНИРУЮЩАЯ кривизна прогресса — НЕ в
// осцилляциях, а на СТАРТЕ: при v0=0 x″(0)=ω₀², в τ-единицах d²p/dτ²|₀ = T²ω₀².
// (Сетка, размеренная числом полуволн, недо-сэмплирует старт — ровно этот класс
// дефекта поймал флагманский тест границы ошибки: reconstruction 0.0096 при
// tol 0.002.)
//
// Бонд кривизны: |d²p/dτ²| = T²|x″| ≤ T²[ω₀²·|1−x| + 2ζω₀·|x′|]. С запасом
// |1−x| ≤ 2, |x′| ≤ ω₀+|v0| (нормализ.) ⇒ |d²p/dτ²| ≤ 4(Tω₀)²·(1+|v0|). Требуем
// дискретизацию ≤ tol/2 (RDP берёт вторую половину бюджета, eps = tol/2):
//   (h²/8)·4(Tω₀)²(1+|v0|) ≤ tol/2 ⇒ base = 1/h ≥ Tω₀·√((1+|v0|)/tol)
// Множитель CURVATURE_SAFETY покрывает грубость бонда.
const CURVATURE_SAFETY = 1.5;
/** Пол числа интервалов (гладкие кривые). */
const BASE_GRID_FLOOR = 24;
const BASE_GRID_MIN = 32;
/** Потолок (страховка стоимости компиляции; RDP всё равно прорежает выход). */
const BASE_GRID_MAX = 4096;

/**
 * Размер базовой сетки (число ИНТЕРВАЛОВ), выведенный из бонда кривизны так, что
 * дискретизация сетки ≤ tolerance/2 (вторую половину бюджета несёт eps RDP).
 */
export function baseGridSize(
  params: SpringParams,
  settle: number,
  tolerance: number,
  v0 = 0,
): number {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const raw = CURVATURE_SAFETY * settle * omega0 * Math.sqrt((1 + Math.abs(v0)) / tolerance);
  const n = Math.ceil(raw) + BASE_GRID_FLOOR;
  return Math.min(BASE_GRID_MAX, Math.max(BASE_GRID_MIN, n));
}

/**
 * Вертикальный Дуглас–Пекер по полилинии (xs монотонны). Возвращает
 * отсортированные индексы оставленных точек (включая концы). eps — порог
 * вертикального отклонения. Итеративный (явный стек) — без рекурсивного
 * переполнения на больших сетках.
 */
export function douglasPeuckerVertical(
  xs: readonly number[],
  ys: readonly number[],
  eps: number,
): number[] {
  const n = xs.length;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  // Стек интервалов [i, j] (индексы), i<j.
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j <= i + 1) continue; // нет внутренних точек
    const xi = xs[i]!;
    const yi = ys[i]!;
    const dx = xs[j]! - xi;
    const dy = ys[j]! - yi;
    // dx>0 всегда (xs строго возрастают на сетке, стек кладёт только idx>i) ⇒
    // прежний per-итерационный страж `dx===0?yi:` — мёртвая ветка. Снят: минус
    // ветвление на каждой точке скана (RDP — ~15% cold-compile). Арифметика хорды
    // не тронута ⇒ байт-в-байт те же узлы (диф-проверка: 1.6M комбинаций, 0 hits).
    // Наклон хорды slope = dy/dx петле-инвариантен → считаем ОДИН раз, снимая
    // деление С КАЖДОЙ точки скана (замена на умножение). Тождество lineY тех же
    // узлов проверено дифференциально (53k комбинаций параметров/tol/v0 по всем
    // режимам солвера, 0 расхождений kept-индексов) — эмитируемая строка та же.
    const slope = dy / dx;
    let maxDev = -1;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const lineY = yi + slope * (xs[k]! - xi);
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

/**
 * Строит минимальный набор узлов linear() для пружины при заданной толерантности.
 *
 * @param params    — физические параметры пружины (валидированы вызывающим).
 * @param v0        — нормализованная начальная скорость (0 для покоя; ≠0 —
 *                    ретаргет с сохранением скорости). Оседание берётся
 *                    параметр-зависимым (settleTimeUpperBound v0-агностичен) —
 *                    для ПЕРЕНОСИМОЙ скорости (ограниченной прошлой пружиной)
 *                    амплитудный запас бонда покрывает удлинение траектории.
 * @param tolerance — макс. вертикальное отклонение реконструкции (ед. прогресса).
 * @returns массив узлов; percent[0]=0, percent[last]=100, progress[last]=1.
 */
export function buildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): SpringNode[] {
  const settle = settleTimeUpperBound(params);
  // Валидный набор params всегда оседает в бюджет (гарантия validateSpringParams),
  // так что settle конечно; на всякий случай — деградация к малой ненулевой шкале.
  const T = Number.isFinite(settle) && settle > 0 ? settle : 1;

  const intervals = baseGridSize(params, T, tolerance, v0);
  const count = intervals + 1;
  const xs = new Array<number>(count);
  const ys = new Array<number>(count);
  // Инварианты пружины (omega0/zeta/omegaD/A/B) петле-инвариантны на всей сетке
  // (params/v0 фиксированы) → считаем их ОДИН раз фабрикой, а не на каждый узел.
  // Значение бит-в-бит равно solveSpring(...).value (см. makeSpringValueSampler).
  const sampleValue = makeSpringValueSampler(params, v0);
  for (let i = 0; i < count; i++) {
    const tau = i / intervals; // ∈ [0, 1]
    xs[i] = tau;
    // Финитный страж (не-конечное → цель 1, зеркалит motion-value; для валидных
    // params не срабатывает — покрыто finiteness-fuzz; инвариант «в CSS никогда
    // не NaN/∞») заинлайнен в цикл — минус кадр вызова на КАЖДЫЙ узел сетки
    // (доминирующий путь cold-compile). Тот же Number.isFinite(v)?v:1, бит-в-бит.
    const v = sampleValue(tau * T);
    ys[i] = Number.isFinite(v) ? v : 1;
  }

  // eps = tolerance/2: вторая половина бюджета — под дискретизацию базовой сетки
  // (baseGridSize её и гарантирует ≤ tol/2) ⇒ суммарная реконструкция ≤ tolerance.
  const kept = douglasPeuckerVertical(xs, ys, tolerance / 2);
  const nodes: SpringNode[] = [];
  for (let n = 0; n < kept.length; n++) {
    const k = kept[n]!;
    // Хвост — ровно цель (дисциплина эндпоинтов); прочие — сырой прогресс.
    const progress = n === kept.length - 1 ? 1 : ys[k]!;
    nodes.push({ progress, percent: xs[k]! * 100 });
  }
  return nodes;
}
