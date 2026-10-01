/** Общие детерминированные швы Node-бенчмарков. */

export function createBenchClock() {
  let queue = [];
  let requests = 0;
  let executions = 0;
  return {
    requestFrame(cb) {
      requests++;
      queue.push(cb);
      return requests;
    },
    step(ts) {
      const current = queue;
      queue = [];
      for (const cb of current) {
        executions++;
        cb(ts);
      }
    },
    get requests() { return requests; },
    get executions() { return executions; },
  };
}

/** Низкодисперсная interior-последовательность без попаданий в 1000-stop grid. */
export function interiorUnit(index) {
  const fractional = (index * 0.6180339887498949) % 1;
  return 1e-9 + fractional * (1 - 2e-9);
}

/** Внутренние входы: одно начальное число воспроизводит тот же горячий путь. */
export function createSeededUnitInputs(count, seed) {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('benchmark inputs: count должен быть положительным целым');
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error('benchmark inputs: seed должен быть безопасным целым');
  }
  const values = new Float64Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values[i] = (state + 0.5) / 0x1_0000_0000;
  }
  return values;
}

/** Квантили ближайшего ранга без мутации массива исходных замеров. */
export function summarizeDistribution(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('benchmark distribution: нужны конечные числовые сэмплы');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return { p50: rank(0.5), p95: rank(0.95), p99: rank(0.99) };
}

const MASS_COUNTS = Object.freeze([1, 100, 1_000]);
const MASS_SPRING = Object.freeze({ mass: 1, stiffness: 170, damping: 10 });

/** Один контракт workload для теста, runner и raw evidence. */
export const MASS_LIFECYCLE_PROFILE = Object.freeze({
  counts: MASS_COUNTS,
  frames: 60,
  frameStepMs: 1_000 / 60,
  fromPx: 0,
  toPx: 240,
  tweenDurationMs: 1_000_000,
  spring: MASS_SPRING,
});

const MASS_GOLDEN_FRAMES = Object.freeze([0, 1, 15, 30, 59]);
const MASS_GOLDEN_TWEEN = Object.freeze([0, 0.004, 0.06, 0.12, 0.236]);
const MASS_GOLDEN_SPRING = Object.freeze([
  0,
  5.3437036392972725,
  304.4351941052021,
  223.0957079426227,
  239.16918037485095,
]);

/** Golden вычислен независимо из fixed linear и underdamped closed form. */
export const MASS_LIFECYCLE_GOLDEN = Object.freeze({
  frames: MASS_GOLDEN_FRAMES,
  tween: MASS_GOLDEN_TWEEN,
  spring: MASS_GOLDEN_SPRING,
  tolerance: 1e-9,
});

/** Независимый oracle: linear и underdamped closed form, без candidate solver. */
export function expectedMassValue(motion, frame) {
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= MASS_LIFECYCLE_PROFILE.frames) {
    throw new Error('mass oracle: frame вне профиля');
  }
  const timeMs = frame * MASS_LIFECYCLE_PROFILE.frameStepMs;
  const range = MASS_LIFECYCLE_PROFILE.toPx - MASS_LIFECYCLE_PROFILE.fromPx;
  if (motion === 'tween') {
    return MASS_LIFECYCLE_PROFILE.fromPx +
      range * (timeMs / MASS_LIFECYCLE_PROFILE.tweenDurationMs);
  }
  if (motion !== 'spring') throw new Error('mass oracle: motion должен быть tween|spring');
  const spring = MASS_LIFECYCLE_PROFILE.spring;
  const alpha = spring.damping / (2 * spring.mass);
  const omegaSquared = spring.stiffness / spring.mass;
  const dampedSquared = omegaSquared - alpha * alpha;
  if (!(dampedSquared > 0)) throw new Error('mass oracle: профиль обязан быть underdamped');
  const damped = Math.sqrt(dampedSquared);
  const timeSeconds = timeMs / 1_000;
  const progress = 1 - Math.exp(-alpha * timeSeconds) * (
    Math.cos(damped * timeSeconds) +
    (alpha / damped) * Math.sin(damped * timeSeconds)
  );
  return MASS_LIFECYCLE_PROFILE.fromPx + range * progress;
}

