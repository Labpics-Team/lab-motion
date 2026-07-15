/**
 * animate/linear-compile.ts — лёгкий компилятор прогресса для WAAPI-first
 * ядра ./animate (срез R1 rebuild): ядро строит ПОРТИРУЕМЫЙ IR-артефакт,
 * отдельный крошечный сериализатор превращает его в CSS linear().
 *
 * Слоистость среза:
 *   1. Ядро (springProgressCurve / easeProgressCurve) отдаёт ProgressCurveIR —
 *      чистые JSON-сериализуемые данные без знания о CSS: числа и plain-массив
 *      пар [offset, value]. Тот же артефакт позже исполняют платформенные
 *      раннеры (Swift/Kotlin/RN/Flutter и т.д.) и explicit-keyframes путь
 *      WAAPI (пары = offsets кадров).
 *   2. toLinear(points) — единственное место, где рождается строка
 *      `linear(${points})`. Квантование и финальная 1 происходят в
 *      сэмплере/RDP-стадии, сериализатор только форматирует.
 *   3. springProgressLinear / easeProgressLinear — композиция «IR → строка»
 *      для вызывающего, которому нужен готовый CSS.
 *
 * Отличие от compositor-тракта (curve.ts + segmenter.ts): та цепочка несёт
 * адаптивную сетку, exact-key LRU, tangent-anchor и percent-квантование по
 * наклону (~1.3 КБ gz). Здесь — минимальный синхронный путь animate-графа:
 * равномерная сетка из честной границы ошибки + RDP-прореживание, без кэша.
 * Физика НЕ дублируется: позиция сэмплируется единым аналитическим солвером
 * (internal/solver, v0-базис), длительность — запечатанным законом оседания
 * spring.ts, потолок узлов — общий BASE_GRID_MAX сегментера.
 *
 * Контракт отказа: любой вход, не представимый синхронным артефактом
 * (перебор сетки, неконечные params/v0/tolerance, незатухающая пружина),
 * возвращает undefined — вызывающий уходит на живой frame-loop. Исключения
 * бросает только ease-путь: hostile ease — ошибка вызывающего, а не
 * физическая непредставимость. Нефинитность режется ДО артефакта: в IR
 * не попадают NaN/Infinity ни при каком входе.
 *
 * Не публичный entry: модуль внутренний, exports в package.json не участвует.
 */

import { BASE_GRID_MAX } from '../compositor/segmenter.js';
import { MotionParamError } from '../errors.js';
import { makeSpringValueSampler, solveSpring } from '../internal/solver.js';
import { settleTimeUpperBound, type SpringParams } from '../spring.js';

/**
 * Портируемый IR скомпилированной кривой прогресса (будущий versioned IR).
 *
 * points — плоское чередование [offset, value, offset, value, ...]:
 *   - offset ∈ [0, 1] — нормированная доля длительности, строго возрастает,
 *     первый ровно 0, последний ровно 1 (квант 1e-6);
 *   - value — прогресс в точке (квант 1e-4; у пружины последний ровно 1,
 *     переливы <0/>1 допустимы — это физика underdamped-подхвата).
 * Только конечные числа и plain-массив: артефакт обязан переживать
 * JSON/structuredClone без потерь — это контракт кроссплатформенности.
 * Плоская числовая форма — та же, что у SpringSerializedSamples компоузера,
 * и самая дешёвая для FFI/bridge исполнителей.
 */
export interface ProgressCurveIR {
  readonly durationMs: number;
  readonly points: number[];
}

/** Композиция IR → CSS для вызывающего, которому нужна готовая строка. */
export interface SpringProgressLinear {
  readonly durationMs: number;
  readonly easing: string;
}

// Единый ε модуля (дефолт): бюджет дискретизации равномерной сетки, порог
// RDP-прореживания и цель дожима хвоста. Тот же физический допуск 1e-3, что
// у nano; суммарная ошибка реконструкции ≤ 2ε + квантование (см. ниже).
const EPSILON_DEFAULT = 1e-3;

// Канонический settle-закон spring.ts целится в CONVERGENCE_THRESHOLD=5e-3.
// Дожим хвоста до ε идёт вперёд шагом horizon/64: огибающая на горизонте уже
// ≤5e-3 и падает экспоненциально, так что добор 5e-3→1e-3 стоит ~10–20 шагов
// (ln5 e-fold'ов при ~6–12 шагах на e-fold). Кап — страховка от hostile
// tolerance→0: за ним честный отказ, не вечный цикл.
const SETTLE_REFINE_STEPS_MAX = 1024;

