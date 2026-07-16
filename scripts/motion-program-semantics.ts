/**
 * Исполнимый reference MotionProgram V1 для портов и conformance.
 *
 * Он намеренно находится вне runtime entries: браузерный исполнитель получает
 * уже скомпилированные samples, а этот модуль формулирует математику независимо
 * от DOM/WAAPI и ловит расхождение будущих Swift/Kotlin реализаций.
 */

import {
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  MotionProgramParseError,
  motionProgramIterationBoundaryV1,
  type MotionProgramCodecV1,
  type MotionProgramCurveV1,
  type MotionProgramEncodedValueV1,
  type MotionProgramSegmentV1,
  type MotionProgramStandardChannelV1,
  type MotionProgramTrackV1,
  type MotionProgramValueExprV1,
  type MotionProgramV1,
} from '../src/internal/motion-program.js';
import {
  motionProgramInfiniteBoundaryAtOrBeforeV1,
  motionProgramInfiniteBoundaryV1,
} from './motion-program-dyadic.js';

function semanticFailure(
  code: 'LMP_NUMBER' | 'LMP_CODEC' | 'LMP_FEATURE' | 'LMP_SHAPE' | 'LMP_BOUNDS' | 'LMP_CANONICAL',
): never {
  throw new MotionProgramParseError(code);
}