/** Targets хранят полный preallocated trace: JIT не может выкинуть style-write как no-op. */
export function createMassTargetHarness(count) {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('mass targets: count должен быть положительным целым');
  }
  const slots = Array.from({ length: count }, () => ({
    writes: 0,
    lastProperty: '',
    lastValue: '',
    properties: new Array(MASS_LIFECYCLE_PROFILE.frames),
    values: new Array(MASS_LIFECYCLE_PROFILE.frames),
    writesPerFrame: new Uint8Array(MASS_LIFECYCLE_PROFILE.frames),
  }));
  const state = { frame: -1 };
  const targets = slots.map((slot) => ({
    style: {
      getPropertyValue(name) {
        return name === slot.lastProperty ? slot.lastValue : '';
      },
      setProperty(name, value) {
        slot.writes++;
        slot.lastProperty = name;
        slot.lastValue = value;
        const frame = state.frame;
        if (frame >= 0 && frame < MASS_LIFECYCLE_PROFILE.frames) {
          slot.properties[frame] = name;
          slot.values[frame] = value;
          slot.writesPerFrame[frame]++;
        }
      },
    },
  }));
  return {
    targets,
    slots,
    setFrame(frame) { state.frame = frame; },
  };
}

function hashText(hash, value) {
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= 0xff;
  return Math.imul(hash, 0x01000193) >>> 0;
}

function numericTransform(value) {
  if (value === 'none') return 0;
  if (typeof value !== 'string' || !value.startsWith('translateX(') || !value.endsWith('px)')) {
    return NaN;
  }
  return Number(value.slice(11, -3));
}

/** Fail-closed: один пропущенный/неверный кадр любого target инвалидирует sample. */
export function summarizeMassTargetEvidence(slots, expectedWrites, motion) {
  if (!Array.isArray(slots) || slots.length === 0 || !Number.isSafeInteger(expectedWrites) || expectedWrites <= 0) {
    throw new Error('mass evidence: невалидные slots/expectedWrites');
  }
  const golden = MASS_LIFECYCLE_GOLDEN[motion];
  if (!Array.isArray(golden)) throw new Error('mass evidence: motion должен быть tween|spring');
  let hash = 0x811c9dc5;
  let totalWrites = 0;
  const writes = new Array(slots.length);
  const traceHashes = new Array(slots.length);
  const checkpoints = new Array(slots.length);
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot?.writes !== expectedWrites) {
      throw new Error(`mass evidence: target ${index + 1} writes=${String(slot?.writes)}, ожидалось ${expectedWrites}`);
    }
    if (slot.lastProperty !== 'transform' || typeof slot.lastValue !== 'string' || slot.lastValue.length === 0) {
      throw new Error(`mass evidence: target ${index + 1} не содержит terminal transform`);
    }
    let traceHash = 0x811c9dc5;
    const numericTrace = new Array(expectedWrites);
    for (let frame = 0; frame < expectedWrites; frame++) {
      if (slot.writesPerFrame[frame] !== 1) {
        throw new Error(`mass evidence: target ${index + 1} frame ${frame} writes=${slot.writesPerFrame[frame]}`);
      }
      const property = slot.properties[frame];
      const value = slot.values[frame];
      if (property !== 'transform' || typeof value !== 'string') {
        throw new Error(`mass evidence: target ${index + 1} frame ${frame} не содержит transform`);
      }
      traceHash = hashText(traceHash, `${property}:${value}`);
      const numeric = numericTransform(value);
      const expected = expectedMassValue(motion, frame);
      if (
        !Number.isFinite(numeric) ||
        Math.abs(numeric - expected) > MASS_LIFECYCLE_GOLDEN.tolerance
      ) {
        throw new Error(
          `mass evidence: target ${index + 1} frame ${frame}=${String(numeric)}, ожидалось ${expected}`,
        );
      }
      numericTrace[frame] = numeric;
    }
    if (
      slot.lastProperty !== slot.properties[expectedWrites - 1] ||
      slot.lastValue !== slot.values[expectedWrites - 1]
    ) {
      throw new Error(`mass evidence: target ${index + 1} terminal не совпадает с trace`);
    }
    const targetCheckpoints = MASS_GOLDEN_FRAMES.map((frame, checkpoint) => {
      const numeric = numericTrace[frame];
      if (
        !Number.isFinite(numeric) ||
        Math.abs(numeric - golden[checkpoint]) > MASS_LIFECYCLE_GOLDEN.tolerance
      ) {
        throw new Error(
          `mass evidence: target ${index + 1} checkpoint frame ${frame}=${String(numeric)}, ожидалось ${golden[checkpoint]}`,
        );
      }
      return numeric;
    });
    writes[index] = slot.writes;
    traceHashes[index] = traceHash.toString(16).padStart(8, '0');
    checkpoints[index] = targetCheckpoints;
    totalWrites += slot.writes;
    hash = hashText(hash, `${index}:${slot.writes}:${slot.lastProperty}:${slot.lastValue}`);
  }
  return {
    totalWrites,
    writes,
    traceHashes,
    checkpoints,
    lastValueHash: hash.toString(16).padStart(8, '0'),
  };
}

