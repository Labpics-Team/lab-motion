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
  statistics: 'empirical nearest-rank p50/p95/p99; no confidence bounds or tail guarantee',
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
  const from = lifecycle === 'fresh' ? INITIAL : interpolate(INITIAL, PREVIOUS, lifecycle === 'live' ? 0.25 : 1);
  const to = channels === 7 ? DESTINATION : { ...from, x: DESTINATION.x };
  return interpolate(from, to, offsetMs / TRANSFORM_PAIR_PROFILE.durationMs);
}

/** Чтение значений CSS независимо от ветвления formatter измеряемого пакета. */
function readTransform(text) {
  const state = { ...INITIAL };
  if (text === 'none') return state;
  if (typeof text !== 'string' || text.length === 0) throw new Error('transform: отсутствует CSS');
  let end = 0;
  const seen = new Set();
  for (const token of text.matchAll(/([A-Za-z]+)\(([^)]*)\)/g)) {
    if (text.slice(end, token.index).trim()) throw new Error('transform: посторонний CSS');
    end = token.index + token[0].length;
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
    value: '', setup: new Array(3), setupWrites: new Uint32Array(3),
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
  let previousFinished = false;
  let finished = false;
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
  const frameNs = new Array(frames);
  try {
    if (lifecycle !== 'fresh') {
      previous = animate(targets, previousProps, { ...options, onComplete: () => { previousCompleteCalls++; } });
      void previous.finished.then(() => { previousFinished = true; });
      requirePending(1, 'setup start');
      phase = 'setup';
      for (index = 0; index < setupOffsets.length; index++) {
        timestamp = profile.clockOriginMs + setupOffsets[index];
        clock.step(timestamp);
      }
      phase = 'outside';
      await flushReactions();
      if (previousFinished !== (lifecycle === 'settled') || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
        throw new Error('transform: setup finished/onComplete нарушен');
      }
      for (let target = 0; target < count; target++) {
        for (let frame = 0; frame < setupOffsets.length; frame++) {
          if (slots[target].setupWrites[frame] !== 1) throw new Error('transform: setup пропустил/повторил кадр');
          checkValues(slots[target].setup[frame], interpolate(INITIAL, PREVIOUS, setupOffsets[frame] / profile.durationMs), `setup target ${target} frame ${frame}`);
        }
      }
      // После естественного завершения допустим единственный уже поставленный callback.
      if (lifecycle === 'settled') clock.step(timestamp + 1);
      requirePending(lifecycle === 'live' ? 1 : 0, 'setup end');
      timestamp += profile.successorGapMs;
    }
    const operationBefore = nowNs();
    controls = animate(targets, props, options);
    const operationNs = Number(nowNs() - operationBefore);
    void controls.finished.then(() => { finished = true; });
    requirePending(lifecycle === 'live' ? 2 : 1, 'operation');
    await flushReactions();
    if (finished || onCompleteCalls !== 0 || (lifecycle !== 'fresh' && !previousFinished)) {
      throw new Error('transform: handoff finished/onComplete нарушен');
    }
    phase = 'frames';
    for (index = 0; index < frames; index++) {
      const before = nowNs();
      clock.step(timestamp + profile.frameOffsetsMs[index]);
      frameNs[index] = Number(nowNs() - before);
      requirePending(1, `frame ${index}`);
    }
    phase = 'outside';
    await flushReactions();
    if (finished || onCompleteCalls !== 0) throw new Error('transform: преждевременный finished/onComplete');
    const cancelBefore = nowNs();
    controls.cancel();
    clock.step(timestamp + profile.durationMs);
    const cancelDrainNs = Number(nowNs() - cancelBefore);
    await flushReactions();
    if (!finished || onCompleteCalls !== 0 || previousCompleteCalls !== (lifecycle === 'settled' ? 1 : 0)) {
      throw new Error('transform: cancel finished/onComplete нарушен');
    }
    requirePending(0, 'cancel drain');
    const idleExecutions = clock.executions;
    clock.step(timestamp + profile.durationMs * 2);
    clock.step(timestamp + profile.durationMs * 3);
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
      valid: true, targets: count, frames, targetTraceHashes, finished, onCompleteCalls,
      previousFinished: lifecycle === 'fresh' ? null : previousFinished, previousCompleteCalls,
      requests: clock.requests, executions: clock.executions, pending: pending(),
    } };
  } finally {
    // Даже отвергнутый sample освобождает оба владельца и очередь, без глобальных швов.
    phase = 'outside';
    try { controls?.cancel(); } finally {
      try { previous?.cancel(); } finally {
        for (let drain = 0; drain < 4 && pending() > 0; drain++) clock.step(timestamp + profile.durationMs * (4 + drain));
        await flushReactions();
      }
    }
  }
}