function requireFinite(value: number): number {
  if (!Number.isFinite(value)) semanticFailure('LMP_NUMBER');
  return value;
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * Взвешенная форма не переполняет противоположные MAX-границы. Endpoint и
 * static-span возвращаются точно; непредставимый overshoot снапается к `to` —
 * тот же effect-space контракт, что использует нынешний animate/channelAt.
 */
function affine(from: number, to: number, progress: number): number {
  if (progress === 1) return to;
  if (progress === 0 || from === to) return from;
  const value = (1 - progress) * from + progress * to;
  return Number.isFinite(value) ? value : to;
}

/** Порядок операций совпадает с текущим `value/color`, включая IEEE-rounding. */
function colorLerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * Piecewise-linear evaluator. Повторные offsets образуют вертикальный скачок:
 * слева берётся первая запись границы, точно на ней — последняя (right-continuous).
 */
export function evaluateMotionProgramCurveV1(
  curve: MotionProgramCurveV1,
  inputProgress: number,
): number {
  const progress = clamp01(requireFinite(inputProgress));
  if (curve === 0) return progress;

  let left = 1;
  for (let right = 3; right < curve.length; right += 2) {
    const rightOffset = curve[right]!;
    if (progress < rightOffset) {
      const leftOffset = curve[left]!;
      const local = (progress - leftOffset) / (rightOffset - leftOffset);
      return affine(curve[left + 1]!, curve[right + 1]!, local);
    }
    left = right;
  }
  return curve[curve.length - 1]!;
}

function requireScalar(value: MotionProgramEncodedValueV1): number {
  if (value[0] !== 0) semanticFailure('LMP_CODEC');
  return value[1];
}

type ColorVector = readonly [vector: 1, c0: number, c1: number, c2: number, alpha: number];

function requireColor(value: MotionProgramEncodedValueV1): ColorVector {
  if (value[0] !== 1 || value.length !== 5) semanticFailure('LMP_CODEC');
  return value as ColorVector;
}

function requireToken(value: MotionProgramEncodedValueV1): number {
  if (value[0] !== 2) semanticFailure('LMP_CODEC');
  return value[1];
}

function normalizeHue(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Интерполяция codec уже после разрешения current/relative frame expressions. */
export function interpolateMotionProgramValueV1(
  codec: MotionProgramCodecV1,
  fromValue: MotionProgramEncodedValueV1,
  toValue: MotionProgramEncodedValueV1,
  inputProgress: number,
): MotionProgramEncodedValueV1 {
  const rawProgress = requireFinite(inputProgress);
  if (codec === MOTION_PROGRAM_CODEC_V1.scalar) {
    return Object.freeze([
      0,
      affine(requireScalar(fromValue), requireScalar(toValue), rawProgress),
    ] as const);
  }
  if (codec === MOTION_PROGRAM_CODEC_V1.discrete) {
    const token = rawProgress < 0.5 ? requireToken(fromValue) : requireToken(toValue);
    return Object.freeze([2, token] as const);
  }
  if (codec === MOTION_PROGRAM_CODEC_V1.webCssOpaque) {
    // Opaque означает именно отсутствие переносимого ответа, а не скрытый
    // midpoint fallback. Исполнитель обязан передать пару зарегистрированному host.
    semanticFailure('LMP_FEATURE');
  }

  const from = requireColor(fromValue);
  const to = requireColor(toValue);
  const progress = clamp01(rawProgress);
  if (codec === MOTION_PROGRAM_CODEC_V1.colorHslShortest) {
    let hueDelta = to[1] - from[1];
    if (hueDelta > 180) hueDelta -= 360;
    if (hueDelta < -180) hueDelta += 360;
    return Object.freeze([
      1,
      normalizeHue(from[1] + hueDelta * progress),
      clamp01(colorLerp(from[2], to[2], progress)),
      clamp01(colorLerp(from[3], to[3], progress)),
      clamp01(colorLerp(from[4], to[4], progress)),
    ] as const);
  }
  if (codec !== MOTION_PROGRAM_CODEC_V1.colorGamma2 && codec !== MOTION_PROGRAM_CODEC_V1.colorSrgb) {
    semanticFailure('LMP_CODEC');
  }

  const mix = codec === MOTION_PROGRAM_CODEC_V1.colorGamma2
    ? (fromChannel: number, toChannel: number): number =>
      Math.sqrt(fromChannel * fromChannel * (1 - progress) + toChannel * toChannel * progress)
    : (fromChannel: number, toChannel: number): number =>
      colorLerp(fromChannel, toChannel, progress);
  return Object.freeze([
    1,
    Math.max(0, Math.min(255, mix(from[1], to[1]))),
    Math.max(0, Math.min(255, mix(from[2], to[2]))),
    Math.max(0, Math.min(255, mix(from[3], to[3]))),
    clamp01(colorLerp(from[4], to[4], progress)),
  ] as const);
}

export type MotionProgramResolvedSegmentV1 = readonly [
  from: MotionProgramEncodedValueV1,
  to: MotionProgramEncodedValueV1,
];

function copyEncodedValue(value: MotionProgramEncodedValueV1): MotionProgramEncodedValueV1 {
  let length: number;
  try {
    if (!Array.isArray(value)) semanticFailure('LMP_SHAPE');
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (descriptor === undefined || !('value' in descriptor)) semanticFailure('LMP_SHAPE');
    length = descriptor.value as number;
  } catch (error) {
    if (error instanceof MotionProgramParseError) throw error;
    semanticFailure('LMP_SHAPE');
  }
  if (length !== 2 && length !== 5) semanticFailure('LMP_SHAPE');

  const snapshot = new Array<unknown>(length);
  try {
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (descriptor === undefined || !('value' in descriptor)) semanticFailure('LMP_SHAPE');
      snapshot[i] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof MotionProgramParseError) throw error;
    semanticFailure('LMP_SHAPE');
  }
  return Object.freeze(snapshot) as MotionProgramEncodedValueV1;
}

function validateRuntimeValue(
  codec: MotionProgramCodecV1,
  value: MotionProgramEncodedValueV1,
): MotionProgramEncodedValueV1 {
  if (codec === MOTION_PROGRAM_CODEC_V1.scalar) {
    requireFinite(requireScalar(value));
    return value;
  }
  if (codec === MOTION_PROGRAM_CODEC_V1.discrete) {
    const token = requireToken(value);
    if (!Number.isInteger(token) || token < 0 || token > 0xffff) semanticFailure('LMP_CODEC');
    return value;
  }
  if (codec === MOTION_PROGRAM_CODEC_V1.webCssOpaque) semanticFailure('LMP_FEATURE');
  const color = requireColor(value);
  for (let i = 1; i < color.length; i++) requireFinite(color[i]!);
  if (codec === MOTION_PROGRAM_CODEC_V1.colorHslShortest) {
    if (
      color[1] < 0 || color[1] >= 360 ||
      color[2] < 0 || color[2] > 1 ||
      color[3] < 0 || color[3] > 1 ||
      color[4] < 0 || color[4] > 1
    ) {
      semanticFailure('LMP_CODEC');
    }
    return value;
  }
  if (codec !== MOTION_PROGRAM_CODEC_V1.colorGamma2 && codec !== MOTION_PROGRAM_CODEC_V1.colorSrgb) {
    semanticFailure('LMP_CODEC');
  }
  if (
    color[1] < 0 || color[1] > 255 ||
    color[2] < 0 || color[2] > 255 ||
    color[3] < 0 || color[3] > 255 ||
    color[4] < 0 || color[4] > 1
  ) {
    semanticFailure('LMP_CODEC');
  }
  return value;
}

function resolveValueExpression(
  expression: MotionProgramValueExprV1,
  codec: MotionProgramCodecV1,
  previous: MotionProgramEncodedValueV1 | undefined,
  bindingSnapshot: MotionProgramEncodedValueV1 | undefined,
): MotionProgramEncodedValueV1 {
  if (expression[0] === 1) {
    const snapshot = copyEncodedValue(expression[1]);
    return validateRuntimeValue(codec, snapshot);
  }
  const source = previous ?? bindingSnapshot;
  if (source === undefined) semanticFailure('LMP_CODEC');
  const base = copyEncodedValue(source);
  validateRuntimeValue(codec, base);
  if (expression[0] === 0) return base;
  const magnitude = requireScalar(expression[2]);
  const resolved = requireFinite(requireScalar(base) + expression[1] * magnitude);
  return Object.freeze([0, resolved] as const);
}

/**
 * Разрешает segment endpoints в каноническом порядке до первой host-записи.
 * Переполнение relative или codec-drift останавливают bind атомарно.
 */
export function resolveMotionProgramSegmentsV1(
  segments: readonly MotionProgramSegmentV1[],
  bindingSnapshot?: MotionProgramEncodedValueV1,
): readonly MotionProgramResolvedSegmentV1[] {
  const resolved = new Array<MotionProgramResolvedSegmentV1>(segments.length);
  let previous: MotionProgramEncodedValueV1 | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const from = resolveValueExpression(segment[2], segment[5], previous, bindingSnapshot);
    const to = resolveValueExpression(segment[3], segment[5], from, bindingSnapshot);
    resolved[i] = Object.freeze([from, to] as const);
    previous = to;
  }
  return Object.freeze(resolved);
}

