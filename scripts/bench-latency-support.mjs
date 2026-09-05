const systemNowNs = process.hrtime.bigint;

const DONOR_TIMING_FIELDS = new Set([
  'duration',
  'easing',
  'delay',
  'endDelay',
  'fill',
  'iterationStart',
  'iterations',
  'direction',
  'composite',
  'iterationComposite',
]);

function readDonorFrame(frame, property) {
  if (
    frame === null ||
    typeof frame !== 'object' ||
    Object.getPrototypeOf(frame) !== Object.prototype ||
    Reflect.ownKeys(frame).some((key) => (
      typeof key !== 'string' ||
      (key !== property && key !== 'offset' && key !== 'easing' && key !== 'composite')
    )) ||
    !Number.isFinite(frame[property]) ||
    (frame.easing !== undefined && frame.easing !== 'linear') ||
    (frame.composite !== undefined && frame.composite !== 'replace')
  ) {
    throw new Error('handoff benchmark: donor keyframe не соответствует профилю');
  }
  return {
    hasOffset: Object.hasOwn(frame, 'offset'),
    offset: frame.offset,
    value: frame[property],
  };
}

function captureDonorExecution(keyframes, timing, property, from, to) {
  if (
    timing === null ||
    typeof timing !== 'object' ||
    Object.getPrototypeOf(timing) !== Object.prototype ||
    Reflect.ownKeys(timing).some((key) => !DONOR_TIMING_FIELDS.has(key)) ||
    !Array.isArray(keyframes) ||
    keyframes.length < 2 ||
    !Number.isFinite(timing.duration) ||
    timing.duration <= 0 ||
    timing.iterations !== 1 ||
    timing.fill !== 'both' ||
    timing.composite !== 'replace' ||
    (timing.delay !== undefined && timing.delay !== 0) ||
    (timing.endDelay !== undefined && timing.endDelay !== 0) ||
    (timing.iterationStart !== undefined && timing.iterationStart !== 0) ||
    (timing.direction !== undefined && timing.direction !== 'normal') ||
    (timing.iterationComposite !== undefined && timing.iterationComposite !== 'replace')
  ) {
    throw new Error('handoff benchmark: donor execution не соответствует профилю');
  }
  const durationMs = timing.duration;
  const easing = timing.easing;
  const frames = keyframes.map((frame) => readDonorFrame(frame, property));
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first.value !== from || last.value !== to) {
    throw new Error('handoff benchmark: donor endpoints не соответствуют профилю');
  }

  let stops;
  if (easing === 'linear') {
    if (frames.some((frame) => !frame.hasOffset)) {
      throw new Error('handoff benchmark: explicit donor offsets не соответствуют профилю');
    }
    stops = frames.map((frame) => ({ offset: frame.offset, value: frame.value }));
  } else if (typeof easing === 'string' && easing.startsWith('linear(') && easing.endsWith(')')) {
    const implicitOffsets = !first.hasOffset && !last.hasOffset;
    const endpointOffsets = first.hasOffset && first.offset === 0 && last.hasOffset && last.offset === 1;
    if (frames.length !== 2 || (!implicitOffsets && !endpointOffsets)) {
      throw new Error('handoff benchmark: CSS donor keyframes не соответствуют профилю');
    }
    stops = easing.slice(7, -1).split(',').map((entry) => {
      const [rawProgress, rawPercent, ...rest] = entry.trim().split(/\s+/);
      if (rest.length > 0 || !rawPercent?.endsWith('%')) {
        throw new Error('handoff benchmark: donor linear() не соответствует профилю');
      }
      const progress = Number(rawProgress);
      return {
        offset: Number(rawPercent.slice(0, -1)) / 100,
        value: (1 - progress) * from + progress * to,
      };
    });
  } else {
    throw new Error('handoff benchmark: donor easing не соответствует профилю');
  }

  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    if (
      !Number.isFinite(stop?.offset) ||
      !Number.isFinite(stop?.value) ||
      (index > 0 && stop.offset <= stops[index - 1].offset)
    ) {
      throw new Error('handoff benchmark: donor stops не соответствуют профилю');
    }
  }
  if (stops[0].offset !== 0 || stops[stops.length - 1].offset !== 1) {
    throw new Error('handoff benchmark: donor диапазон не соответствует профилю');
  }
  return Object.freeze({
    durationMs,
    stops: Object.freeze(stops.map((stop) => Object.freeze({ ...stop }))),
  });
}