// Кратность шага дожима: 64 шага на канонический горизонт ⇒ перебор
// длительности за точкой оседания ≤ horizon/64 (<2%), консервативно вперёд.
const SETTLE_REFINE_DIVISOR = 64;

// Плотность сэмплирования произвольного ease: кривизна вызова неизвестна,
// поэтому N фиксирован и выводится из ε в обратную сторону — равномерная
// сетка с ошибкой сегмента ≤ max|f″|·h²/8 покрывает ε=1e-3 для всех
// |f″| ≤ 8εN² = 8·1e-3·256² ≈ 524. Эталонный STANDARD_EASING держит
// |f″| ≲ 6 (запас ~90×), bezier/power-класс движка — того же порядка;
// фактическую ошибку сверяет дифференциальный тест на STANDARD_EASING.
const EASE_GRID_INTERVALS = 256;

/**
 * Вертикальный Дуглас–Пекер, специализация для РАВНОМЕРНОЙ сетки: абсцисса —
 * сам индекс (xs[i] = i), деление наклона хорды выполняется один раз на
 * интервал стека. Не переиспользует douglasPeuckerVertical сегментера
 * намеренно: у того контракт «единственный вызывающий — buildSpringNodes»
 * (защищённый tangent-узел, произвольные xs), а лёгкому пути хватает ys.
 * Возвращает возрастающие индексы оставленных узлов, концы всегда живы.
 */
function thinUniformVertical(ys: ArrayLike<number>, eps: number): number[] {
  const n = ys.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j <= i + 1) continue;
    const yi = ys[i]!;
    const slope = (ys[j]! - yi) / (j - i);
    let maxDev = -1;
    let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const dev = Math.abs(ys[k]! - (yi + slope * (k - i)));
      if (dev > maxDev) {
        maxDev = dev;
        idx = k;
      }
    }
    // NaN-безопасно: NaN > eps === false ⇒ hostile-значения не зацикливают
    // стек (в IR такой вход всё равно не попадает — вызывающие режут раньше).
    if (maxDev > eps) {
      keep[idx] = 1;
      stack.push(i, idx, idx, j);
    }
  }
  const kept: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k] === 1) kept.push(k);
  return kept;
}

/**
 * Сборка IR-пар из оставленных узлов равномерной сетки — квантование живёт
 * здесь (стадия сэмплера/RDP), НЕ в сериализаторе:
 *   - value: 1e-4 — вклад в ошибку ≤ 0.5e-4 по прогрессу;
 *   - offset: 1e-6 — сдвиг времени даёт ошибку ≤ |dp/dτ|·0.5e-6 = T·|x′|·0.5e-6
 *     ≤ T·H·0.5e-6 (обычно ~1e-5, на потолке сетки ≤ ~2e-4) — на порядок
 *     тоньше кванта value, потому и квант мельче.
 * Концы точны по построению: kept[0]=0 → offset 0; kept[last]=N → offset 1,
 * а value последнего узла засняплен в ровно 1 ещё до RDP.
 */
function assembleCurvePoints(
  ys: ArrayLike<number>,
  kept: readonly number[],
  intervals: number,
): number[] {
  const points: number[] = [];
  for (const k of kept) {
    const value = Math.round(ys[k]! * 1e4) / 1e4;
    // −0 (округлённый малый недолёт) не переживает JSON — нормализуем в +0,
    // иначе roundtrip-паритет артефакта ломается на знаке нуля.
    points.push(Math.round((k / intervals) * 1e6) / 1e6, value === 0 ? 0 : value);
  }
  return points;
}

/**
 * Единственное место рождения CSS-строки `linear(${points})`. Сериализатор
 * не квантует и не снапит — IR уже квантован стадией сэмплера/RDP; здесь
 * только формат: внутренние стопы несут явный `<percent>%` (после RDP они
 * неравноудалённы), концевые позиции CSS ставит сам (0%/100%) — токены
 * короче. toFixed(4) на процентах не меняет квантованный offset (квант
 * 1e-6 ⇒ ровно 4 десятичных знака процента), а лишь срезает двоичный шум
 * умножения на 100.
 *
 * Предусловие (IR соблюдает по построению): чётная длина ≥ 4, offsets
 * строго возрастают от ровно 0 до ровно 1.
 */
