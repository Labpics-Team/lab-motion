import { createHash } from 'node:crypto';
import { createBenchClock } from './bench-support.mjs';

const INITIAL = Object.freeze({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0 });
const PREVIOUS = Object.freeze({ x: 64, y: 32, scaleX: 2, scaleY: 3, rotate: 32, skewX: 8, skewY: 16 });
const DESTINATION = Object.freeze({ x: 256, y: 160, scaleX: 4, scaleY: 5, rotate: 96, skewX: 24, skewY: 40 });

export const TRANSFORM_PAIR_PROFILE = Object.freeze({
  scope: 'engine-only public animate transform lifecycle screening',
  seed: 0x7472616e,
  counts: Object.freeze([1, 100, 1000]),
  lifecycles: Object.freeze(['fresh', 'settled', 'live']),
  channels: Object.freeze([1, 7]),
  previousChannels: 7,
  initial: INITIAL,
  previousDestination: PREVIOUS,
  destination: DESTINATION,
  warmupRounds: 2,
  rounds: 8,
  durationMs: 128,
  frameOffsetsMs: Object.freeze([0, 16, 32, 48, 64, 80]),
  previousLiveOffsetsMs: Object.freeze([0, 32]),
  previousSettledOffsetsMs: Object.freeze([0, 64, 128]),
  clockOriginMs: 1_000_000,
  successorGapMs: 16,
  oracleAbsoluteTolerance: 1e-10,
  statistics: 'descriptive marginal nearest-rank p50/p95/p99 plus paired block contrasts; no confidence bounds, comparative proof or tail guarantee',
});

const KEYS = Object.keys(INITIAL);
const LINEAR = (progress) => progress;

function interpolate(from, to, progress) {
  return Object.fromEntries(KEYS.map((key) => [key, from[key] + (to[key] - from[key]) * progress]));
}

/** Oracle использует заданные endpoints и linear, без solver/formatter пакета. */
export function expectedTransformValues(lifecycle, channels, offsetMs) {
  if (!TRANSFORM_PAIR_PROFILE.lifecycles.includes(lifecycle) ||
      !TRANSFORM_PAIR_PROFILE.channels.includes(channels) ||
      !TRANSFORM_PAIR_PROFILE.frameOffsetsMs.includes(offsetMs)) {
    throw new Error('transform oracle: вход вне фиксированного профиля');
  }
  const previousProgress = lifecycle === 'live'
    ? TRANSFORM_PAIR_PROFILE.previousLiveOffsetsMs.at(-1) / TRANSFORM_PAIR_PROFILE.durationMs : 1;
  const from = lifecycle === 'fresh' ? INITIAL : interpolate(INITIAL, PREVIOUS, previousProgress);
  const to = channels === 7 ? DESTINATION : { ...from, x: DESTINATION.x };
  return interpolate(from, to, offsetMs / TRANSFORM_PAIR_PROFILE.durationMs);
}

/** Чтение значений CSS независимо от ветвления formatter измеряемого пакета. */
function readTransform(text) {
  const state = { ...INITIAL };
  if (text === 'none') return state;
  if (typeof text !== 'string' || text.length === 0) throw new Error('transform: отсутствует CSS');
  let end = 0;
  let previousStage = -1;
  const seen = new Set();
  for (const token of text.matchAll(/([A-Za-z]+)\(([^)]*)\)/g)) {
    if (text.slice(end, token.index).trim()) throw new Error('transform: посторонний CSS');
    end = token.index + token[0].length;
    // Порядок CSS-функций меняет матрицу даже при тех же числах каналов.
    const stage = token[1].startsWith('translate') ? 0
      : token[1].startsWith('scale') ? 1
      : token[1] === 'rotate' ? 2
      : token[1].startsWith('skew') ? 3 : -1;
    if (stage < previousStage || stage < 0 || (stage === 3 && previousStage === 3)) {
      throw new Error('transform: нарушен порядок transform или совместная skew-форма');
    }
    previousStage = stage;
    const args = token[2].split(',').map((value) => value.trim());
    const assign = (key, input, unit) => {
      if (seen.has(key)) throw new Error('transform: повторный канал');
      seen.add(key);
      const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|deg)?$/i.exec(input ?? '');
      if (!match || (match[2] ?? '') !== unit || !Number.isFinite(Number(match[1]))) {
        throw new Error('transform: неверное число/единица');
      }
      state[key] = Number(match[1]);
    };
    switch (token[1]) {
      case 'translateX': if (args.length !== 1) throw new Error('transform: arity'); assign('x', args[0], 'px'); break;
      case 'translateY': if (args.length !== 1) throw new Error('transform: arity'); assign('y', args[0], 'px'); break;
      case 'translate': if (args.length !== 2) throw new Error('transform: arity'); assign('x', args[0], 'px'); assign('y', args[1], 'px'); break;
      case 'scale': if (args.length !== 1) throw new Error('transform: arity'); assign('scaleX', args[0], ''); assign('scaleY', args[0], ''); break;
      case 'scaleX': case 'scaleY': if (args.length !== 1) throw new Error('transform: arity'); assign(token[1], args[0], ''); break;
      case 'rotate': case 'skewX': case 'skewY': if (args.length !== 1) throw new Error('transform: arity'); assign(token[1], args[0], 'deg'); break;
      case 'skew': if (args.length !== 2) throw new Error('transform: arity'); assign('skewX', args[0], 'deg'); assign('skewY', args[1], 'deg'); break;
      default: throw new Error('transform: неизвестная функция');
    }
  }
  if (end === 0 || text.slice(end).trim()) throw new Error('transform: посторонний CSS');
  return state;
}