function sampleDonorExecution(execution, elapsedMs) {
  const { durationMs, stops } = execution;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= durationMs) {
    throw new Error('handoff benchmark: elapsed не соответствует donor-профилю');
  }
  const offset = elapsedMs / durationMs;
  let right = 1;
  while (right < stops.length - 1 && stops[right].offset <= offset) right++;
  const left = stops[right - 1];
  const next = stops[right];
  const span = next.offset - left.offset;
  const q = (offset - left.offset) / span;
  return Object.freeze({
    value: (1 - q) * left.value + q * next.value,
    velocity: (next.value - left.value) / (span * durationMs / 1_000),
  });
}

function matchesFiniteOracle(actual, expected) {
  if (!Number.isFinite(actual)) return false;
  // В выбранной interior-точке оба независимых affine-пути вместе делают <32
  // Binary64-операций; 64 epsilon оставляют запас на их различную группировку.
  const floatingBound = 64 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= floatingBound;
}

/**
 * Перцентильный runner: setup/verify/teardown находятся вне измеряемого окна,
 * внутри остаётся только op. Один runner обслуживает CLI и lifecycle-тесты.
 */
export function measureLatency(label, {
  setup,
  op,
  verify,
  teardown,
  nowNs = systemNowNs,
  iters = 2_000,
  warmup = 500,
  runs = 5,
  onPhase,
}) {
  const assertCount = (name, value, allowZero) => {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new RangeError(`${name} должен быть ${allowZero ? 'неотрицательным' : 'положительным'} целым`);
    }
  };
  assertCount('iters', iters, false);
  assertCount('warmup', warmup, true);
  assertCount('runs', runs, false);

  const nearestRank = (sorted, p) => sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const cleanup = (result, arg) => {
    if (teardown) {
      let phaseFailed = false;
      let phaseError;
      try {
        onPhase?.('teardown');
      } catch (error) {
        phaseFailed = true;
        phaseError = error;
      }
      try {
        teardown(result, arg);
      } catch (teardownError) {
        if (phaseFailed) {
          throw new AggregateError(
            [phaseError, teardownError],
            'latency benchmark: teardown observer и teardown завершились ошибкой',
          );
        }
        throw teardownError;
      }
      if (phaseFailed) throw phaseError;
    }
  };
  const fail = (error, result, arg) => {
    try {
      cleanup(result, arg);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'latency benchmark: операция и teardown завершились ошибкой',
      );
    }
    throw error;
  };
  const finish = (result, arg) => {
    if (verify) {
      try {
        onPhase?.('verify');
        verify(result, arg);
      } catch (error) {
        fail(error, result, arg);
      }
    }
    cleanup(result, arg);
  };
  const prepare = (index) => {
    if (!setup) return undefined;
    onPhase?.('setup');
    return setup(index);
  };
  const operate = onPhase
    ? (arg) => {
      onPhase('op');
      return op(arg);
    }
    : op;

  for (let index = 0; index < warmup; index++) {
    const arg = prepare(index);
    let result;
    try {
      result = operate(arg);
    } catch (error) {
      fail(error, result, arg);
    }
    finish(result, arg);
  }

  const p50s = [];
  const p95s = [];
  const p99s = [];
  let positiveSamples = 0;
  for (let run = 0; run < runs; run++) {
    const samples = new Float64Array(iters);
    for (let index = 0; index < iters; index++) {
      const arg = prepare(index);
      let result;
      let elapsed;
      try {
        const startedAt = nowNs();
        result = operate(arg);
        const finishedAt = nowNs();
        elapsed = Number(finishedAt - startedAt);
      } catch (error) {
        fail(error, result, arg);
      }
      finish(result, arg);
      if (!Number.isFinite(elapsed) || elapsed < 0) {
        throw new Error('latency benchmark: часы вернули некорректный интервал');
      }
      samples[index] = elapsed;
      if (elapsed > 0) positiveSamples++;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    p50s.push(nearestRank(sorted, 50));
    p95s.push(nearestRank(sorted, 95));
    p99s.push(nearestRank(sorted, 99));
  }
  if (positiveSamples === 0) {
    throw new Error('latency benchmark: нет положительных samples');
  }
  return { label, p50: median(p50s), p95: median(p95s), p99: median(p99s) };
}

