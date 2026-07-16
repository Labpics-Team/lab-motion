/**
 * Bounded exact arithmetic for the binary64 schedule oracle.
 *
 * A binary64 value is a dyadic rational with at most 53 significant bits and
 * an exponent in a fixed range. BigInt therefore does not make this algorithm
 * input-sized: every operation is bounded by the IEEE-754 binary64 domain.
 */

interface Dyadic {
  readonly coefficient: bigint;
  readonly exponent: number;
}

export interface MotionProgramInfiniteBoundaryV1 {
  readonly iteration: bigint;
  readonly boundaryMs: number;
}

const FRACTION_BITS = 52n;
const FRACTION_MASK = (1n << FRACTION_BITS) - 1n;
const EXPONENT_MASK = 0x7ffn;
const SIGN_MASK = 1n << 63n;
const MAX_FINITE_BITS = 0x7fefffffffffffffn;
const POSITIVE_INFINITY_BITS = 0x7ff0000000000000n;
const MAX_FINITE = Number.MAX_VALUE;
const OVERFLOW_MIDPOINT: Dyadic = {
  // 2^1024 - 2^970: ties round to the even, overflowing significand.
  coefficient: (1n << 54n) - 1n,
  exponent: 970,
};

const bitsBuffer = new ArrayBuffer(8);
const bitsView = new DataView(bitsBuffer);

function bitsOf(value: number): bigint {
  bitsView.setFloat64(0, value, false);
  return bitsView.getBigUint64(0, false);
}

function numberOf(bits: bigint): number {
  bitsView.setBigUint64(0, bits, false);
  return bitsView.getFloat64(0, false);
}

function decodeFinite(value: number): Dyadic {
  const bits = bitsOf(value);
  const exponentBits = Number((bits >> FRACTION_BITS) & EXPONENT_MASK);
  if (exponentBits === 0x7ff) throw new RangeError('expected finite binary64');
  const fraction = bits & FRACTION_MASK;
  if (fraction === 0n && exponentBits === 0) return { coefficient: 0n, exponent: 0 };
  const magnitude = exponentBits === 0 ? fraction : (1n << FRACTION_BITS) | fraction;
  return {
    coefficient: (bits & SIGN_MASK) === 0n ? magnitude : -magnitude,
    exponent: exponentBits === 0 ? -1074 : exponentBits - 1023 - 52,
  };
}

function add(left: Dyadic, right: Dyadic): Dyadic {
  const exponent = Math.min(left.exponent, right.exponent);
  return {
    coefficient:
      (left.coefficient << BigInt(left.exponent - exponent)) +
      (right.coefficient << BigInt(right.exponent - exponent)),
    exponent,
  };
}

function negate(value: Dyadic): Dyadic {
  return { coefficient: -value.coefficient, exponent: value.exponent };
}

function multiplyInteger(value: Dyadic, multiplier: bigint): Dyadic {
  return { coefficient: value.coefficient * multiplier, exponent: value.exponent };
}

