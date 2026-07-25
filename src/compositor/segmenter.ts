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
 * Длительность плана = springCompileHorizon: запечатанный канонический закон
 * оседания spring.ts (не новая параллельная константа) плюс ln-дефицит, если
 * остаток на нём не помещается в отведённую снапу долю бюджета. Хвостовой узел
 * форсится в ровно 1 (дисциплина эндпоинтов, как springAsEasing), поэтому
 * |p(T) − 1| — не «почти ноль», а полноценная статья бюджета: до 2026-07-25 она
 * в бюджет не входила и на медленных пружинах превышала его вдвое.
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
 * Дефолтный бюджет реконструкции (ед. прогресса). Определён здесь (а не в
 * curve.ts) — горизонт-закон не может импортировать curve без цикла; curve
 * реэкспортирует. Колена у горизонт-закона больше нет: до 2026-07-25 это
 * значение работало ещё и порогом ветвления `tolerance >= DEFAULT_TOLERANCE`,
 * и именно та ветка молча нарушала обещанный бюджет (см. springCompileHorizon).
 */
export const DEFAULT_TOLERANCE: number = 1 / 400;

/**
 * Знаменатель доли бюджета реконструкции, отданной ТЕРМИНАЛЬНОМУ СНАПУ в 1
 * (снап ≤ tolerance / SNAP_BUDGET_SHARE).
 *
 * Та же доля, что у базовой сетки, и по той же причине: обе — ошибки против
 * ИСТИННОЙ кривой (RDP и сериализация меряются против сетки). Доли не
 * складываются: снап максимален в τ=1, где отклонение сетки и RDP тождественно
 * ноль (последний узел сетки — точный сэмпл solveSpring, а концы RDP не
 * трогает), тогда как максимум сетки лежит в зоне высокой кривизны у старта.
 * Замер этого утверждения — в шапке horizon-закона ниже.
 */
const SNAP_BUDGET_SHARE = 2;

/**
 * Горизонт компиляции (#223, переписан аудитом 2026-07-25).
 *
 * ЧТО БЫЛО СЛОМАНО. Прежний закон при `tolerance >= DEFAULT_TOLERANCE`
 * возвращал settle БЕЗУСЛОВНО, полагая терминальный снап «покрытым
 * перцептивным бюджетом». Но закон оседания гарантирует лишь
 * |p−1| ≤ ε/max(1, ω₀) при v0 = 0 и ≤ ε при v0 ≠ 0 (ε = CONVERGENCE_THRESHOLD
 * = 0.005 = ДВА дефолтных бюджета). Последний узел плана форсится в ровно 1,
 * поэтому остаток — ПРЯМАЯ ошибка реконструкции, и у медленных пружин он
 * съедал бюджет целиком и с запасом. Замеры на span 1000 px при запрошенных
 * ≤ 2.5 px:
 *   {1,1,4}    ω₀ = 1   v0 = 0  → 5.000 px = 2.000× бюджета
 *   {1,1,1.98} ω₀ = 1   v0 = 0  → 4.615 px = 1.846×
 *   {1,1,1}    ω₀ = 1   v0 = 3  → 4.882 px = 1.953×
 *   {4,1,2}    ω₀ = 0.5 v0 = 0  → 4.333 px = 1.733×
 * Публично обещанный контракт maxValueError нарушался тихо: корпус
 * compositor-max-value-error состоял только из ω₀ = 10, где остаток вдесятеро
 * меньше бюджета, и держался на 0.38–0.50×. Развёртка по сетке (ω₀, ζ) ×
 * масса × v0 × бюджеты, ≈12 000 планов: 780 нарушений, худшее 2.000×.
 *
 * ЗАКОН СЕЙЧАС. Ветвления по tolerance нет вовсе. Горизонт — settle плюс
 * ln-дефицит до доказанного остатка ≤ tolerance/SNAP_BUDGET_SHARE; дефицит
 * неположителен ⇒ горизонт БИТ-В-БИТ равен прежнему, и артефакты таких пружин
 * не меняются. При дефолтном бюджете дефицит положителен ровно при
 * max(1, ω₀) < 2ε/tolerance = 4 (v0 = 0 и underdamped) — то есть продлеваются
 * ровно медленные пружины, чей остаток бюджет и не держал. Канон {1,170,26},
 * {1,100,10}, {1,100,20}, {1,100,40}, {1,16,4}, {1,300,20} — без изменений.
 *
 * Отвергнутые альтернативы (замерены, не предположены):
 *   • `settle + ln(ε/(tolerance/8))/rate` (форма #223 без шортката) —
 *     игнорирует уже достигнутый на settle остаток и продлевает ВСЕХ: канон
 *     при дефолте +26.6 % длительности на пустом месте;
 *   • отдельный закон «время до остатка» с собственной модальной амплитудой —
 *     точнее на ~3 % длительности, но +123 B gz в бандле потребителя: пробиты
 *     четыре порога, включая продуктовую границу compositor-stagger.
 *
 * ЗАМЕР ПОСЛЕ ПРАВКИ на той же развёртке ≈12 000 планов: нарушений ноль,
 * худшее 0.699× бюджета (ω₀ = 3.816, ζ = 0.201, v0 = 4) — то есть худший
 * случай определяет конвейер сетка+RDP+эмит, а не снап. Пин — property-тест
 * в compositor-max-value-error.test.ts.
 *
 * Чистая функция (params, v0, tolerance) — кэш-ключ артефактов остаётся
 * корректным без флагов.
 */
