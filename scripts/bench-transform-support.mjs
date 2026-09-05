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

export async function runTransformLifecycleSample({ animate, count, lifecycle, channels, nowNs = () => process.hrtime.bigint() }) {
  const profile = TRANSFORM_PAIR_PROFILE;
  if (typeof animate !== 'function' || !profile.counts.includes(count) ||
      !profile.lifecycles.includes(lifecycle) || !profile.channels.includes(channels)) {
    throw new Error('transform lifecycle: вход вне фиксированного профиля');
  }
  const clock = createBenchClock();
  const frames = profile.frameOffsetsMs.length;
  const setupOffsets = lifecycle === 'settled' ? profile.previousSettledOffsetsMs : profile.previousLiveOffsetsMs;
  const slots = Array.from({ length: count }, () => ({
    value: '', setup: new Array(setupOffsets.length), setupWrites: new Uint32Array(setupOffsets.length),
    values: new Array(frames), writes: new Uint32Array(frames), outsideWrites: 0,
  }));
  let phase = 'outside';
  let index = -1;
  const targets = slots.map((slot) => ({ style: {
    getPropertyValue: (name) => name === 'transform' ? slot.value : '',
    setProperty(name, value) {
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
  const pending = () => clock.requests - clock.executions;
  const requirePending = (expected, label) => {
    if (pending() !== expected) throw new Error(`transform scheduler: ${label} pending=${pending()}, ожидалось ${expected}`);
  };
  const requireLive = (label) => {
    if (pending() <= 0) throw new Error(`transform scheduler: ${label} отсутствует следующий callback`);
  };
  const frameNs = new Array(frames);
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
  const cleanup = async () => {
    cleanupStarted = true;
    phase = 'outside';
    // Каждый владелец и drain получают попытку очистки; throw undefined тоже сохраняется.
    try { controls?.cancel(); } catch (error) { cleanupErrors.push(error); }
    try { previous?.cancel(); } catch (error) { cleanupErrors.push(error); }
    for (let drain = 0; drain < 4 && pending() > 0; drain++) {
      try { clock.step(timestamp + profile.durationMs * (4 + drain)); } catch (error) { cleanupErrors.push(error); }
    }
    await flushReactions();
  };
  try {
    if (lifecycle !== 'fresh') {
      previous = animate(targets, previousProps, { ...options, onComplete: () => { previousCompleteCalls++; } });
      observeFinished(previous, (state) => { previousFinished = state; });
      requireLive('setup start');
      phase = 'setup';
      for (index = 0; index < setupOffsets.length; index++) {
        timestamp = profile.clockOriginMs + setupOffsets[index];
        clock.step(timestamp);
      }
      phase = 'outside';
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
      if (lifecycle === 'settled') clock.step(timestamp + 1);
      if (lifecycle === 'live') requireLive('setup end');
      else requirePending(0, 'setup end');
      timestamp += profile.successorGapMs;
    }
    const operationBefore = nowNs();
    controls = animate(targets, props, options);
    let operationNs;
    try { operationNs = Number(nowNs() - operationBefore); } finally {
      // Observer не входит в operation timing, но нужен даже при отказе часов.
      observeFinished(controls, (state) => { finished = state; });
    }
    requireLive('operation');
    await flushReactions();
    requireNoRecordedFailures();
    if (finished.status === 'fulfilled' || onCompleteCalls !== 0 || (lifecycle !== 'fresh' && previousFinished.status !== 'fulfilled')) {
      throw new Error('transform: handoff finished/onComplete нарушен');
    }
    phase = 'frames';
    for (index = 0; index < frames; index++) {
      const before = nowNs();
      clock.step(timestamp + profile.frameOffsetsMs[index]);
      frameNs[index] = Number(nowNs() - before);
      requireLive(`frame ${index}`);
    }
    phase = 'outside';
    await flushReactions();
    requireNoRecordedFailures();
    if (finished.status === 'fulfilled' || onCompleteCalls !== 0) throw new Error('transform: преждевременный finished/onComplete');
    const cancelBefore = nowNs();
    controls.cancel();
    clock.step(timestamp + profile.durationMs);
    const cancelDrainNs = Number(nowNs() - cancelBefore);
    await flushReactions();
    requireNoRecordedFailures();
    if (finished.status !== 'fulfilled' || onCompleteCalls !== 0 || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
      throw new Error('transform: cancel finished/onComplete нарушен');
    }
    requirePending(0, 'cancel drain');
    const idleExecutions = clock.executions;
    clock.step(timestamp + profile.durationMs * 2);
    clock.step(timestamp + profile.durationMs * 3);
    // PASS относится к состоянию после всех эффектов, включая повторную отмену обоих владельцев.
    await cleanup();
    requireNoRecordedFailures();
    requirePending(0, 'cleanup');
    if (finished.status !== 'fulfilled' || onCompleteCalls !== 0 || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
      throw new Error('transform: cleanup finished/onComplete нарушен');
    }
    if (clock.executions !== idleExecutions) throw new Error('transform scheduler: stale idle callback');
    const targetTraceHashes = slots.map((slot, target) => {
      if (slot.outsideWrites !== 0) throw new Error(`transform: target ${target} запись вне кадра`);
      for (let frame = 0; frame < frames; frame++) {
        if (slot.writes[frame] !== 1) throw new Error(`transform: target ${target} frame ${frame} пропущен/повторён`);
        checkValues(slot.values[frame], expectedTransformValues(lifecycle, channels, profile.frameOffsetsMs[frame]), `target ${target} frame ${frame}`);
      }
      if (slot.value !== slot.values[frames - 1]) throw new Error('transform: cancel изменил последнее значение');
      return createHash('sha256').update(JSON.stringify(slot.values)).digest('hex');
    });
    if ([operationNs, ...frameNs, cancelDrainNs].some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('transform: некорректный timing');
    }
    return { operationNs, frameNs, cancelDrainNs, semantic: {
      valid: true, targets: count, frames, targetTraceHashes, finished: finished.status === 'fulfilled', onCompleteCalls,
      previousFinished: lifecycle === 'fresh' ? null : previousFinished.status === 'fulfilled', previousCompleteCalls,
      requests: clock.requests, executions: clock.executions, pending: pending(),
    } };
  } catch (error) {
    if (!cleanupStarted) await cleanup();
    const errors = error === recordedFailure ? [] : [error];
    errors.push(...cleanupErrors);
    for (const state of [previousFinished, finished]) {
      if (state.status === 'rejected') errors.push(state.reason);
    }
    if (error !== recordedFailure && errors.length === 1) throw error;
    throw new AggregateError(errors, 'transform: sample и cleanup завершились ошибкой');
  }
}