function checkValues(text, expected, label) {
  const actual = readTransform(text);
  for (const key of KEYS) {
    if (Math.abs(actual[key] - expected[key]) > TRANSFORM_PAIR_PROFILE.oracleAbsoluteTolerance) {
      throw new Error(`transform: ${label} ${key}=${actual[key]}, ожидалось ${expected[key]}`);
    }
  }
}

async function flushReactions() {
  // Ограниченные Promise checkpoints превращают never-finished в отказ, а не зависание.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** @typedef {{ status: 'pending' } | { status: 'fulfilled' } | { status: 'rejected', reason: unknown }} FinishedState */

function requireLineage(condition, message) {
  if (!condition) throw new Error(`transform lineage: ${message}`);
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && Array.from(actual).every((value, index) => value === expected[index]);
}

function caseTimeline({ lifecycle }) {
  const profile = TRANSFORM_PAIR_PROFILE;
  const setupOffsetsMs = lifecycle === 'fresh' ? [] : lifecycle === 'settled'
    ? [...profile.previousSettledOffsetsMs] : [...profile.previousLiveOffsetsMs];
  return {
    clockOriginMs: profile.clockOriginMs, setupOffsetsMs, frameOffsetsMs: [...profile.frameOffsetsMs],
    successorBaseMs: profile.clockOriginMs + (setupOffsetsMs.length ? setupOffsetsMs.at(-1) + profile.successorGapMs : 0),
  };
}

/** Позиции целей задаёт from/count; одинаковые записи сохраняются целиком, без hash-only замены. */
function captureTargetTraces(slots, lifecycle) {
  const runs = [];
  let previousText;
  for (let target = 0; target < slots.length; target++) {
    const slot = slots[target];
    const trace = {
      value: slot.value,
      setup: lifecycle === 'fresh' ? [] : Array.from(slot.setup, (value) => value ?? null),
      setupWrites: lifecycle === 'fresh' ? [] : Array.from(slot.setupWrites),
      values: Array.from(slot.values, (value) => value ?? null), writes: Array.from(slot.writes),
      outsideWrites: slot.outsideWrites, events: slot.events.map((event) => ({ ...event })),
    };
    const text = JSON.stringify(trace);
    if (text === previousText) runs.at(-1).count++;
    else runs.push({ from: target, count: 1, trace });
    previousText = text;
  }
  return { encoding: 'runs', count: slots.length, runs };
}

/** Пересчитывает успешный sample из первичных clock/CSS записей, без статистики или новых порогов. */
export function validateTransformLifecycleSample(sample, expectedCase) {
  const profile = TRANSFORM_PAIR_PROFILE;
  const { count, lifecycle, channels } = expectedCase ?? {};
  requireLineage(profile.counts.includes(count) && profile.lifecycles.includes(lifecycle) && profile.channels.includes(channels), 'неизвестный ожидаемый case');
  const raw = sample?.raw;
  requireLineage(raw?.schemaVersion === 1 && raw.case?.count === count && raw.case?.lifecycle === lifecycle && raw.case?.channels === channels, 'case не соответствует владельцу');
  requireLineage(sample.semantic?.valid === true, 'отказ не является успешным sample');
  const expectedReads = [
    { metric: 'operationNs', frame: null, edge: 'before' }, { metric: 'operationNs', frame: null, edge: 'after' },
    ...profile.frameOffsetsMs.flatMap((_, frame) => [{ metric: 'frameNs', frame, edge: 'before' }, { metric: 'frameNs', frame, edge: 'after' }]),
    { metric: 'cancelDrainNs', frame: null, edge: 'before' }, { metric: 'cancelDrainNs', frame: null, edge: 'after' },
  ];
  requireLineage(Array.isArray(raw.clockReads) && raw.clockReads.length === expectedReads.length, 'потеряны clock reads');
  const readings = raw.clockReads.map((read, sequence) => {
    const expected = expectedReads[sequence];
    requireLineage(read?.sequence === sequence && read.metric === expected.metric && read.frame === expected.frame && read.edge === expected.edge, 'нарушен порядок clock reads');
    requireLineage(typeof read.valueNs === 'string' && /^-?(?:0|[1-9]\d*)$/.test(read.valueNs), 'clock read не является целым ns');
    const value = BigInt(read.valueNs);
    requireLineage(value.toString() === read.valueNs, 'clock read не является каноническим StringBigInt');
    return value;
  });
  for (let index = 1; index < readings.length; index++) requireLineage(readings[index] >= readings[index - 1], 'clock reads идут назад');
  const intervals = [];
  const frameNs = [];
  let operationNs;
  let cancelDrainNs;
  for (let index = 0; index < readings.length; index += 2) {
    const read = raw.clockReads[index];
    const duration = readings[index + 1] - readings[index];
    const value = Number(duration);
    requireLineage(Number.isFinite(value) && value >= 0, 'некорректный пересчитанный интервал');
    intervals.push({ metric: read.metric, frame: read.frame, beforeNs: read.valueNs, afterNs: raw.clockReads[index + 1].valueNs, durationNs: duration.toString() });
    if (read.metric === 'operationNs') operationNs = value;
    else if (read.metric === 'cancelDrainNs') cancelDrainNs = value;
    else frameNs.push(value);
  }
  requireLineage(sample.operationNs === operationNs && sample.cancelDrainNs === cancelDrainNs &&
    sameArray(sample.frameNs, frameNs), 'metric не пересчитывается из endpoints');
  const timeline = caseTimeline(expectedCase);
  requireLineage(raw.timeline?.clockOriginMs === timeline.clockOriginMs && raw.timeline?.successorBaseMs === timeline.successorBaseMs &&
    sameArray(raw.timeline?.setupOffsetsMs, timeline.setupOffsetsMs) && sameArray(raw.timeline?.frameOffsetsMs, timeline.frameOffsetsMs), 'timeline не соответствует профилю');
  const expectedSteps = [
    ...timeline.setupOffsetsMs.map((offset, index) => ({ stage: 'setup', index, phase: 'setup', timestampMs: timeline.clockOriginMs + offset })),
    ...(lifecycle === 'settled' ? [{ stage: 'settled-drain', index: null, phase: 'outside', timestampMs: timeline.clockOriginMs + timeline.setupOffsetsMs.at(-1) + 1 }] : []),
    ...timeline.frameOffsetsMs.map((offset, index) => ({ stage: 'frame', index, phase: 'frames', timestampMs: timeline.successorBaseMs + offset })),
    { stage: 'cancel-drain', index: null, phase: 'outside', timestampMs: timeline.successorBaseMs + profile.durationMs },
    ...[2, 3].map((factor) => ({ stage: 'idle', index: null, phase: 'outside', timestampMs: timeline.successorBaseMs + profile.durationMs * factor })),
  ];
  requireLineage(Array.isArray(raw.timeline.steps) && raw.timeline.steps.length === expectedSteps.length, 'потеряны или добавлены scheduler steps');
  for (let sequence = 0; sequence < raw.timeline.steps.length; sequence++) {
    const step = raw.timeline.steps[sequence];
    const expected = expectedSteps[sequence];
    requireLineage(step?.sequence === sequence && Object.keys(expected).every((key) => step[key] === expected[key]), 'нарушен порядок scheduler steps');
  }
  const packed = raw.targetTraces;
  requireLineage(packed?.encoding === 'runs' && packed.count === count && Array.isArray(packed.runs) && packed.runs.length > 0 && packed.runs.length <= count, 'некорректный target RLE');
  const expectedEvents = expectedSteps.map((step, sequence) => ({ ...step, step: sequence })).filter((step) => step.stage === 'setup' || step.stage === 'frame');
  let nextTarget = 0;
  for (const run of packed.runs) {
    requireLineage(run?.from === nextTarget && Number.isSafeInteger(run.count) && run.count > 0 && run.count <= count - nextTarget, 'RLE потерял или повторил target identity');
    const trace = run.trace;
    requireLineage(trace && Array.isArray(trace.setup) && trace.setup.length === timeline.setupOffsetsMs.length &&
      Array.isArray(trace.setupWrites) && trace.setupWrites.length === trace.setup.length && Array.from(trace.setupWrites).every((value) => value === 1) &&
      Array.isArray(trace.values) && trace.values.length === frameNs.length && Array.isArray(trace.writes) && trace.writes.length === frameNs.length &&
      Array.from(trace.writes).every((value) => value === 1) && trace.outsideWrites === 0 && trace.value === trace.values.at(-1), 'неполная запись target');
    for (let frame = 0; frame < trace.setup.length; frame++) {
      checkValues(trace.setup[frame], interpolate(INITIAL, PREVIOUS, timeline.setupOffsetsMs[frame] / profile.durationMs), `raw setup target ${run.from} frame ${frame}`);
    }
    for (let frame = 0; frame < trace.values.length; frame++) {
      checkValues(trace.values[frame], expectedTransformValues(lifecycle, channels, timeline.frameOffsetsMs[frame]), `raw target ${run.from} frame ${frame}`);
    }
    requireLineage(Array.isArray(trace.events) && trace.events.length === expectedEvents.length, 'потеряны target write events');
    for (let sequence = 0; sequence < trace.events.length; sequence++) {
      const event = trace.events[sequence];
      const expected = expectedEvents[sequence];
      const value = expected.stage === 'setup' ? trace.setup[expected.index] : trace.values[expected.index];
      requireLineage(event?.sequence === sequence && event.phase === expected.phase && event.index === expected.index && event.step === expected.step &&
        event.timestampMs === expected.timestampMs && event.property === 'transform' && event.value === value, 'write event не соответствует приобретённому кадру');
    }
    const hash = createHash('sha256').update(JSON.stringify(trace.values)).digest('hex');
    const hashes = sample.semantic.targetTraceHashes;
    if (Array.isArray(hashes)) {
      requireLineage(hashes.length === count, 'потеряны target hashes');
      for (let target = run.from; target < run.from + run.count; target++) requireLineage(hashes[target] === hash, 'hash не соответствует raw CSS');
    } else {
      requireLineage(hashes?.encoding === 'repeat' && hashes.count === count && hashes.value === hash, 'hash RLE не соответствует raw CSS');
    }
    nextTarget += run.count;
  }
  requireLineage(nextTarget === count && sample.semantic.targets === count && sample.semantic.frames === frameNs.length && sample.semantic.finished === true &&
    sample.semantic.previousFinished === (lifecycle === 'fresh' ? null : true) && sample.semantic.onCompleteCalls === 0 &&
    sample.semantic.previousCompleteCalls === (lifecycle === 'settled' ? 1 : 0) && Number.isSafeInteger(sample.semantic.requests) &&
    sample.semantic.requests > 0 && sample.semantic.executions === sample.semantic.requests && sample.semantic.pending === 0, 'raw/semantic итог не соответствует case');
  return { operationNs, frameNs, cancelDrainNs, intervals, traceRuns: packed.runs };
}

export async function runTransformLifecycleSample({ animate, count, lifecycle, channels, nowNs = () => process.hrtime.bigint() }) {
  const profile = TRANSFORM_PAIR_PROFILE;
  if (typeof animate !== 'function' || !profile.counts.includes(count) ||
      !profile.lifecycles.includes(lifecycle) || !profile.channels.includes(channels)) {
    throw new Error('transform lifecycle: вход вне фиксированного профиля');
  }
  const clock = createBenchClock();
  const clockReads = [];
  const steps = [];
  let currentStep = null;
  const frames = profile.frameOffsetsMs.length;
  const setupOffsets = lifecycle === 'settled' ? profile.previousSettledOffsetsMs : profile.previousLiveOffsetsMs;
  const slots = Array.from({ length: count }, () => ({
    value: '', setup: new Array(setupOffsets.length), setupWrites: new Uint32Array(setupOffsets.length),
    values: new Array(frames), writes: new Uint32Array(frames), outsideWrites: 0, events: [],
  }));
  let phase = 'outside';
  let index = -1;
  const targets = slots.map((slot) => ({ style: {
    getPropertyValue: (name) => name === 'transform' ? slot.value : '',
    setProperty(name, value) {
      slot.events.push({ sequence: slot.events.length, phase, index: phase === 'outside' ? null : index,
        step: currentStep?.sequence ?? null, timestampMs: currentStep?.timestampMs ?? null, property: name, value });
      slot.value = name === 'transform' ? value : `invalid:${name}`;
      if (phase === 'setup') { slot.setup[index] = slot.value; slot.setupWrites[index]++; }
      else if (phase === 'frames') { slot.values[index] = slot.value; slot.writes[index]++; }
      else slot.outsideWrites++;
    },
  } }));
  const props = channels === 7 ? { ...DESTINATION } : { x: DESTINATION.x };
  const previousProps = Object.fromEntries(KEYS.map((key) => [key, [INITIAL[key], PREVIOUS[key]]]));
  let previousCompleteCalls = 0;
  let onCompleteCalls = 0;
  /** @type {FinishedState} */
  let previousFinished = { status: 'pending' };
  /** @type {FinishedState} */
  let finished = { status: 'pending' };
  let previous;
  let controls;
  let timestamp = profile.clockOriginMs;
  const options = {
    duration: profile.durationMs, ease: LINEAR, requestFrame: clock.requestFrame,
    matchMedia: () => ({ matches: false }), onComplete: () => { onCompleteCalls++; },
  };
  const readNs = (metric, frame, edge) => {
    const value = nowNs();
    clockReads.push({ sequence: clockReads.length, metric, frame, edge, value });
    return value;
  };
  // Время записи — общий последний предложенный scheduler timestamp, не чтение физических часов.
  const step = (stage, frame, timestampMs) => {
    currentStep = { sequence: steps.length, stage, index: frame, phase, timestampMs };
    steps.push(currentStep);
    clock.step(timestampMs);
  };
  const captureRaw = () => ({
    schemaVersion: 1, case: { count, lifecycle, channels },
    clockReads: clockReads.map(({ value, ...read }) => ({ ...read, valueNs: String(value) })),
    timeline: { ...caseTimeline({ lifecycle }), steps: steps.map((entry) => ({ ...entry })) },
    targetTraces: captureTargetTraces(slots, lifecycle),
  });
  const pending = () => clock.requests - clock.executions;
  const requirePending = (expected, label) => {
    if (pending() !== expected) throw new Error(`transform scheduler: ${label} pending=${pending()}, ожидалось ${expected}`);
  };
  const requireLive = (label) => {
    if (pending() <= 0) throw new Error(`transform scheduler: ${label} отсутствует следующий callback`);
  };
  let operationNs = null;
  const frameNs = [];
  let cancelDrainNs = null;
  let failurePhase = 'setup';
  let activeMetric = null;
  let activeFrame = null;
  let intervalBefore = null;
  let intervalAfter = null;
  const cleanupErrors = [];
  const recordedFailure = Symbol('recorded lifecycle failure');
  const requireNoRecordedFailures = () => {
    if (cleanupErrors.length || previousFinished.status === 'rejected' || finished.status === 'rejected') {
      throw recordedFailure;
    }
  };
  const observeFinished = (owner, accept) => {
    try {
      void owner.finished.then(
        () => { accept({ status: 'fulfilled' }); },
        (reason) => { accept({ status: 'rejected', reason }); },
      );
    } catch (reason) {
      accept({ status: 'rejected', reason });
    }
  };
  let cleanupStarted = false;
  let cleanupCompleted = false;
  const cleanup = async () => {
    cleanupStarted = true;
    phase = 'outside';
    currentStep = null;
    // Каждый владелец и drain получают попытку очистки; throw undefined тоже сохраняется.
    try { controls?.cancel(); } catch (error) { cleanupErrors.push(error); }
    try { previous?.cancel(); } catch (error) { cleanupErrors.push(error); }
    for (let drain = 0; drain < 4 && pending() > 0; drain++) {
      try { step('cleanup-drain', null, timestamp + profile.durationMs * (4 + drain)); } catch (error) { cleanupErrors.push(error); }
    }
    await flushReactions();
    cleanupCompleted = true;
  };
  const failureSemantic = () => ({
    valid: false, targets: count, frames, phase, index, timestampBaseMs: timestamp,
    finished: finished.status, previousFinished: lifecycle === 'fresh' ? null : previousFinished.status,
    onCompleteCalls, previousCompleteCalls, requests: clock.requests, executions: clock.executions, pending: pending(),
    targetTraces: slots.map((slot) => ({
      value: slot.value, setup: Array.from(slot.setup, (value) => value ?? null), setupWrites: Array.from(slot.setupWrites),
      values: Array.from(slot.values, (value) => value ?? null), writes: Array.from(slot.writes), outsideWrites: slot.outsideWrites,
    })),
  });
  try {
    if (lifecycle !== 'fresh') {
      previous = animate(targets, previousProps, { ...options, onComplete: () => { previousCompleteCalls++; } });
      observeFinished(previous, (state) => { previousFinished = state; });
      requireLive('setup start');
      phase = 'setup';
      for (index = 0; index < setupOffsets.length; index++) {
        timestamp = profile.clockOriginMs + setupOffsets[index];
        step('setup', index, timestamp);
        await flushReactions();
      }
      phase = 'outside';
      currentStep = null;
      await flushReactions();
      requireNoRecordedFailures();
      if ((previousFinished.status === 'fulfilled') !== (lifecycle === 'settled') || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
        throw new Error('transform: setup finished/onComplete нарушен');
      }
      for (let target = 0; target < count; target++) {
        for (let frame = 0; frame < setupOffsets.length; frame++) {
          if (slots[target].setupWrites[frame] !== 1) throw new Error('transform: setup пропустил/повторил кадр');
          checkValues(slots[target].setup[frame], interpolate(INITIAL, PREVIOUS, setupOffsets[frame] / profile.durationMs), `setup target ${target} frame ${frame}`);
        }
      }
      // После естественного завершения один drain очищает уже поставленные callbacks.
      if (lifecycle === 'settled') {
        step('settled-drain', null, timestamp + 1);
        await flushReactions();
        currentStep = null;
      }
      if (lifecycle === 'live') requireLive('setup end');
      else requirePending(0, 'setup end');
      timestamp += profile.successorGapMs;
    }
    failurePhase = 'operation';
    activeMetric = 'operationNs';
    intervalBefore = readNs('operationNs', null, 'before');
    controls = animate(targets, props, options);
    // Observer регистрируется до реакции и второго чтения часов: отказ часов не теряет finished.
    observeFinished(controls, (state) => { finished = state; });
    await flushReactions();
    intervalAfter = readNs('operationNs', null, 'after');
    operationNs = Number(intervalAfter - intervalBefore);
    activeMetric = null;
    requireLive('operation');
    requireNoRecordedFailures();
    if (finished.status === 'fulfilled' || onCompleteCalls !== 0 || (lifecycle !== 'fresh' && previousFinished.status !== 'fulfilled')) {
      throw new Error('transform: handoff finished/onComplete нарушен');
    }
    phase = 'frames';
    failurePhase = 'frame';
    for (index = 0; index < frames; index++) {
      activeMetric = 'frameNs';
      activeFrame = index;
      intervalBefore = null;
      intervalAfter = null;
      intervalBefore = readNs('frameNs', index, 'before');
      step('frame', index, timestamp + profile.frameOffsetsMs[index]);
      await flushReactions();
      intervalAfter = readNs('frameNs', index, 'after');
      frameNs[index] = Number(intervalAfter - intervalBefore);
      activeMetric = null;
      requireLive(`frame ${index}`);
    }
    phase = 'outside';
    currentStep = null;
    requireNoRecordedFailures();
    if (finished.status === 'fulfilled' || onCompleteCalls !== 0) throw new Error('transform: преждевременный finished/onComplete');
    failurePhase = 'cancel';
    activeMetric = 'cancelDrainNs';
    activeFrame = null;
    intervalBefore = null;
    intervalAfter = null;
    intervalBefore = readNs('cancelDrainNs', null, 'before');
    controls.cancel();
    step('cancel-drain', null, timestamp + profile.durationMs);
    await flushReactions();
    intervalAfter = readNs('cancelDrainNs', null, 'after');
    cancelDrainNs = Number(intervalAfter - intervalBefore);
    activeMetric = null;
    requireNoRecordedFailures();
    if (finished.status !== 'fulfilled' || onCompleteCalls !== 0 || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
      throw new Error('transform: cancel finished/onComplete нарушен');
    }
    requirePending(0, 'cancel drain');
    const idleExecutions = clock.executions;
    step('idle', null, timestamp + profile.durationMs * 2);
    step('idle', null, timestamp + profile.durationMs * 3);
    // PASS относится к состоянию после всех эффектов, включая повторную отмену обоих владельцев.
    failurePhase = 'cleanup';
    await cleanup();
    requireNoRecordedFailures();
    requirePending(0, 'cleanup');
    if (finished.status !== 'fulfilled' || onCompleteCalls !== 0 || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
      throw new Error('transform: cleanup finished/onComplete нарушен');
    }
    if (clock.executions !== idleExecutions) throw new Error('transform scheduler: stale idle callback');
    failurePhase = 'oracle';
    const targetTraceHashes = slots.map((slot, target) => {
      if (slot.outsideWrites !== 0) throw new Error(`transform: target ${target} запись вне кадра`);
      for (let frame = 0; frame < frames; frame++) {
        if (slot.writes[frame] !== 1) throw new Error(`transform: target ${target} frame ${frame} пропущен/повторён`);
        checkValues(slot.values[frame], expectedTransformValues(lifecycle, channels, profile.frameOffsetsMs[frame]), `target ${target} frame ${frame}`);
      }
      if (slot.value !== slot.values[frames - 1]) throw new Error('transform: cancel изменил последнее значение');
      return createHash('sha256').update(JSON.stringify(slot.values)).digest('hex');
    });
    failurePhase = 'timing';
    if ([operationNs, ...frameNs, cancelDrainNs].some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('transform: некорректный timing');
    }
    return { operationNs, frameNs, cancelDrainNs, raw: captureRaw(), semantic: {
      valid: true, targets: count, frames, targetTraceHashes, finished: finished.status === 'fulfilled', onCompleteCalls,
      previousFinished: lifecycle === 'fresh' ? null : previousFinished.status === 'fulfilled', previousCompleteCalls,
      requests: clock.requests, executions: clock.executions, pending: pending(),
    } };
  } catch (error) {
    // Незавершённый интервал не закрывается часами очистки и не становится успешным замером.
    const unfinishedInterval = activeMetric === null ? null : {
      metric: activeMetric, frame: activeFrame,
      beforeNs: typeof intervalBefore === 'bigint' || typeof intervalBefore === 'number' ? String(intervalBefore) : null,
      afterNs: typeof intervalAfter === 'bigint' || typeof intervalAfter === 'number' ? String(intervalAfter) : null,
    };
    const beforeCleanupSemantic = failureSemantic();
    if (!cleanupStarted) {
      try { await cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    const errors = error === recordedFailure ? [] : [error];
    errors.push(...cleanupErrors);
    for (const state of [previousFinished, finished]) {
      if (state.status === 'rejected') errors.push(state.reason);
    }
    // Снимок raw принадлежит оболочке отказа: исходный отказ может быть undefined или замороженным Error.
    const message = errors.length === 1 && errors[0] instanceof Error
      ? errors[0].message : 'transform: sample и cleanup завершились ошибкой';
    const retainTiming = (value) => value === null || Number.isFinite(value)
      ? value : { kind: 'nonfinite', value: String(value) };
    throw Object.assign(new AggregateError(errors, message), { raw: {
      ...captureRaw(), operationNs: retainTiming(operationNs), frameNs: frameNs.map(retainTiming),
      cancelDrainNs: retainTiming(cancelDrainNs), failurePhase, unfinishedInterval,
      beforeCleanupSemantic, semantic: failureSemantic(), cleanupCompleted,
    } });
  }
}