export type MotionProgramScheduleStateV1 =
  | 'before'
  | 'motion'
  | 'repeatDelay'
  | 'terminal'
  | 'after';

export interface MotionProgramScheduleSampleV1 {
  readonly state: MotionProgramScheduleStateV1;
  /** `null` для infinite repeat: исполнителю нужна только точная parity. */
  readonly iteration: number | null;
  readonly iterationParity: 0 | 1;
  /** Прогресс времени после normal/reverse/alternate; для mirror — forward-time. */
  readonly progress: number;
  readonly mirrored: boolean;
}

function directedProgress(
  direction: MotionProgramTrackV1[4],
  parity: 0 | 1,
  phase: number,
): readonly [progress: number, mirrored: boolean] {
  if (direction === MOTION_PROGRAM_DIRECTION_V1.normal) return [phase, false];
  if (direction === MOTION_PROGRAM_DIRECTION_V1.reverse) return [1 - phase, false];
  if (direction === MOTION_PROGRAM_DIRECTION_V1.alternate) {
    return [parity === 0 ? phase : 1 - phase, false];
  }
  if (direction === MOTION_PROGRAM_DIRECTION_V1.alternateReverse) {
    return [parity === 0 ? 1 - phase : phase, false];
  }
  return [phase, parity === 1];
}

