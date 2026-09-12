/** Конечные бюджеты сценария S5; они не задают погрешность часов или общую плавность. */
export const S5_MOTION_CONTRACT = Object.freeze({
  id: 's5-motion-v1',
  distancePx: 600,
  durationMs: 2400,
  positionTolerancePx: 3,
  timeToleranceMs: 20,
  maxObservationGapMs: 50,
  spring: Object.freeze({ stiffness: 40, damping: 8, mass: 1 }),
});

/** @typedef {'linear' | 'spring'} MotionModel */
/** @typedef {{ t: number, x: number }} Observation */
/**
 * @typedef {object} Conformance
 * @property {'pass' | 'fail' | 'inconclusive'} verdict
 * @property {string} reason
 * @property {number | null} maxErrorPx Максимальное отклонение от значения в момент t.
 * @property {number | null} maxGapMs Включает ненаблюдаемое начало и конец окна.
 * @property {number} samples Число валидных наблюдений внутри окна; при порче записи — 0.
 */

const durationSeconds = S5_MOTION_CONTRACT.durationMs / 1000;
const springFrequency = Math.sqrt(24);

/** @param {number} t @param {MotionModel} model */
function expectedPosition(t, model) {
  if (t <= 0) return 0;
  if (model === 'linear') {
    return S5_MOTION_CONTRACT.distancePx * Math.min(1, t / durationSeconds);
  }
  // Независимое решение x'' + 8x' + 40(x - 600) = 0, x(0) = x'(0) = 0.
  return 600 * (1 - Math.exp(-4 * t) * (
    Math.cos(springFrequency * t) + 4 / springFrequency * Math.sin(springFrequency * t)
  ));
}

/** @param {number} t @param {MotionModel} model @param {number} timeToleranceSeconds */
function positionEnvelope(t, model, timeToleranceSeconds) {
  const from = Math.max(0, t - timeToleranceSeconds);
  const to = t + timeToleranceSeconds;
  const values = [expectedPosition(from, model), expectedPosition(to, model)];
  if (model === 'spring') {
    // На немонотонном участке границ интервала недостаточно: x' = 0 при nπ/√24.
    const first = Math.ceil(from * springFrequency / Math.PI);
    const last = Math.floor(to * springFrequency / Math.PI);
    for (let n = first; n <= last; n++) {
      values.push(expectedPosition(n * Math.PI / springFrequency, model));
    }
  }
  return {
    min: Math.min(...values) - S5_MOTION_CONTRACT.positionTolerancePx,
    max: Math.max(...values) + S5_MOTION_CONTRACT.positionTolerancePx,
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} reason @returns {Conformance} */
function invalidCapture(reason) {
  return { verdict: 'inconclusive', reason, maxErrorPx: null, maxGapMs: null, samples: 0 };
}

/**
 * Проверяет только записанные положения в [0, 2.4] с. Между точками ничего не достраивается.
 * Точки вне окна не закрывают покрытие. PASS ограничен этой сеткой наблюдений и бюджетами S5.
 * @param {unknown} points
 * @param {MotionModel} model
 * @param {number} [timeUncertaintyMs] Измеренная неопределённость расходует, а не расширяет бюджет.
 * @returns {Conformance}
 */
export function evaluateTrajectoryConformance(points, model, timeUncertaintyMs = 0) {
  if (model !== 'linear' && model !== 'spring') {
    throw new TypeError(`Unsupported S5 motion model: ${String(model)}`);
  }
  if (!Number.isFinite(timeUncertaintyMs) || timeUncertaintyMs < 0 ||
    timeUncertaintyMs > S5_MOTION_CONTRACT.timeToleranceMs) {
    return invalidCapture('clock-uncertainty-exceeds-contract');
  }
  const timeToleranceSeconds = (S5_MOTION_CONTRACT.timeToleranceMs - timeUncertaintyMs) / 1000;
  if (!Array.isArray(points)) return invalidCapture('observations-not-array');

  /** @type {Observation[]} */
  const observations = [];
  let previousTime = -Infinity;
  // Сначала проверяется вся запись: даже порча вне окна подрывает доверие к захвату.
  for (const point of points) {
    if (!isRecord(point) || typeof point.t !== 'number' || typeof point.x !== 'number'
      || !Number.isFinite(point.t) || !Number.isFinite(point.x)) {
      return invalidCapture('nonfinite-observation');
    }
    if (point.t <= previousTime) return invalidCapture('nonincreasing-observation-time');
    previousTime = point.t;
    if (point.t >= 0 && point.t <= durationSeconds) observations.push({ t: point.t, x: point.x });
  }

  if (observations.length === 0) {
    return {
      verdict: 'inconclusive', reason: 'no-observations-in-window',
      maxErrorPx: null, maxGapMs: S5_MOTION_CONTRACT.durationMs, samples: 0,
    };
  }

  let maxErrorPx = 0;
  let maxGapMs = 0;
  let previousObservedTime = 0;
  let violation = false;
  for (const point of observations) {
    const expected = expectedPosition(point.t, model);
    const envelope = positionEnvelope(point.t, model, timeToleranceSeconds);
    maxErrorPx = Math.max(maxErrorPx, Math.abs(point.x - expected));
    maxGapMs = Math.max(maxGapMs, (point.t - previousObservedTime) * 1000);
    previousObservedTime = point.t;
    // Только округление IEEE-754 при вычислении границ, а не дополнительный бюджет S5.
    const roundingPx = 32 * Number.EPSILON * Math.max(
      S5_MOTION_CONTRACT.distancePx, Math.abs(envelope.min), Math.abs(envelope.max),
    );
    if (point.x < envelope.min - roundingPx || point.x > envelope.max + roundingPx) {
      violation = true;
    }
  }
  maxGapMs = Math.max(maxGapMs, (durationSeconds - previousObservedTime) * 1000);
  const evidence = { maxErrorPx, maxGapMs, samples: observations.length };
  if (violation) return { verdict: 'fail', reason: 'position-outside-contract', ...evidence };

  const roundingMs = 32 * Number.EPSILON * S5_MOTION_CONTRACT.durationMs;
  if (maxGapMs > S5_MOTION_CONTRACT.maxObservationGapMs + roundingMs) {
    return { verdict: 'inconclusive', reason: 'observation-gap-exceeds-contract', ...evidence };
  }
  return { verdict: 'pass', reason: 'within-s5-motion-contract', ...evidence };
}

/** @param {string} id @param {unknown} run @param {{baseline: number, blocked: number}} [uncertainty] */
export function evaluateFreezeConformance(id, run, uncertainty = { baseline: 0, blocked: 0 }) {
  /** @type {MotionModel} */
  let model;
  switch (id) {
    case 'lab-spring':
      model = 'spring';
      break;
    case 'lab':
    case 'motion':
    case 'gsap':
    case 'anime':
    case 'waapi-ctl':
    case 'motion-mini':
    case 'anime-waapi':
      model = 'linear';
      break;
    default:
      throw new TypeError(`Unsupported S5 participant: ${String(id)}`);
  }
  const evidence = isRecord(run) && isRecord(run.evidence) ? run.evidence : {};
  return {
    baseline: evaluateTrajectoryConformance(evidence.baseline, model, uncertainty.baseline),
    blocked: evaluateTrajectoryConformance(evidence.blocked, model, uncertainty.blocked),
  };
}