export function springCompileHorizon(
  params: SpringParams,
  v0: number,
  tolerance: number,
): number {
  const settle = settleTimeUpperBound(params, v0);
  const omega0 = Math.sqrt(params.stiffness / params.mass);
  // Канонический порядок (#239): (c/m)/2, а НЕ c/(2m) — второе переполняется при
  // валидной массе 1e308 и рвёт масс-инвариантность горизонта (а с ней —
  // exact-ключ кэша артефактов).
  const alpha = params.damping / params.mass / 2;
  // НИЖНЯЯ оценка скорости затухания огибающей. Занизить её безопасно (горизонт
  // выйдет длиннее нужного), завысить — нет. При ζ < 1 (ω₀ > α) оценка ТОЧНА:
  // rate = α. У передемпфированных ω₀²/(2α) ≤ ω₀²/(α+√(α²−ω₀²)) = точному
  // медленному полюсу, и тем ближе к нему, чем сильнее демпфирование
  // (√(α²−ω₀²) → α). Точный полюс стоит лишних байт в бандле потребителя ради
  // ≤2× запаса на продлении ОДНОГО класса пружин — передемпфированных около
  // критического, которые продлеваются и без того редко.
  const rate = omega0 > alpha ? alpha : omega0 * omega0 / (2 * alpha);
  // ln-дефицит между остатком, достигнутым законом оседания в точке settle, и
  // долей бюджета, отведённой снапу. Закон оседания строже ε по ЗНАЧЕНИЮ ровно
  // в max(1, ω₀) раз — тот же член max(0, ln ω₀), что стоит в самом законе:
  //   v0 = 0 — по построению: член вписан в needLn, поэтому
  //     amp·e^(−needLn) ≤ ε/max(1, ω₀) тождественно;
  //   v0 ≠ 0 и ζ < 1 — из точного модального тождества (выведено алгеброй): у
  //     underdamped амплитуда СКОРОСТИ ровно в ω₀ раз больше амплитуды
  //     ЗНАЧЕНИЯ, ampV² = ω₀²·ampY² тождественно, поэтому max(ampY, ampV) в
  //     законе — это ω₀·ampY при ω₀ ≥ 1, и остаток значения выходит ≤ ε/ω₀;
  //   v0 ≠ 0 и ζ ≥ 1 — тождество НЕ выполняется (моды затухают с разными
  //     полюсами, и амплитуда скорости больше не кратна ω₀), закон гарантирует
  //     только ε. Ужесточение здесь БЫЛО ПРОБОВАНО и отвергнуто замером:
  //     развёртка по сетке дала 288 нарушений, худшее 4.997× бюджета
  //     (ω₀ = 48.5, ζ = 6.69, v0 = 4). Ветка ζ ≥ 1 при v0 ≠ 0 продлевается
  //     полностью — это цена честной границы, а не запас «на всякий случай».
  //
  // Оговорка честности: у v0 ≠ 0 и ζ ≳ 0.75 связывает не модальная, а
  // полиномиальная ветка закона, и отношение argY/max(argY, argV) бывает до
  // ~1.3/ω₀ вместо 1/ω₀ — снап забирает до ~0.65·tolerance вместо 0.5.
  // Замкнутый бюджет это держит: развёртка (ω₀, ζ) × масса × v0 × бюджеты
  // (≈12 000 планов) даёт худшее 0.68·tolerance — пин property-тестом в
  // compositor-max-value-error.test.ts.
  //
  // Дальше огибающая падает не медленнее e^(−7·rate·Δ/8): полиномиальная форма
  // |y| ≤ e^(−rate·t)·(1 + |v0−α|·t) с приёмом t·e^(−rate·t/8) ≤ 8/(e·rate)
  // верна во ВСЕХ режимах, а множитель 8/7 покрывает и модальную ветку закона.
  const deficit = 8 * (
    Math.log(SNAP_BUDGET_SHARE * CONVERGENCE_THRESHOLD / tolerance)
    - (v0 === 0 || omega0 > alpha ? Math.max(0, Math.log(omega0)) : 0)
  ) / (7 * rate);
  // Fail-closed: NaN (ζ = 0 при v0 = 0 даёт 0/0 в rate) сравнения не проходит —
  // остаётся settle, а он в этом режиме и так Infinity, и бюджет-гейт отвергнет
  // пружину как непригодную для compositor-плана.
  return deficit > 0 ? settle + deficit : settle;
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