function scheduleSample(
  state: MotionProgramScheduleStateV1,
  iteration: number | null,
  parity: 0 | 1,
  phase: number,
  direction: MotionProgramTrackV1[4],
): MotionProgramScheduleSampleV1 {
  const [progress, mirrored] = directedProgress(direction, parity, phase);
  return Object.freeze({ state, iteration, iterationParity: parity, progress, mirrored });
}

/** Эталон границ repeat/delay/zero-duration на бинарном f64-времени. */
export function evaluateMotionProgramScheduleV1(
  track: MotionProgramTrackV1,
  programTimeMs: number,
): MotionProgramScheduleSampleV1 {
  const timeMs = requireFinite(programTimeMs);
  const startMs = track[1];
  const durationMs = track[2];
  const repeat = track[3];
  const direction = track[4];
  const repeatDelayMs = track[5];
  if (timeMs < startMs) return scheduleSample('before', 0, 0, 0, direction);

  const cycleMs = durationMs + repeatDelayMs;
  if (repeat !== -1) {
    const lastStartMs = motionProgramIterationBoundaryV1(startMs, cycleMs, repeat);
    const terminalMs = lastStartMs + durationMs;
    if (timeMs >= terminalMs) {
      const parity = (repeat & 1) as 0 | 1;
      return scheduleSample(timeMs === terminalMs ? 'terminal' : 'after', repeat, parity, 1, direction);
    }
    // repeat <= int32: 31 шага находят greatest absolute boundary <= sample,
    // не используя нестабильное вычитание start и quotient.
    let low = 0;
    let high = repeat;
    while (low < high) {
      const middle = low + Math.ceil((high - low) / 2);
      if (motionProgramIterationBoundaryV1(startMs, cycleMs, middle) <= timeMs) low = middle;
      else high = middle - 1;
    }
    const iteration = low;
    const parity = (iteration & 1) as 0 | 1;
    const iterationStartMs = motionProgramIterationBoundaryV1(startMs, cycleMs, iteration);
    const motionEndMs = repeatDelayMs === 0 && iteration < repeat
      ? motionProgramIterationBoundaryV1(startMs, cycleMs, iteration + 1)
      : iterationStartMs + durationMs;
    if (durationMs > 0 && timeMs < motionEndMs) {
      const progress = (timeMs - iterationStartMs) / (motionEndMs - iterationStartMs);
      return scheduleSample(
        'motion',
        iteration,
        parity,
        Math.min(progress, 1 - Number.EPSILON / 2),
        direction,
      );
    }
    return scheduleSample('repeatDelay', iteration, parity, 1, direction);
  }

  const infinite = motionProgramInfiniteBoundaryAtOrBeforeV1(startMs, cycleMs, timeMs);
  const parity = Number(infinite.iteration & 1n) as 0 | 1;
  const motionEndMs = repeatDelayMs === 0
    ? motionProgramInfiniteBoundaryV1(startMs, cycleMs, infinite.iteration + 1n)
    : infinite.boundaryMs + durationMs;
  if (durationMs > 0 && timeMs < motionEndMs) {
    const progress = (timeMs - infinite.boundaryMs) / (motionEndMs - infinite.boundaryMs);
    return scheduleSample(
      'motion',
      null,
      parity,
      Math.min(progress, 1 - Number.EPSILON / 2),
      direction,
    );
  }
  return scheduleSample('repeatDelay', null, parity, 1, direction);
}

/**
 * Исполняет уже разрешённые segments. Mirror разворачивает их порядок,
 * отражает interval, меняет from/to и оставляет исходную curve forward.
 */
