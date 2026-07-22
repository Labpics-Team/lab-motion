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

import { MotionParamError } from '../errors.js';
import { CONVERGENCE_THRESHOLD } from '../internal/constants.js';
import { makeSpringValueSampler } from '../internal/solver.js';
import {
  settleTimeUpperBound,
  type SpringParams,
} from '../spring.js';

/**
 * Дефолтный бюджет реконструкции (ед. прогресса) и одновременно колено
 * горизонт-закона ниже. Определён здесь (а не в curve.ts) — горизонт-закон
 * не может импортировать curve без цикла; curve реэкспортирует.
 */
export const DEFAULT_TOLERANCE: number = 1 / 400;

/**
 * Горизонт компиляции (#223). Канонический settle оставляет терминальному
 * снапу в 1 остаток порядка settle-допуска пакета: для tolerance ≥ дефолта он
 * покрыт перцептивным бюджетом (снап субпиксельный при типичной амплитуде), и
 * горизонт БАЙТ-В-БАЙТ равен settleTimeUpperBound — существующие артефакты не
 * меняются. Бюджет СТРОЖЕ дефолтного (в т.ч. выведенный из absolute
 * maxValueError) — запрос доказанной точности: горизонт продлевается по
 * огибающей до остатка ≤ tolerance/8, и терминальный снап входит в общий
 * бюджет реконструкции. Чистая функция (params, v0, tolerance) — кэш-ключ
 * artifact-ов остаётся корректным без флагов.
 */
export function springCompileHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
): number {
  const settle = settleTimeUpperBound(params, v0);
  if (tolerance >= DEFAULT_TOLERANCE) return settle;
  const omega2 = params.stiffness / params.mass;
  const alpha = params.damping / (2 * params.mass);
  const delta = omega2 - alpha * alpha;
  // Огибающая ~e^(−rate·t); медленный полюс — та же устойчивая форма без
  // катастрофического вычитания, что в settle-законе (#226).
  const rate = delta >= 0 ? alpha : omega2 / (alpha + Math.sqrt(-delta));
  if (!(rate > 0)) return settle; // ζ=0 не имеет конечного горизонта (отвергнет бюджет-гейт)
  // Канонический закон гарантирует остаток ≤ CONVERGENCE_THRESHOLD; добираем
  // ln-дефицит до tolerance/8 (снап ≤ 1/8 бюджета; сетка+RDP+эмит — остальное).
  return settle + Math.log(CONVERGENCE_THRESHOLD / (tolerance / 8)) / rate;
}

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
// Строгий бонд кривизны следует из энергии затухающего осциллятора:
// E=(x′²+ω₀²(x−1)²)/2, E′=−2ζω₀x′²≤0. Поэтому при
// H=hypot(v0,ω₀): |x′|≤H, |x−1|≤H/ω₀, а из ODE
// |x″|≤(ω₀+c/m)H. В нормализованном времени τ=t/T:
// M=max|p″(τ)|≤T²(ω₀+c/m)H. Берём N≥√(M/(2tol)). Тогда обычный
// grid-интервал и half-step tangent ошибаются ≤tol/4, соседний модифицированный
// интервал — ≤5tol/16. Вместе с RDP eps=tol/2 raw-план занимает ≤13tol/16;
// CSS-сериализация получает tol/8, а 1/16 остаётся численным запасом.
/** Пол числа интервалов (гладкие кривые). */
const BASE_GRID_FLOOR = 24;
const BASE_GRID_MIN = 32;
/** Физический потолок компиляции: выше живой солвер дешевле и честнее. */
export const BASE_GRID_MAX = 4096;

function requiredGridSize(
  params: SpringParams,
  settle: number,
  tolerance: number,
  v0: number,
): number {
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const curvature = settle * settle
    * (omega0 + params.damping / params.mass)
    * Math.hypot(v0, omega0);
  const raw = Math.sqrt(curvature / (2 * tolerance));
  return Math.max(BASE_GRID_MIN, Math.ceil(raw) + BASE_GRID_FLOOR);
}

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
  const required = requiredGridSize(params, settle, tolerance, v0);
  if (!Number.isSafeInteger(required) || required > BASE_GRID_MAX) {
    throw new MotionParamError('LM016');
  }
  return required;
}

/**
 * Можно ли доказанно скомпилировать скорость в ограниченную compositor-сетку.
 * Чистый O(1)-предикат нужен фасаду ДО supersede: небезопасный подхват сразу
 * остаётся на общем живом frame-loop и не обрывает предыдущего владельца рано.
 */