export function toLinear(points: readonly number[]): string {
  const last = points.length - 2;
  const tokens: string[] = [];
  for (let i = 0; i <= last; i += 2) {
    const value = points[i + 1]!;
    tokens.push(
      i === 0 || i === last
        ? String(value)
        : `${value} ${Number((points[i]! * 100).toFixed(4))}%`,
    );
  }
  return `linear(${tokens})`;
}

/**
 * Плотная равномерная сетка прогресса пружины с начальной нормированной
 * скоростью v0 (C¹-подхват; v0=0 — из покоя). undefined — не представимо
 * синхронным артефактом (см. контракт модуля).
 *
 * Длительность: канонический settleTimeUpperBound(p, v0) — огибающие позиции
 * И скорости с вкладом v0 (без него хвост ретаргета недооценивается), затем
 * односторонний дожим вперёд до ε модуля: |1−x(T)| ≤ ε и |x′(T)|/30 ≤ ε
 * (скорость нормируется полукадром 1/30 c, как в nano). Дожим не укорачивает:
 * позиция пересекает цель при перелёте, и «раннее» |1−x|=0 не означает покоя.
 *
 * Число узлов: для кусочно-линейной реконструкции ошибка сегмента
 * ≤ max|x″|·h²/8. Граница кривизны при v0≠0 НЕ ω₀² — вывод из энергии
 * затухающего осциллятора: E = (x′² + ω₀²(x−1)²)/2 невозрастает
 * (E′ = −(c/m)·x′² ≤ 0), откуда |x′| ≤ H и ω₀|x−1| ≤ H при
 * H = hypot(v0, ω₀) = √(2E(0)); подстановка в ODE x″ = −(c/m)x′ − ω₀²(x−1)
 * даёт |x″| ≤ (c/m)·H + ω₀²·H/ω₀ = (ω₀ + c/m)·H. При v0=0 граница
 * (ω₀ + c/m)·ω₀ ≥ ω₀² — консервативнее nano-оценки, честна для всех режимов.
 * Отсюда интервалов N ≥ T·√(M/(8ε)), M = (ω₀ + c/m)·H.
 *
 * @internal — экспорт для дифференциальных тестов, не часть API ./animate.
 */
export function buildSpringProgressGridUnchecked(
  spring: SpringParams,
  v0Norm: number,
  tolerance: number,
): { durationS: number; intervals: number; ys: Float64Array } | undefined {
  // Некомпилируемая толерантность — undefined до какой-либо работы: внутренний
  // seam не бросает, политика валидации опций остаётся на фасаде (LM014 — у
  // compositor-границы, граница animate живёт этажом выше).
  if (!(tolerance > 0 && tolerance < 1)) return undefined;
  const horizon = settleTimeUpperBound(spring, v0Norm);
  // Незатухающая (ζ=0) и любые неконечные входы дают неконечный горизонт.
  if (!Number.isFinite(horizon) || horizon <= 0) return undefined;

  const omega0 = Math.sqrt(spring.stiffness / spring.mass);
  // M = max|x″| — вывод в докблоке выше; NaN/∞ входов протекают в NaN и
  // срезаются проверкой потолка ниже (!(x <= cap) ловит NaN и Infinity).
  const curvatureMax =
    (omega0 + spring.damping / spring.mass) * Math.hypot(v0Norm, omega0);
  const gridDensity = Math.sqrt(curvatureMax / (8 * tolerance));
  // Preflight по нижней границе длительности: дожим только удлиняет T, так что
  // обречённая сетка отбрасывается до итераций солвера (compile-as-preflight).
  if (!(Math.ceil(horizon * gridDensity) <= BASE_GRID_MAX)) return undefined;

  let durationS = horizon;
  const probe = { value: 0, velocity: 0 };
  const step = horizon / SETTLE_REFINE_DIVISOR;
  let budget = SETTLE_REFINE_STEPS_MAX;
  solveSpring(spring, durationS, v0Norm, probe);
  while (
    Math.abs(1 - probe.value) > tolerance ||
    Math.abs(probe.velocity) / 30 > tolerance
  ) {
    if (--budget < 0) return undefined;
    durationS += step;
    solveSpring(spring, durationS, v0Norm, probe);
  }

  const intervals = Math.max(1, Math.ceil(durationS * gridDensity));
  if (!(intervals <= BASE_GRID_MAX)) return undefined;

  const sample = makeSpringValueSampler(spring, v0Norm);
  const ys = new Float64Array(intervals + 1);
  // ys[0] = 0 — zero-init совпадает с sample(0) бит-в-бит (t≤0 ветка солвера).
  for (let i = 1; i < intervals; i++) {
    const value = sample((durationS * i) / intervals);
    // Неконечный сэмпл = непредставимость, не клэмп: подмена значения на лету
    // телепортировала бы подхваченную середину траектории. Живой путь честнее,
    // и инвариант «в IR никогда не NaN/∞» держится на любом входе.
    if (!Number.isFinite(value)) return undefined;
    ys[i] = value;
  }
  // Дисциплина эндпоинтов: хвост — ровно цель. Снап ДО прореживания, чтобы
  // RDP видел фактически эмитируемую кривую; остаток |1−x(T)| ≤ ε по дожиму.
  ys[intervals] = 1;
  return { durationS, intervals, ys };
}