export function evaluateMotionProgramSegmentsV1(
  segments: readonly MotionProgramSegmentV1[],
  resolved: readonly MotionProgramResolvedSegmentV1[],
  curves: readonly MotionProgramCurveV1[],
  schedule: MotionProgramScheduleSampleV1,
): MotionProgramEncodedValueV1 {
  if (segments.length !== resolved.length || segments.length === 0) semanticFailure('LMP_CODEC');
  const progress = clamp01(requireFinite(schedule.progress));
  if (!schedule.mirrored) {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (progress < segment[1] || i === segments.length - 1) {
        const local = (progress - segment[0]) / (segment[1] - segment[0]);
        const curved = evaluateMotionProgramCurveV1(curves[segment[4]]!, local);
        return interpolateMotionProgramValueV1(
          segment[5],
          resolved[i]![0],
          resolved[i]![1],
          curved,
        );
      }
    }
  } else {
    const sourceProgress = 1 - progress;
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]!;
      if (sourceProgress > segment[0] || i === 0) {
        const local = (segment[1] - sourceProgress) / (segment[1] - segment[0]);
        const curved = evaluateMotionProgramCurveV1(curves[segment[4]]!, local);
        return interpolateMotionProgramValueV1(
          segment[5],
          resolved[i]![1],
          resolved[i]![0],
          curved,
        );
      }
    }
  }
  semanticFailure('LMP_CODEC');
}

/** Inactive delayed track не сбрасывает другие каналы одного batched surface. */
export function presentMotionProgramTrackValueV1(
  segments: readonly MotionProgramSegmentV1[],
  resolved: readonly MotionProgramResolvedSegmentV1[],
  curves: readonly MotionProgramCurveV1[],
  schedule: MotionProgramScheduleSampleV1,
  bindingBaseline: MotionProgramEncodedValueV1,
): MotionProgramEncodedValueV1 {
  const baselineCodec = segments[0]?.[5];
  if (baselineCodec === undefined) semanticFailure('LMP_CODEC');
  if (schedule.state === 'before') {
    const snapshot = copyEncodedValue(bindingBaseline);
    return validateRuntimeValue(baselineCodec, snapshot);
  }
  return evaluateMotionProgramSegmentsV1(segments, resolved, curves, schedule);
}