export function fitsSpringCurveBudget(
  params: SpringParams,
  v0: number,
  tolerance: number,
): boolean {
  const settle = springCompileHorizon(params, v0, tolerance);
  const required = requiredGridSize(params, settle, tolerance, v0);
  return Number.isSafeInteger(required) && required <= BASE_GRID_MAX;
}

/** Fail-fast версия того же preflight с каноническим MotionParamError. */
export function assertSpringCurveBudget(
  params: SpringParams,
  v0: number,
  tolerance: number,
): void {
  // Тот же предикат и тот же LM016; baseGridSize остаётся тестовым seam-ом
  // и не тянется в production-граф ради одного броска.
  if (!fitsSpringCurveBudget(params, v0, tolerance)) {
    throw new MotionParamError('LM016');
  }
}

/**
 * Вертикальный Дуглас–Пекер по полилинии. Возвращает отсортированные индексы
 * оставленных точек (включая концы). eps — порог вертикального отклонения.
 * Итеративный (явный стек) — без рекурсивного переполнения на больших сетках.
 *
 * ПРЕДУСЛОВИЕ: xs СТРОГО ВОЗРАСТАЮТ (dx = xs[j]−xs[i] > 0 для всех пар стека).
 * Единственный вызывающий — buildSpringNodes — подаёт возрастающую сетку с
 * защищённой half-step точкой и далее tau=i/N, так что предусловие держится по
 * построению. Прежний per-точечный страж
 * `dx===0?yi:` снят как мёртвая ветка (см. ниже). При нарушении (невозрастающие
 * xs, dx≤0) наклон хорды даст NaN/∞ и результат не определён — контракт узкий
 * намеренно, страж не восстанавливается ради несуществующего вызова.
 * protectedIndex — внутренний индекс обязательного узла; RDP упрощает две
 * половины независимо и потому не может провести хорду сквозь эту точку.
 * @internal — экспорт для тестов, не часть публичного API ./compositor.
 */
export function douglasPeuckerVertical(
  xs: readonly number[],
  ys: readonly number[],
  eps: number,
  protectedIndex = -1,
): number[] {
  const n = xs.length;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  // Стек интервалов [i, j] (индексы), i<j. Защищённый interior-узел делит
  // задачу до первого скана: последующая хорда физически не может его удалить.
  const hasProtected = protectedIndex > 0 && protectedIndex < n - 1;
  if (hasProtected) keep[protectedIndex] = 1;
  const stack: number[] = hasProtected
    ? [0, protectedIndex, protectedIndex, n - 1]
    : [0, n - 1];
  while (stack.length > 0) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j <= i + 1) continue; // нет внутренних точек
    const xi = xs[i]!;
    const yi = ys[i]!;
    const dx = xs[j]! - xi;
    const dy = ys[j]! - yi;
    // dx>0 гарантирован предусловием (xs строго возрастают) ⇒ прежний per-точечный
    // страж `dx===0?yi:` — мёртвая ветка. Снят: минус ветвление на КАЖДОЙ точке
    // скана (RDP — ~15% cold-compile). Наклон хорды slope=dy/dx петле-инвариантен →
    // считаем ОДИН раз, снимая деление с каждой точки (деление → умножение).
    // NB: lineY = yi+slope·Δx НЕ бит-идентичен прежнему yi+(dy·Δx)/dx (порядок
    // деления/умножения меняет последний ULP), но НАБОР оставленных индексов —
    // идентичен: сравнение argmax/порога устойчиво к суб-ULP сдвигу отклонения.
    // Зафиксировано дифф-тестом (kept-индексы new≡old на всех режимах × сетках):
    // test/compositor-cold-compile-differential.test.ts.
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
    // maxDev > eps ⇒ скан выполнил ≥1 итерацию (иначе continue выше) и idx ≥ i+1;
    // прежний страж idx > i был мёртвым.
    if (maxDev > eps) {
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
 *                    ретаргет с сохранением скорости). Горизонт и сетка
 *                    учитывают v0; если доказанный бюджет превышает физический
 *                    кап, вызывающий обязан выбрать живой путь.
 * @param tolerance — макс. вертикальное отклонение реконструкции (ед. прогресса).
 * @returns массив узлов; percent[0]=0, percent[last]=100, progress[last]=1.
 */