/** Создаёт один compositor→live sample и сверяет точные host-effects его фаз. */
function createCompositorHandoffLatencySample({
  CompositorSpring,
  spring,
  property,
  from,
  to,
  now,
  elapsedMs,
}) {
  let animations = 0;
  let cancels = 0;
  let frameRequests = 0;
  let clockReads = 0;
  let donorReads = 0;
  let verified = false;
  let donorExecution;

  const controller = new CompositorSpring({
    spring,
    property,
    from,
    to,
    now: () => {
      clockReads++;
      return now();
    },
    target: {
      animate(keyframes, timing) {
        animations++;
        donorExecution ??= captureDonorExecution(keyframes, timing, property, from, to);
        return {
          get currentTime() {
            donorReads++;
            return elapsedMs;
          },
          cancel() { cancels++; },
        };
      },
    },
    requestFrame: () => ++frameRequests,
  });
  let expectedLive;
  try {
    controller.start();
    if (!donorExecution) {
      throw new Error('handoff benchmark: setup не опубликовал donor execution');
    }
    expectedLive = sampleDonorExecution(donorExecution, elapsedMs);
  } catch (error) {
    try {
      controller.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'handoff benchmark: setup и cleanup завершились ошибкой',
      );
    }
    throw error;
  }
  const setupEffects = { animations, cancels, frameRequests };
  const setupClockReads = clockReads;
  const setupDonorReads = donorReads;

  return {
    controller,
    verify(live) {
      if (verified) {
        throw new Error('handoff benchmark: lifecycle sample повторно использован');
      }
      verified = true;
      const handoffEffects = {
        animations: animations - setupEffects.animations,
        cancels: cancels - setupEffects.cancels,
        frameRequests: frameRequests - setupEffects.frameRequests,
      };
      const handoffClockReads = clockReads - setupClockReads;
      const handoffDonorReads = donorReads - setupDonorReads;
      if (
        setupEffects.animations !== 1 ||
        setupEffects.cancels !== 0 ||
        setupEffects.frameRequests !== 0 ||
        handoffEffects.animations !== 0 ||
        handoffEffects.cancels !== 1 ||
        handoffEffects.frameRequests !== 1
      ) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle ` +
          `(setup: animate=${setupEffects.animations}, cancel=${setupEffects.cancels}, ` +
          `requestFrame=${setupEffects.frameRequests}; handoff: animate=${handoffEffects.animations}, ` +
          `cancel=${handoffEffects.cancels}, requestFrame=${handoffEffects.frameRequests})`,
        );
      }
      if (setupClockReads !== 1 || handoffClockReads !== 1) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle ` +
          `(donor clock: setup=${setupClockReads}, handoff=${handoffClockReads})`,
        );
      }
      if (setupDonorReads !== 0 || handoffDonorReads !== 1) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle ` +
          `(donor animation: setup=${setupDonorReads}, handoff=${handoffDonorReads})`,
        );
      }
      if (
        !live ||
        typeof live.destroy !== 'function' ||
        !matchesFiniteOracle(live.value, expectedLive.value) ||
        !matchesFiniteOracle(live.velocity, expectedLive.velocity)
      ) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle (live snapshot: ` +
          `value=${live?.value}/${expectedLive.value}, ` +
          `velocity=${live?.velocity}/${expectedLive.velocity})`,
        );
      }
      return handoffEffects;
    },
  };
}

/** Реальный CLI-сценарий: новый однонаправленный controller на каждый sample. */
export function createCompositorHandoffLatencyScenario({
  CompositorSpring,
  spring,
  property,
  from,
  to,
  initialNow,
  elapsedMs,
}) {
  let nextStart = initialNow;
  return {
    setup(_index) {
      let now = nextStart;
      const sample = createCompositorHandoffLatencySample({
        CompositorSpring,
        spring,
        property,
        from,
        to,
        now: () => now,
        elapsedMs,
      });
      now += elapsedMs;
      nextStart += elapsedMs;
      return sample;
    },
    op(sample) {
      return sample.controller.handoffToLive();
    },
    verify(live, sample) {
      return sample.verify(live);
    },
    teardown(live, sample) {
      if (live && typeof live.destroy === 'function') {
        live.destroy();
      } else {
        sample.controller.destroy();
      }
    },
  };
}

/** Единственная проводка полного handoff для CLI и исполняемого теста. */
export function measureCompositorHandoffLatency({
  CompositorSpring,
  spring,
  property,
  from,
  to,
  initialNow,
  elapsedMs,
  nowNs,
  iters,
  warmup,
  runs,
  onPhase,
}) {
  return measureLatency(
    'CompositorSpring.handoffToLive (read+cancel+build)',
    {
      ...createCompositorHandoffLatencyScenario({
        CompositorSpring,
        spring,
        property,
        from,
        to,
        initialNow,
        elapsedMs,
      }),
      nowNs,
      iters,
      warmup,
      runs,
      onPhase,
    },
  );
}