const MASS_LINEAR = (value) => value;

/** Один paired lifecycle-cluster: start, те же 60 кадров, cancel+queued drain. */
export async function runMassLifecycleSample({
  animate,
  count,
  motion,
  nowNs = () => process.hrtime.bigint(),
}) {
  if (typeof animate !== 'function' || !MASS_COUNTS.includes(count)) {
    throw new Error('mass lifecycle: невалидные animate/count');
  }
  if (motion !== 'tween' && motion !== 'spring') {
    throw new Error('mass lifecycle: motion должен быть tween|spring');
  }
  const clock = createBenchClock();
  const harness = createMassTargetHarness(count);
  let onCompleteCalls = 0;
  let finished = false;
  const mode = motion === 'tween'
    ? { duration: MASS_LIFECYCLE_PROFILE.tweenDurationMs, ease: MASS_LINEAR }
    : { spring: MASS_LIFECYCLE_PROFILE.spring };

  const startBefore = nowNs();
  const controls = animate(
    harness.targets,
    { x: [MASS_LIFECYCLE_PROFILE.fromPx, MASS_LIFECYCLE_PROFILE.toPx] },
    {
      ...mode,
      requestFrame: clock.requestFrame,
      onComplete: () => { onCompleteCalls++; },
    },
  );
  const startNs = Number(nowNs() - startBefore);
  void controls.finished.then(() => { finished = true; });
  if (clock.requests !== 1 || clock.executions !== 0) {
    throw new Error('mass lifecycle: start нарушил scheduler contract');
  }

  const framesBefore = nowNs();
  for (let frame = 0; frame < MASS_LIFECYCLE_PROFILE.frames; frame++) {
    harness.setFrame(frame);
    clock.step(frame * MASS_LIFECYCLE_PROFILE.frameStepMs);
  }
  const frames60Ns = Number(nowNs() - framesBefore);
  if (onCompleteCalls !== 0) {
    throw new Error('mass lifecycle: workload завершился до 60-го живого кадра');
  }
  const targetEvidence = summarizeMassTargetEvidence(
    harness.slots,
    MASS_LIFECYCLE_PROFILE.frames,
    motion,
  );

  const teardownBefore = nowNs();
  controls.cancel();
  clock.step(MASS_LIFECYCLE_PROFILE.frames * MASS_LIFECYCLE_PROFILE.frameStepMs);
  const teardownNs = Number(nowNs() - teardownBefore);
  await controls.finished;
  if (!finished || onCompleteCalls !== 0) {
    throw new Error('mass lifecycle: cancel нарушил finished/onComplete contract');
  }
  const expectedSchedulerCount = MASS_LIFECYCLE_PROFILE.frames + 1;
  if (clock.requests !== expectedSchedulerCount || clock.executions !== expectedSchedulerCount) {
    throw new Error('mass lifecycle: teardown нарушил queued-drain contract');
  }

  return {
    startNs,
    frames60Ns,
    teardownNs,
    semantic: {
      valid: true,
      targets: count,
      frames: MASS_LIFECYCLE_PROFILE.frames,
      ...targetEvidence,
      requests: clock.requests,
      executions: clock.executions,
      onCompleteCalls,
      finished,
    },
  };
}