/**
 * Ядро A: пружина (нормированный прогресс 0→1, начальная скорость v0Norm,
 * 1/с) → портируемый ProgressCurveIR, либо undefined для живого пути.
 * Params валидирует вызывающий (validateSpringParams на фасаде);
 * hostile-числа сворачиваются в undefined, не в исключение.
 *
 * Бюджет ошибки восстановления против аналитической траектории: дискретизация
 * сетки ≤ ε плюс RDP ≤ ε на узлах плюс квантование ≤ ~0.5e-4 — суммарно ≤ 2ε
 * с копейками (дефолт 2·1e-3; дифференциальный тест против RK4 держит 2e-3 с
 * измеренным запасом). Полный compositor дополнительно защищает касательную
 * v0 отдельным узлом сквозь RDP; лёгкий путь сохраняет подхват в пределах ε.
 */
export function springProgressCurve(
  spring: SpringParams,
  v0Norm: number,
  toleranceOpt?: number,
): ProgressCurveIR | undefined {
  const tolerance = toleranceOpt ?? EPSILON_DEFAULT;
  const grid = buildSpringProgressGridUnchecked(spring, v0Norm, tolerance);
  if (grid === undefined) return undefined;
  // Порог RDP = тот же ε. Прореживание работает на данных ДО сериализации:
  // прореженная полилиния отклоняется от плотной ≤ ε, короче артефакт —
  // быстрее и style-парсинг строки, и любой платформенный исполнитель.
  const kept = thinUniformVertical(grid.ys, tolerance);
  return {
    durationMs: grid.durationS * 1000,
    points: assembleCurvePoints(grid.ys, kept, grid.intervals),
  };
}

/**
 * Ядро B: произвольная ease-функция прогресса → портируемый ProgressCurveIR
 * (RDP ε=1e-3). Сэмплирование детерминировано: фиксированная сетка без clock
 * и адаптивности по времени исполнения — одинаковые входы дают идентичный
 * артефакт. Неконечный сэмпл (NaN/±∞) — ошибка вызывающего, а не
 * непредставимость: LM158 бросается на первом же плохом значении, до сборки
 * какого-либо артефакта. Собственное исключение ease не маскируется кодом
 * каталога и всплывает как есть (прецедент easingToLinear); частичный
 * артефакт невозможен — сборка начинается после полного прохода.
 */
export function easeProgressCurve(
  ease: (t: number) => number,
  durationMs: number,
): ProgressCurveIR {
  // Та же граница «animate duration», что у tween-фасада: компилятор обязан
  // падать до конструирования WAAPI-объектов вызывающим.
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new MotionParamError('LM137');
  }
  const ys = new Float64Array(EASE_GRID_INTERVALS + 1);
  for (let i = 0; i <= EASE_GRID_INTERVALS; i++) {
    const value = ease(i / EASE_GRID_INTERVALS);
    if (!Number.isFinite(value)) {
      throw new MotionParamError('LM158');
    }
    ys[i] = value;
  }
  const kept = thinUniformVertical(ys, EPSILON_DEFAULT);
  return {
    durationMs,
    points: assembleCurvePoints(ys, kept, EASE_GRID_INTERVALS),
  };
}

/** Композиция A: IR → CSS для вызывающего, которому нужна готовая строка. */
export function springProgressLinear(
  spring: SpringParams,
  v0Norm: number,
  toleranceOpt?: number,
): SpringProgressLinear | undefined {
  const curve = springProgressCurve(spring, v0Norm, toleranceOpt);
  if (curve === undefined) return undefined;
  return { durationMs: curve.durationMs, easing: toLinear(curve.points) };
}

/** Композиция B: IR → CSS; длительность валидируется в ядре (LM137). */
export function easeProgressLinear(
  ease: (t: number) => number,
  durationMs: number,
): string {
  return toLinear(easeProgressCurve(ease, durationMs).points);
}