export function buildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): SpringNode[] {
  return buildSpringNodesWithHorizon(params, v0, tolerance)[0];
}

/** Nodes и канонический horizon вычисляются одной границей. */
export function buildSpringNodesWithHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] {
  const built = tryBuildSpringNodes(params, v0, tolerance);
  // Over-cap: тот же LM016, что бросала прямая baseGridSize-граница; undefined
  // возможен только на предикате fitsSpringCurveBudget — прямой бросок
  // идентичен прежнему assertSpringCurveBudget без пересчёта горизонта/сетки.
  if (built === undefined) throw new MotionParamError('LM016');
  return built;
}

/**
 * Production compile-as-preflight: безопасная кривая сразу строится и готова к
 * кэшированию; over-cap возвращает undefined до сетки/RDP и до смены owner.
 */
export function tryBuildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] | undefined {
  const settle = springCompileHorizon(params, v0, tolerance);
  const intervals = requiredGridSize(params, settle, tolerance, v0);
  if (!Number.isSafeInteger(intervals) || intervals > BASE_GRID_MAX) return;
  return [
    buildSpringNodesAtHorizon(params, v0, tolerance, settle, intervals),
    settle,
  ];
}

/** Specialized v0=0 nodes + тот же horizon для native artifact. */
export function buildRestingSpringNodesWithHorizon(
  params: SpringParams,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] {
  // v0=0 проходит тот же #223-горизонт (settleTimeUpperBound(p,0) ===
  // settleTimeAtRestUpperBound(p)); прежний DCE-мотив отдельного тела снят
  // горизонт-законом, который в любом случае разделяет общий settle-модуль.
  return buildSpringNodesWithHorizon(params, 0, tolerance);
}

function buildSpringNodesAtHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
  settle: number,
  intervals: number,
): SpringNode[] {
  // Валидный набор params всегда оседает в бюджет (гарантия validateSpringParams),
  // так что settle конечно; на всякий случай — деградация к малой ненулевой шкале.
  const T = Number.isFinite(settle) && settle > 0 ? settle : 1;

  // Half-step tangent anchor выводится из того же energy-bound: при h=1/(2N)
  // ошибка касательной ≤M·h²/2≤tol/4. На соседней половине exact-хорда
  // добавляет ≤tol/16, итого ≤5tol/16. Первый slope физически равен v0;
  // anchor обязан пережить RDP, иначе эта граничная производная исчезнет.
  const count = intervals + 2;
  const xs = new Array<number>(count);
  const ys = new Array<number>(count);
  // Инварианты пружины (omega0/zeta/omegaD/A/B) петле-инвариантны на всей сетке
  // (params/v0 фиксированы) → считаем их ОДИН раз фабрикой, а не на каждый узел.
  // Значение бит-в-бит равно solveSpring(...).value (см. makeSpringValueSampler).
  const sampleValue = makeSpringValueSampler(params, v0);
  xs[0] = ys[0] = 0;
  const tangentTau = 0.5 / intervals;
  xs[1] = tangentTau;
  // Считаем через тот же percent→offset, который использует WebKit execution:
  // после shortest-roundtrip CSS и keyframes делят один физический slope.
  ys[1] = v0 * ((tangentTau * 100) / 100 * T);
  for (let i = 1; i <= intervals; i++) {
    const tau = i / intervals; // ∈ [0, 1]
    const index = i + 1;
    xs[index] = tau;
    // Финитный страж (не-конечное → цель 1, зеркалит motion-value; для валидных
    // params не срабатывает — покрыто finiteness-fuzz; инвариант «в CSS никогда
    // не NaN/∞») заинлайнен в цикл — минус кадр вызова на КАЖДЫЙ узел сетки
    // (доминирующий путь cold-compile). Тот же Number.isFinite(v)?v:1, бит-в-бит.
    const v = sampleValue(tau * T);
    ys[index] = Number.isFinite(v) ? v : 1;
  }

  // eps = tolerance/2: вторая половина бюджета — под дискретизацию базовой сетки
  // (baseGridSize её и гарантирует ≤ tol/2) ⇒ суммарная реконструкция ≤ tolerance.
  const kept = douglasPeuckerVertical(xs, ys, tolerance / 2, 1);
  // Хвост — ровно цель (дисциплина эндпоинтов); прочие — сырой прогресс.
  return kept.map((k, n): SpringNode => ({
    progress: n === kept.length - 1 ? 1 : ys[k]!,
    percent: xs[k]! * 100,
  }));
}