export const TRANSFORM_FORMATTER_BENCH_PROFILE = Object.freeze({
  seed: 0x7a6f726d,
  inputs: 16_384,
  repetitions: 16,
  warmupRounds: 6,
  rounds: 22,
});

function clampTransformNumber(value) {
  if (Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return 0;
  return value > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Реконструкция эквивалентного parts+join-алгоритма, не архивный артефакт. */
export function reconstructedPartsBuildTransform(state) {
  const parts = [];
  const x = clampTransformNumber(state.x ?? 0);
  const y = clampTransformNumber(state.y ?? 0);
  if (x !== 0 || y !== 0) {
    if (x !== 0 && y === 0) parts.push(`translateX(${x}px)`);
    else if (x === 0 && y !== 0) parts.push(`translateY(${y}px)`);
    else parts.push(`translate(${x}px, ${y}px)`);
  }
  if (state.scale !== undefined) {
    const scale = clampTransformNumber(state.scale);
    if (scale !== 1) parts.push(`scale(${scale})`);
  } else {
    const scaleX = clampTransformNumber(state.scaleX ?? 1);
    const scaleY = clampTransformNumber(state.scaleY ?? 1);
    if (scaleX !== 1 || scaleY !== 1) {
      if (scaleX === scaleY) parts.push(`scale(${scaleX})`);
      else {
        parts.push(`scaleX(${scaleX})`);
        if (scaleY !== 1) parts.push(`scaleY(${scaleY})`);
      }
    }
  }
  const rotate = clampTransformNumber(state.rotate ?? 0);
  if (rotate !== 0) parts.push(`rotate(${rotate}deg)`);
  const skewX = clampTransformNumber(state.skewX ?? 0);
  const skewY = clampTransformNumber(state.skewY ?? 0);
  if (skewX !== 0 && skewY !== 0) parts.push(`skew(${skewX}deg, ${skewY}deg)`);
  else if (skewX !== 0) parts.push(`skewX(${skewX}deg)`);
  else if (skewY !== 0) parts.push(`skewY(${skewY}deg)`);
  return parts.length === 0 ? 'none' : parts.join(' ');
}

/** Фиксированная смесь всех transform-ветвей; объекты строятся до тайминга. */
export function createSeededTransformStates(count, seed) {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('transform benchmark inputs: count должен быть положительным целым');
  }
  const random = createSeededUnitInputs(count * 8, seed);
  const states = new Array(count);
  const signed = (value, amplitude) => Math.round((value * 2 - 1) * amplitude * 1000) / 1000;
  for (let i = 0; i < count; i++) {
    const offset = i * 8;
    const mode = i & 7;
    const state = {
      x: (mode & 1) === 0 ? 0 : signed(random[offset], 480),
      y: (mode & 2) === 0 ? 0 : signed(random[offset + 1], 320),
      rotate: (mode & 1) === 0 ? 0 : signed(random[offset + 5], 180),
      skewX: (mode & 2) === 0 ? 0 : signed(random[offset + 6], 30),
      skewY: (mode & 4) === 0 ? 0 : signed(random[offset + 7], 30),
    };
    if ((mode & 4) === 0) {
      state.scale = mode === 0 ? 1 : 0.5 + random[offset + 2] * 1.5;
    } else {
      state.scaleX = 0.5 + random[offset + 3] * 1.5;
      state.scaleY = (mode & 1) === 0 ? state.scaleX : 0.5 + random[offset + 4] * 1.5;
    }
    states[i] = state;
  }
  return states;
}

/** Полное посимвольное чтение исключает отложенную materialization concat-rope. */
export function materializeTransformOutputs(formatter, states, repetitions = 1) {
  let hash = 0x811c9dc5;
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const state of states) {
      const value = formatter(state);
      for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      hash ^= 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

/** Сильная provenance-сумма строк вне таймленного участка. */
export function checksumTransformOutputs(formatter, states) {
  return materializeTransformOutputs(formatter, states).toString(16).padStart(8, '0');
}