function compare(left: Dyadic, right: Dyadic): -1 | 0 | 1 {
  const exponent = Math.min(left.exponent, right.exponent);
  const a = left.coefficient << BigInt(left.exponent - exponent);
  const b = right.coefficient << BigInt(right.exponent - exponent);
  return a < b ? -1 : a > b ? 1 : 0;
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

function roundedInteger(coefficient: bigint, shift: number): bigint {
  if (shift >= 0) return coefficient << BigInt(shift);
  const discardedBits = -shift;
  const divisorShift = BigInt(discardedBits);
  let quotient = coefficient >> divisorShift;
  const remainder = coefficient - (quotient << divisorShift);
  const halfway = 1n << BigInt(discardedBits - 1);
  if (remainder > halfway || (remainder === halfway && (quotient & 1n) === 1n)) {
    quotient++;
  }
  return quotient;
}

/** Correctly rounds an exact dyadic to binary64, ties to even. */
function roundToBinary64(value: Dyadic): number {
  if (value.coefficient === 0n) return 0;
  const negative = value.coefficient < 0n;
  const coefficient = negative ? -value.coefficient : value.coefficient;
  const magnitude = { coefficient, exponent: value.exponent } satisfies Dyadic;
  if (compare(magnitude, OVERFLOW_MIDPOINT) >= 0) {
    return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  let binaryExponent = bitLength(coefficient) - 1 + value.exponent;
  const quantumExponent = binaryExponent < -1022 ? -1074 : binaryExponent - 52;
  let significand = roundedInteger(coefficient, value.exponent - quantumExponent);
  let magnitudeBits: bigint;

  if (quantumExponent === -1074 && significand <= 1n << FRACTION_BITS) {
    magnitudeBits = significand;
  } else {
    if (significand === 1n << 53n) {
      significand >>= 1n;
      binaryExponent++;
    }
    if (binaryExponent > 1023) {
      magnitudeBits = POSITIVE_INFINITY_BITS;
    } else {
      magnitudeBits =
        (BigInt(binaryExponent + 1023) << FRACTION_BITS) |
        (significand - (1n << FRACTION_BITS));
    }
  }
  return numberOf((negative ? SIGN_MASK : 0n) | magnitudeBits);
}

function floorPositiveToBinary64(value: Dyadic): number {
  if (value.coefficient <= 0n) return 0;
  const binaryExponent = bitLength(value.coefficient) - 1 + value.exponent;
  if (binaryExponent > 1023) return MAX_FINITE;
  if (binaryExponent < -1074) return 0;
  const quantumExponent = binaryExponent < -1022 ? -1074 : binaryExponent - 52;
  const shift = value.exponent - quantumExponent;
  const significand = shift >= 0
    ? value.coefficient << BigInt(shift)
    : value.coefficient >> BigInt(-shift);
  if (quantumExponent === -1074) return numberOf(significand);
  const bits =
    (BigInt(binaryExponent + 1023) << FRACTION_BITS) |
    (significand - (1n << FRACTION_BITS));
  return numberOf(bits > MAX_FINITE_BITS ? MAX_FINITE_BITS : bits);
}

function nextUp(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (Object.is(value, -0) || value === 0) return Number.MIN_VALUE;
  const bits = bitsOf(value);
  return numberOf(value > 0 ? bits + 1n : bits - 1n);
}

function upperRoundingCell(value: number): readonly [edge: Dyadic, inclusive: boolean] {
  if (value === MAX_FINITE) return [OVERFLOW_MIDPOINT, false];
  const edge = add(decodeFinite(value), decodeFinite(nextUp(value)));
  return [
    { coefficient: edge.coefficient, exponent: edge.exponent - 1 },
    (bitsOf(value) & 1n) === 0n,
  ];
}

function greatestFloatAtBound(bound: Dyadic, inclusive: boolean): number {
  let result = floorPositiveToBinary64(bound);
  if (!inclusive && compare(decodeFinite(result), bound) === 0 && result > 0) {
    result = numberOf(bitsOf(result) - 1n);
  }
  return result;
}

function floorRatio(numerator: Dyadic, denominator: Dyadic): bigint {
  const exponentShift = numerator.exponent - denominator.exponent;
  if (exponentShift >= 0) {
    return (numerator.coefficient << BigInt(exponentShift)) / denominator.coefficient;
  }
  return numerator.coefficient /
    (denominator.coefficient << BigInt(-exponentShift));
}

/** Каноническая absolute boundary: RN64(RN64(index * cycle) + start). */
export function motionProgramInfiniteBoundaryV1(
  startMs: number,
  cycleMs: number,
  iteration: bigint,
): number {
  if (!Number.isFinite(startMs) || !(cycleMs > 0) || !Number.isFinite(cycleMs) || iteration < 0n) {
    throw new RangeError('invalid infinite schedule boundary');
  }
  const product = roundToBinary64(multiplyInteger(decodeFinite(cycleMs), iteration));
  if (!Number.isFinite(product)) return product;
  return roundToBinary64(add(decodeFinite(product), decodeFinite(startMs)));
}

/**
 * Возвращает greatest index с absolute boundary <= sample.
 *
 * Два upper-cell шага точно инвертируют две RN64 операции boundary. Индекс
 * остаётся BigInt, поэтому parity не зависит от unsafe Number quotient.
 */
export function motionProgramInfiniteBoundaryAtOrBeforeV1(
  startMs: number,
  cycleMs: number,
  timeMs: number,
): MotionProgramInfiniteBoundaryV1 {
  if (
    !Number.isFinite(startMs) ||
    !(cycleMs > 0) ||
    !Number.isFinite(cycleMs) ||
    !Number.isFinite(timeMs) ||
    timeMs < startMs
  ) {
    throw new RangeError('invalid infinite schedule sample');
  }

  const [outerEdge, outerInclusive] = upperRoundingCell(timeMs);
  const productBound = add(outerEdge, negate(decodeFinite(startMs)));
  const productMax = greatestFloatAtBound(productBound, outerInclusive);
  const [innerEdge, innerInclusive] = upperRoundingCell(productMax);
  const cycle = decodeFinite(cycleMs);
  let iteration = floorRatio(innerEdge, cycle);
  if (
    !innerInclusive &&
    compare(multiplyInteger(cycle, iteration), innerEdge) === 0
  ) {
    iteration--;
  }
  if (iteration < 0n) iteration = 0n;
  return Object.freeze({
    iteration,
    boundaryMs: motionProgramInfiniteBoundaryV1(startMs, cycleMs, iteration),
  });
}
