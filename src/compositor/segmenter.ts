/**
 * compositor/segmenter.ts — адаптивная выборка узлов пружина → CSS linear().
 *
 * Ядро отличия M1 (см. research «compass_395597 / компилятор перцептивного
 * времени»): генераторы индустрии (Джейк Арчибальд, MDN, Motion) сэмплируют
 * пружину ФИКСИРОВАННЫМ числом равноудалённых точек (~33–100), пере-сэмплируя
 * пологие кривые и недо-сэмплируя жёсткие. Здесь число узлов ВЫВОДИТСЯ из
 * бюджета ошибки, а сами узлы ставятся ЛОКАЛЬНЫМ шагом (#228): плотно там, где
 * certified-бонд кривизны |p″| высок (старт, пики перелёта), и разреженно в
 * экспоненциальном хвосте — глобальный worst-case пересэмплинг хвоста снят.
 *
 * Схема (#228, спайк в issue): базовая сетка строится локальным шагом из
 * certified-бонда кривизны на текущем состоянии (см. вывод у adaptiveGrid) —
 * её собственная кусочно-линейная ошибка ≤ tolerance/2 НА ВСЕЙ непрерывной
 * кривой; состояние переходит на следующий узел ЗАМКНУТОЙ формой solveSpring
 * (точный transition-оператор, не численный Euler). Поверх — вертикальный
 * Дуглас–Пекер (RDP) с eps = 3·tolerance/8: для функции-графика p(τ) ошибка
 * реконструкции — ВЕРТИКАЛЬНОЕ отклонение |p(τ) − lerp(τ)| (нас интересует
 * ошибка значения в момент времени, не геометрия кривой). Сериализация
 * забирает ≤ tolerance/8 (см. emitArtifact) — замкнутая арифметика ≤ tolerance.
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
import { solveSpring } from '../internal/solver.js';
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
  // Канонический порядок (#239, ревью): см. spring.ts — c/(2m) переполняется
  // при валидной массе 1e308 и рвёт масс-инвариантность горизонта.
  const alpha = params.damping / params.mass / 2;
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

// ─── #228: локальная энергетическая сетка (certified-бонды кривизны) ─────────
//
// Безразмерное состояние (канон #226): u = ω₀t, y = p−1, w = dy/du; ОДУ
// y″ + 2ζy′ + y = 0. Энергия E = (y²+w²)/2 монотонно убывает (E′ = −2ζw² ≤ 0),
// поэтому H = hypot(y, w) не растёт вдоль потока. Отсюда certified-бонды
// БУДУЩЕЙ кривизны от текущего состояния — каждый ограничивает max|y″(u+s)|
// при всех s ≥ 0, то есть на всём предстоящем шаге:
// - все режимы (Коши–Шварц к y″ = −y − 2ζw): |y″| ≤ √(1+4ζ²)·H;
// - ζ>1, модальное разложение y(s) = a·e^(−λs·s) + b·e^(−λf·s) с полюсами
//   λf = ζ+√(ζ²−1), λs = 1/λf (резольвентная форма, λs·λf = 1 точно — без
//   катастрофического вычитания, канон #226); огибающие мод не растут ⇒
//   |y″| ≤ |a|·λs² + |b|·λf² (в монотонных режимах спектральный бонд κ·H
//   завышает кривизну до κ× — модальный возвращает узлы старта);
// - ζ=1: y(s) = (y+(w+y)s)·e^(−s) ⇒ y″(s) = ((w+y)s − (y+2w))·e^(−s), и с
//   s·e^(−s) ≤ 1/e: |y″| ≤ |y+2w| + |w+y|/e.
// min() двух certified-бондов certified; near-critical ζ→1⁺ модальные амплитуды
// вырождаются (λf−λs → 0, |a|,|b| → ∞) — min сам выбирает спектральный бонд,
// magic-epsilon для ветвления не нужен.
//
// Шаг из бонда: ошибка линейной интерполяции на интервале h ≤ M·h²/8, поэтому
// h = √(4·tol/M) даёт ошибку сетки ≤ tol/2 МЕЖДУ узлами (не только в узлах).
// Tangent-anchor ставится на ЧЕТВЕРТИ первого шага: касательная в нём
// ошибается ≤ M·(h/4)²/2 = tol/8, а соседний интервал [h/4, h] несёт
// ≤ tol/8 (линейная интерполяция ошибки конца) + M·(3h/4)²/8 = 9·tol/32,
// итого ≤ 13·tol/32 < tol/2. RDP забирает 3·tol/8, сериализация ≤ tol/8
// (emitArtifact) — замкнутая арифметика ≤ tolerance. Худший замер спайка
// #228 по корпусу 54 точек: 0.666·tol.
/** Пол сетки: шаг капится 1/BASE_GRID_MIN горизонта (защита в глубину). */
const BASE_GRID_MIN = 32;
/** Физический потолок компиляции: выше живой солвер дешевле и честнее. */
export const BASE_GRID_MAX = 4096;

