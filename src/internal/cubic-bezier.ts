/** Невалидирующее ядро CSS cubic-bezier для публичного easing и defaults. */

const NEWTON_ITERS = 8;
const EPSILON = 1e-7;
const TABLE_SIZE = 11;

function endpoint(t: number): number | undefined {
  if (!Number.isFinite(t)) return Number.isNaN(t) || t < 0 ? 0 : 1;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return undefined;
}

function finite(value: number): number {
  if (Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return 0;
  return value > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

function xAt(t: number, x1: number, x2: number): number {
  return (1 - t) * 3 * (1 - t) * t * x1
    + 3 * (1 - t) * t * t * x2
    + t * t * t;
}

function yAt(t: number, y1: number, y2: number): number {
  return (1 - t) * 3 * (1 - t) * t * y1
    + 3 * (1 - t) * t * t * y2
    + t * t * t;
}

function dxAt(t: number, x1: number, x2: number): number {
  return 3 * (1 - t) * (1 - t) * x1
    + 6 * (1 - t) * t * (x2 - x1)
    + 3 * t * t * (1 - x2);
}

/** Предусловие: finite control points, x1/x2 в [0,1], не diagonal fast-path. */
export function cubicBezierUnchecked(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  const table = new Float64Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) table[i] = xAt(i / (TABLE_SIZE - 1), x1, x2);

  return (input: number): number => {
    const edge = endpoint(input);
    if (edge !== undefined) return edge;
    let intervalStart = 0;
    let sample = 1;
    const last = TABLE_SIZE - 1;
    while (sample !== last && table[sample]! <= input) {
      intervalStart += 1 / last;
      sample++;
    }
    sample--;
    const distance = (input - table[sample]!) / (table[sample + 1]! - table[sample]!);
    let guess = intervalStart + distance / last;
    // Порог производной на СТАРТОВОЙ точке больше не нужен: Ньютон пробуется
    // всегда, а его результат проверяется ниже. Дешевле и надёжнее — прежний
    // порог смотрел не туда (см. ниже).
    for (let i = 0; i < NEWTON_ITERS; i++) {
      const slope = dxAt(guess, x1, x2);
      if (slope === 0) break;
      guess -= (xAt(guess, x1, x2) - input) / slope;
    }
    // Ньютон здесь БЕЗ брекета, поэтому его результат обязателен к проверке:
    // прежний код смотрел на производную в СТАРТОВОЙ точке и, если она крутая,
    // гнал 8 итераций без единой проверки сходимости. Но старт может быть
    // крутым при том, что ВНУТРИ интервала x'(t) обращается в ноль. Ровно так
    // устроена валидная CSS-кривая cubic-bezier(1,0,0,1): x'(t) = 3(1−2t)² —
    // двойной корень в t = 0.5, шаг делится на ~0 и улетает.
    // Замер (аудит 2026-07-25): вход x = 0.500015 давал 0.99875 вместо
    // 0.52330 — ошибка 0.475, плюс нарушение монотонности; полоса поражения
    // x ∈ [0.49979, 0.50021], 80 точек из 200 001. cubic-bezier(1,1,0,0) —
    // ошибка 0.0152 там же. Обычные кривые (0.9,0,0.1,1), (0.5,0,0.5,1)
    // не задеты вовсе (0.000000).
    // Отрицание сравнения ловит и NaN: расходящийся шаг уходит в бисекцию,
    // а она сходится гарантированно — брекет таблицы содержит корень, потому
    // что x(t) монотонна при x1, x2 ∈ [0,1] (условие валидности CSS).
    if (!(Math.abs(xAt(guess, x1, x2) - input) < EPSILON)) {
      let lo = intervalStart;
      let hi = intervalStart + 1 / last;
      for (let i = 0; i < 54; i++) {
        const mid = (lo + hi) / 2;
        const delta = xAt(mid, x1, x2) - input;
        if (Math.abs(delta) < EPSILON) {
          guess = mid;
          break;
        }
        if (delta < 0) lo = mid;
        else hi = mid;
        guess = (lo + hi) / 2;
      }
    }
    return finite(yAt(guess, y1, y2));
  };
}
