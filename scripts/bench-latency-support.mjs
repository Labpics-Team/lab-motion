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
  const finish = (result, arg) => {
    try {
      if (verify) {
        onPhase?.('verify');
        verify(result, arg);
      }
    } finally {
      if (teardown) {
        onPhase?.('teardown');
        teardown(result, arg);
      }
    }
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
    const result = operate(arg);
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
      const startedAt = nowNs();
      const result = operate(arg);
      const finishedAt = nowNs();
      const elapsed = Number(finishedAt - startedAt);
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

/** Создаёт ровно один compositor→live sample и проверяет его host-effects. */
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

  return {
    controller,
    verify(live) {
      if (verified) {
        throw new Error('handoff benchmark: lifecycle sample повторно использован');
      }
      verified = true;
      const evidence = { animations, cancels, frameRequests };
      if (
        animations !== 1 ||
        cancels !== 1 ||
        frameRequests !== 1 ||
        !live ||
        typeof live.destroy !== 'function' ||
        !Number.isFinite(live.value) ||
        !Number.isFinite(live.velocity)
      ) {
        throw new Error(
          `handoff benchmark: не выполнен полный lifecycle ` +
          `(animate=${animations}, cancel=${cancels}, requestFrame=${frameRequests})`,
        );
      }
      return evidence;
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
    teardown(live, _sample) {
      live.destroy();
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
