/** Невалидирующее ядро CSS cubic-bezier для публичного easing и defaults. */

const NEWTON_ITERS = 8;
const EPSILON = 1e-7;
const DERIV_THRESHOLD = 1e-6;
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
    if (dxAt(guess, x1, x2) >= DERIV_THRESHOLD) {
      for (let i = 0; i < NEWTON_ITERS; i++) {
        const slope = dxAt(guess, x1, x2);
        if (slope === 0) break;
        guess -= (xAt(guess, x1, x2) - input) / slope;
      }
    } else {
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