/** Переиспользуемый выход solveSpring: ноль аллокаций на узел сетки. */
const gridSample = { value: 0, velocity: 0 };

/**
 * Строит адаптивную базовую сетку (#228): xs — строго возрастающие τ ∈ [0,1]
 * (индекс 1 — tangent-anchor), ys — прогресс. undefined — превышен физический
 * кап BASE_GRID_MAX (fail-closed ДО больших аллокаций: массивы растут push-ем
 * и обрываются на капе) либо не-конечный горизонт (ζ=0, v0=±∞).
 * @internal — экспорт для покомпонентных доказательств бюджета (сетка ≤ tol/2
 * отдельно от RDP ≤ 3tol/8), не часть публичного API ./compositor.
 */
export function tryBuildAdaptiveSpringGrid(
  params: SpringParams,
  v0: number,
  tolerance: number,
  settle: number,
): [xs: number[], ys: number[]] | undefined {
  // Не-конечный горизонт не имеет представимой сетки — O(1) отказ до цикла
  // (пин: MAX_VALUE-скорость не аллоцирует гигантский массив).
  if (!Number.isFinite(settle) || settle <= 0) return undefined;
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  const alpha = params.damping / params.mass / 2;
  const zeta = alpha / omega0;
  const delta = omega0 * omega0 - alpha * alpha;
  const kappa = Math.sqrt(1 + 4 * zeta * zeta);
  // Петле-инвариантные модальные полюса (ζ>1); λs резольвентной формой.
  const lambdaF = zeta + Math.sqrt(Math.max(0, zeta * zeta - 1));
  const lambdaS = 1 / lambdaF;
  const poleGap = lambdaF - lambdaS;
  // Перевод шага u → τ и пол сетки (≥ BASE_GRID_MIN интервалов на горизонте).
  const omegaT = omega0 * settle;
  const capTau = 1 / BASE_GRID_MIN;
  const xs: number[] = [0];
  const ys: number[] = [0];
  // Стартовое состояние точно: p(0)=0 ⇒ y=−1; w = v0/ω₀ (безразмерная скорость).
  let tau = 0;
  let y = -1;
  let w = v0 / omega0;
  while (tau < 1) {
    // Certified-бонд кривизны на всём предстоящем шаге (вывод в шапке блока).
    let bound = kappa * Math.hypot(y, w);
    // Условие модальной ветки — poleGap > 0, а НЕ delta < 0 (математически это
    // одно и то же, ζ>1). Разница ровно в вырожденном случае: если ζ округлился
    // в 1 при delta<0, то poleGap = 0, и модальный кандидат даёт −0/0 = NaN;
    // `Math.min(x, NaN)` = NaN ⇒ `bound > 0` ложно ⇒ шаг МОЛЧА становится капом,
    // и доказанный бюджет сетки перестаёт держаться (fail-OPEN). Проверка
    // знаменателя оставляет в этом случае спектральный бонд — fail-closed
    // без единого лишнего байта в бандле.
    if (poleGap > 0) {
      const b = -(w + lambdaS * y) / poleGap;
      const a = y - b;
      bound = Math.min(bound, Math.abs(a) * lambdaS * lambdaS + Math.abs(b) * lambdaF * lambdaF);
    } else if (delta === 0) {
      bound = Math.min(bound, Math.abs(y + 2 * w) + Math.abs(w + y) / Math.E);
    }
    // M·h²/8 ≤ tol/2 ⇔ h ≤ 2·√(tol/M); осевшее состояние (M=0) шагает капом.
    const step = bound > 0
      ? Math.min(capTau, 2 * Math.sqrt(tolerance / bound) / omegaT)
      : capTau;
    if (tau === 0) {
      // Tangent-anchor на четверти первого шага: значение — ФИЗИЧЕСКАЯ
      // касательная v0 (не сэмпл), тем же percent→offset путём, что WebKit
      // execution: после shortest-roundtrip CSS и keyframes делят один slope.
      const anchorTau = step / 4;
      xs.push(anchorTau);
      ys.push(v0 * ((anchorTau * 100) / 100 * settle));
    }
    const next = Math.min(tau + step, 1);
    // Шаг, съеденный округлением у плотного бонда, эквивалентен over-cap:
    // без стража цикл не продвигается (fail-closed, не зависание).
    if (next === tau || xs.length > BASE_GRID_MAX) return undefined;
    const sampled = solveSpring(params, next * settle, v0, gridSample);
    // Финитные стражи зеркалят политику motion-value (value→1, velocity→0);
    // для валидных params не срабатывают — инвариант «в CSS никогда не NaN/∞».
    const value = Number.isFinite(sampled.value) ? sampled.value : 1;
    xs.push(next);
    ys.push(value);
    y = value - 1;
    w = Number.isFinite(sampled.velocity) ? sampled.velocity / omega0 : 0;
    tau = next;
  }
  return [xs, ys];
}

