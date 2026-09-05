const systemNowNs = process.hrtime.bigint;

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
      onPhase?.('teardown');
      teardown(result, arg);
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
}) {
  let animations = 0;
  let cancels = 0;
  let frameRequests = 0;
  let verified = false;

  const controller = new CompositorSpring({
    spring,
    property,
    from,
    to,
    now,
    target: {
      animate() {
        animations++;
        return { cancel() { cancels++; } };
      },
    },
    requestFrame: () => ++frameRequests,
  });
  controller.start();
  const setupEffects = { animations, cancels, frameRequests };

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
      if (
        setupEffects.animations !== 1 ||
        setupEffects.cancels !== 0 ||
        setupEffects.frameRequests !== 0 ||
        handoffEffects.animations !== 0 ||
        handoffEffects.cancels !== 1 ||
        handoffEffects.frameRequests !== 1 ||
        !live ||
        typeof live.destroy !== 'function' ||
        !Number.isFinite(live.value) ||
        !Number.isFinite(live.velocity)
      ) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle ` +
          `(setup: animate=${setupEffects.animations}, cancel=${setupEffects.cancels}, ` +
          `requestFrame=${setupEffects.frameRequests}; handoff: animate=${handoffEffects.animations}, ` +
          `cancel=${handoffEffects.cancels}, requestFrame=${handoffEffects.frameRequests})`,
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