/** Web-format oracle: native renderer использует те же компоненты без строковой квантизации. */
export function formatMotionProgramColorV1(
  codec: MotionProgramCodecV1,
  value: MotionProgramEncodedValueV1,
): string {
  const color = requireColor(value);
  if (codec === MOTION_PROGRAM_CODEC_V1.colorHslShortest) {
    const h = +normalizeHue(color[1]).toFixed(4);
    const s = +(clamp01(color[2]) * 100).toFixed(4);
    const l = +(clamp01(color[3]) * 100).toFixed(4);
    const a = clamp01(color[4]);
    return a >= 1
      ? `hsl(${h}, ${s}%, ${l}%)`
      : `hsla(${h}, ${s}%, ${l}%, ${+a.toFixed(4)})`;
  }
  if (codec !== MOTION_PROGRAM_CODEC_V1.colorGamma2 && codec !== MOTION_PROGRAM_CODEC_V1.colorSrgb) {
    semanticFailure('LMP_CODEC');
  }
  const r = Math.round(Math.max(0, Math.min(255, color[1])));
  const g = Math.round(Math.max(0, Math.min(255, color[2])));
  const b = Math.round(Math.max(0, Math.min(255, color[3])));
  const a = clamp01(color[4]);
  return a >= 1
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(4)})`;
}

/** Presentation clamp не меняет сохранённое effect-state и его velocity. */
export function presentMotionProgramScalarV1(
  channel: MotionProgramStandardChannelV1,
  value: number,
): number {
  requireFinite(value);
  return channel === MOTION_PROGRAM_STANDARD_CHANNEL_V1.opacity ? clamp01(value) : value;
}

export interface MotionProgramTransform2DV1 {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotate: number;
  readonly skewX: number;
  readonly skewY: number;
}

/** CSS `matrix(a,b,c,d,tx,ty)` layout; point — column vector. */
export type MotionProgramMatrix2DV1 = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
];

function principalDegrees(degrees: number, period: 180 | 360): number {
  const half = period / 2;
  if (degrees >= -half && degrees < half) return degrees;
  let reduced = degrees % period;
  if (reduced >= half) reduced -= period;
  else if (reduced < -half) reduced += period;
  return reduced;
}

function saturatedMultiply(left: number, right: number): number {
  const product = left * right;
  if (Number.isFinite(product)) return product;
  const leftNegative = left < 0 || Object.is(left, -0);
  const rightNegative = right < 0 || Object.is(right, -0);
  return leftNegative !== rightNegative ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

/**
 * Эталон текущей Web-композиции: `T·S·R·K`, где `K` — одна CSS
 * `skew(ax, ay)`, а не две последовательные skew-матрицы.
 */
export function composeMotionProgramTransform2DV1(
  state: MotionProgramTransform2DV1,
): MotionProgramMatrix2DV1 {
  const x = requireFinite(state.translateX);
  const y = requireFinite(state.translateY);
  const sx = requireFinite(state.scaleX);
  const sy = requireFinite(state.scaleY);
  const radians = principalDegrees(requireFinite(state.rotate), 360) * Math.PI / 180;
  const skewXRadians = principalDegrees(requireFinite(state.skewX), 180) * Math.PI / 180;
  const skewYRadians = principalDegrees(requireFinite(state.skewY), 180) * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const tanX = Math.tan(skewXRadians);
  const tanY = Math.tan(skewYRadians);
  return Object.freeze([
    saturatedMultiply(sx, cos - sin * tanY),
    saturatedMultiply(sy, sin + cos * tanY),
    saturatedMultiply(sx, cos * tanX - sin),
    saturatedMultiply(sy, sin * tanX + cos),
    x,
    y,
  ] as const);
}

/** Native portable executor вызывает этот gate до захвата subject/resource. */
export function assertPortableMotionProgramV1(program: MotionProgramV1): MotionProgramV1 {
  if ((program[1] & MOTION_PROGRAM_FEATURE_V1.hostExtensions) !== 0) {
    semanticFailure('LMP_FEATURE');
  }
  return program;
}

/**
 * Slot-level one-writer proof закрывается до host bind: два разных slot не
 * могут указывать на тот же физический subject. Host обязан использовать
 * возвращённый frozen snapshot, иначе проверка и capture образуют TOCTOU.
 */
export function snapshotInjectiveMotionProgramSubjectsV1(
  program: MotionProgramV1,
  subjects: readonly unknown[],
): readonly unknown[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(subjects);
  } catch {
    semanticFailure('LMP_SHAPE');
  }
  if (!isArray) semanticFailure('LMP_SHAPE');
  const usedSlots = new Set<number>();
  for (const binding of program[4]) usedSlots.add(binding[0]);
  const identities = new WeakSet<object>();
  const snapshot: unknown[] = [];
  for (const slot of usedSlots) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(subjects, String(slot));
    } catch {
      semanticFailure('LMP_SHAPE');
    }
    if (descriptor === undefined || !('value' in descriptor)) semanticFailure('LMP_BOUNDS');
    const subject = descriptor.value;
    if ((typeof subject !== 'object' || subject === null) && typeof subject !== 'function') {
      semanticFailure('LMP_SHAPE');
    }
    const identity = subject as object;
    if (identities.has(identity)) semanticFailure('LMP_CANONICAL');
    identities.add(identity);
    snapshot[slot] = subject;
  }
  return Object.freeze(snapshot);
}