/**
 * Размер базовой сетки (число ИНТЕРВАЛОВ) фактической адаптивной сетки (#228).
 * Тестовый seam бюджета: НЕ O(1) — строит сетку (compile-as-preflight канон).
 */
export function baseGridSize(
  params: SpringParams,
  settle: number,
  tolerance: number,
  v0 = 0,
): number {
  const grid = tryBuildAdaptiveSpringGrid(params, v0, tolerance, settle);
  if (grid === undefined) throw new MotionParamError('LM016');
  return grid[0].length - 1;
}

/**
 * Можно ли доказанно скомпилировать скорость в ограниченную compositor-сетку.
 * С #228 предикат — сама попытка построения сетки (бывшая O(1) формула global
 * worst-case grid снята вместе с самой сеткой; второго источника правды нет).
 * Production-путь это не зовёт: там compile-as-preflight через
 * tryCompileSpringExecutionArtifactTupleUnchecked, а не отдельный гейт.
 */
export function fitsSpringCurveBudget(
  params: SpringParams,
  v0: number,
  tolerance: number,
): boolean {
  const settle = springCompileHorizon(params, v0, tolerance);
  return tryBuildAdaptiveSpringGrid(params, v0, tolerance, settle) !== undefined;
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
 * защищённой anchor-точкой и далее строго растущими τ, так что предусловие
 * держится по построению. Прежний per-точечный страж
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
 * кэшированию; over-cap возвращает undefined на капе степпинга (ограниченные
 * push-массивы, без гигантской аллокации) и до смены owner.
 */
export function tryBuildSpringNodes(
  params: SpringParams,
  v0: number,
  tolerance: number,
): [nodes: SpringNode[], horizon: number] | undefined {
  const settle = springCompileHorizon(params, v0, tolerance);
  const grid = tryBuildAdaptiveSpringGrid(params, v0, tolerance, settle);
  if (grid === undefined) return;
  // eps = 3·tolerance/8: сетка несёт ≤ tol/2, сериализация ≤ tol/8 — замкнутая
  // арифметика ≤ tolerance на всей непрерывной кривой (не только в узлах).
  const kept = douglasPeuckerVertical(grid[0], grid[1], tolerance * 3 / 8, 1);
  const xs = grid[0];
  const ys = grid[1];
  // Хвост — ровно цель (дисциплина эндпоинтов); прочие — сырой прогресс.
  const nodes = kept.map((k, n): SpringNode => ({
    progress: n === kept.length - 1 ? 1 : ys[k]!,
    percent: xs[k]! * 100,
  }));
  return [nodes, settle];
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
