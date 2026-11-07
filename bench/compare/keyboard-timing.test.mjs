import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installKeyboardCollector, firstInputInterval, analyzeKeyboardSamples, KEYBOARD_PLAN, nativeOrders, completedThreadCpu, analyzeNativeSamples, prepareKeyboardCpu, finishKeyboardCpu, runKeyboardSample } from './keyboard-timing.mjs';

function fixture() {
  const order = [], listeners = new Map(), timers = new Map();
  let callback, timerId = 0, disconnected = false;
  const control = { id: 'keyboard-action',
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const ack = { textContent: 'ready' };
  const env = { performance: { now: () => 10, timeOrigin: 1000 },
    document: { getElementById: id => id === control.id ? control : ack },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    PerformanceObserver: class {
      static supportedEntryTypes = ['first-input'];
      constructor(fn) { callback = fn; }
      observe(options) { order.push(['observe', options]); }
      disconnect() { disconnected = true; }
    },
  };
  const event = { type: 'keydown', key: ' ', code: 'Space', isTrusted: true, repeat: false,
    timeStamp: 20, target: control, preventDefault() {} };
  const entry = { entryType: 'first-input', name: 'keydown', startTime: 20, duration: 16,
    processingStart: 21, processingEnd: 22, interactionId: 100, targetId: control.id };
  return { env, order, listeners, timers, event, entry,
    trigger(input = event) { order.push(['trigger']); listeners.get('keydown')(input); },
    deliver(input = entry) { callback({ getEntries: () => [{ toJSON: () => input, target: control }] }); },
    disconnected: () => disconnected,
  };
}

function receipt(duration = 16) {
  return { status: 'ENTRY', before: { now: 10, timeOrigin: 1000 },
    inputAfter: { now: 150, timeOrigin: 1000 }, after: { now: 200, timeOrigin: 1000 },
    eventEvidence: [{ type: 'keydown', key: ' ', code: 'Space', isTrusted: true, repeat: false,
      timeStamp: 20, targetId: 'keyboard-action' }],
    raw: [{ entryType: 'first-input', name: 'keydown', startTime: 20, duration, processingStart: 21,
      processingEnd: 22, interactionId: 100, targetId: 'keyboard-action' }] };
}

test('collector observes buffered first-input before trusted trigger and tears down exact subscription', async () => {
  const f = fixture();
  installKeyboardCollector({ ...KEYBOARD_PLAN, kind: 'empty' }, f.env);
  f.trigger(); f.deliver();
  assert.equal(await f.env.__keyboardCapture.input, 'ENTRY');
  assert.equal((await f.env.__keyboardCapture.finished).completed, true);
  assert.deepEqual(f.order, [['observe', { type: 'first-input', buffered: true }], ['trigger']]);
  assert.equal(f.disconnected(), true);
  assert.equal(f.timers.size, 0);
  f.env.__keyboardCapture.teardown();
  assert.equal(f.listeners.size, 0);
});

test('wrong key and entry timestamp cannot claim the trigger; missing resolves only watchdog signal', async () => {
  const f = fixture(); installKeyboardCollector({ ...KEYBOARD_PLAN, kind: 'empty' }, f.env);
  f.trigger({ ...f.event, key: 'x', code: 'KeyX' }); f.deliver();
  assert.equal(f.env.__keyboardCapture.receipt().status, 'WAITING');
  f.trigger(); f.deliver({ ...f.entry, startTime: 80 });
  assert.equal(f.env.__keyboardCapture.receipt().status, 'WAITING');
  [...f.timers.values()][0]();
  assert.equal(await f.env.__keyboardCapture.input, 'MISSING');
  assert.equal(f.disconnected(), true);
  f.env.__keyboardCapture.teardown(); assert.equal(f.listeners.size, 0);
});

test('untrusted trigger never starts adapter and unavailable API has no metric fallback', async () => {
  const f = fixture(); let starts = 0;
  f.env.__adapterModule = { start() { starts++; } };
  installKeyboardCollector({ ...KEYBOARD_PLAN, kind: 'vendor' }, f.env);
  f.trigger({ ...f.event, isTrusted: false });
  assert.equal(await f.env.__keyboardCapture.input, 'UNTRUSTED'); assert.equal(starts, 0);
  const absent = fixture(); absent.env.PerformanceObserver.supportedEntryTypes = [];
  installKeyboardCollector({ ...KEYBOARD_PLAN, kind: 'empty' }, absent.env);
  assert.equal(await absent.env.__keyboardCapture.input, 'UNAVAILABLE');
  assert.equal(firstInputInterval(absent.env.__keyboardCapture.receipt()), null);
});

test('8ms rounding retains interval and processing/render decomposition', () => {
  assert.deepEqual(firstInputInterval(receipt()), { low: 12, high: 20, duration: 16,
    inputDelayMs: 1, processingMs: 1, renderingDelayMs: { low: 10, high: 18 } });
  assert.equal(firstInputInterval(receipt(0)).low, 0);
  assert.equal(firstInputInterval(receipt(17)), null);
});

for (const [name, mutate] of [
  ['untrusted', r => { r.eventEvidence[0].isTrusted = false; }],
  ['wrong key', r => { r.eventEvidence[0].key = 'x'; }],
  ['wrong target', r => { r.raw[0].targetId = 'other'; }],
  ['other entry type', r => { r.raw[0].entryType = 'event'; }],
  ['wrong event identity', r => { r.raw[0].startTime = 80; }],
  ['missing', r => { r.status = 'MISSING'; r.raw = []; }],
  ['wrong realm', r => { r.after.timeOrigin = 2000; }],
  ['invalid processing', r => { r.raw[0].processingEnd = 100; }],
  ['duplicate first input', r => { r.raw.push({ ...r.raw[0] }); }],
]) test(`interval rejects ${name} without API/rAF substitute`, () => {
  const value = receipt(); mutate(value); assert.equal(firstInputInterval(value), null);
});

const invalidReceipts = [
  ...['before', 'inputAfter', 'after', 'raw', 'eventEvidence'].map(field =>
    [field, r => { delete r[field]; }]),
  ...['before', 'inputAfter', 'after'].flatMap(probe => ['now', 'timeOrigin'].flatMap(field =>
    [-1, NaN, Infinity, -Infinity].map(value =>
      [`${probe}.${field}=${value}`, r => { r[probe][field] = value; }]))),
  ['resolution before subscription', r => { r.inputAfter.now = 9; }],
  ['resolution after final probe', r => { r.inputAfter.now = 201; }],
  ['resolution realm mismatch', r => { r.inputAfter.timeOrigin = 2000; }],
  ['processing after resolution', r => { r.inputAfter.now = 21; }],
  ['render lower after resolution', r => { r.inputAfter.now = 31; }],
  ['wrong duration resolution', r => { r.raw[0].duration = 17; }],
  ['nonarray raw', r => { r.raw = {}; }],
  ['nonarray event evidence', r => { r.eventEvidence = {}; }],
];
for (const [name, mutate] of invalidReceipts) test(`malformed receipt ${name} is retained and inconclusive`, () => {
  const value = receipt(); mutate(value);
  const snapshot = structuredClone(value);
  assert.equal(firstInputInterval(value), null);
  const samples = Array.from({ length: 66 }, (_, index) => ({ kind: index < 3 ? 'empty' : 'blocking', useful: true, receipt: value }));
  assert.equal(analyzeKeyboardSamples(samples).status, 'INCONCLUSIVE');
  assert.deepEqual(value, snapshot);
});

test('bare ENTRY receipt and null collection members are rejected without throwing', () => {
  assert.equal(firstInputInterval({ status: 'ENTRY' }), null);
  const value = receipt(); value.raw = [null]; value.eventEvidence = [null];
  assert.equal(firstInputInterval(value), null);
});

test('analysis retains missing/inconclusive instead of reducing paired denominator', () => {
  assert.equal(analyzeKeyboardSamples([]).status, 'INCONCLUSIVE');
});

test('vendor completion subscription exists in handler before control is returned to caller', async () => {
  const f = fixture(); let complete, subscribed = false;
  const signal = new Promise(resolve => { complete = resolve; });
  f.env.__adapterModule = { start() { return { finished() { subscribed = true; return signal; } }; } };
  installKeyboardCollector({ ...KEYBOARD_PLAN, kind: 'vendor' }, f.env);
  f.trigger(); assert.equal(subscribed, true);
  complete(); f.deliver();
  assert.equal((await f.env.__keyboardCapture.finished).completed, true);
  f.env.__keyboardCapture.teardown();
});

test('fixed blocking control keeps deterministic computational result', async () => {
  const f = fixture(); installKeyboardCollector({ ...KEYBOARD_PLAN, kind: 'blocking', blockingIterations: 4 }, f.env);
  f.trigger();
  let checksum = 1;
  for (let i = 0; i < 4; i++) checksum = Math.imul(checksum ^ i, 1664525) + 1013904223 | 0;
  assert.equal(f.env.__blockingChecksum, checksum);
  assert.equal((await f.env.__keyboardCapture.finished).completed, true);
  f.env.__keyboardCapture.teardown();
});

test('analysis enforces round identity, useful parity and sensor discrimination on full fixed denominator', () => {
  const samples = [];
  for (let round = 0; round < 3; round++) {
    samples.push({ kind: 'empty', round, useful: true, receipt: receipt(16) });
    const blocking = receipt(48); blocking.raw[0].processingEnd = 41;
    samples.push({ kind: 'blocking', round, useful: true, receipt: blocking });
  }
  for (let round = 0; round < 20; round++) for (const id of KEYBOARD_PLAN.vendors)
    samples.push({ kind: 'vendor', round, id, useful: true, receipt: receipt(80) });
  const result = analyzeKeyboardSamples(samples);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.comparisons.length, 2);
  assert.ok(result.comparisons.every(c => !c.losingCase && !c.nonInferior));
  samples[6].useful = false;
  assert.equal(analyzeKeyboardSamples(samples).comparisons, undefined);
  samples[6].useful = true; samples[6].round = 1;
  assert.equal(analyzeKeyboardSamples(samples).comparisons, undefined);
});

test('native insertion preserves root relative order and balances each position five times', () => {
  const roots = Array.from({ length: 20 }, () => ['lab', 'motion', 'anime']);
  const expanded = nativeOrders(roots);
  assert.deepEqual(expanded.map(order => order.filter(id => id !== 'lab-native')), roots);
  assert.deepEqual([0, 1, 2, 3].map(position => expanded.filter(order => order[position] === 'lab-native').length), [5, 5, 5, 5]);
});

test('threadTicks ledger excludes geometry gap and rejects unavailable/regressing clocks', () => {
  const raw = { before: { ThreadTime: 1 }, afterAnimation: { ThreadTime: 1.125 },
    beforeCleanup: { ThreadTime: 2 }, afterCleanup: { ThreadTime: 2.0625 } };
  assert.equal(completedThreadCpu(raw), 187.5);
  assert.equal(completedThreadCpu({}), null);
  raw.afterCleanup.ThreadTime = 1;
  assert.equal(completedThreadCpu(raw), null);
  raw.afterCleanup.ThreadTime = NaN;
  assert.equal(completedThreadCpu(raw), null);
});

for (const stage of ['before', 'afterAnimation', 'beforeCleanup', 'afterCleanup']) {
  for (const value of [undefined, NaN, Infinity, -Infinity, -1]) test(`CPU stage ${stage} rejects ${value}`, () => {
    const raw = { before: { ThreadTime: 1 }, afterAnimation: { ThreadTime: 2 },
      beforeCleanup: { ThreadTime: 3 }, afterCleanup: { ThreadTime: 4 } };
    if (value === undefined) delete raw[stage]; else raw[stage].ThreadTime = value;
    assert.equal(completedThreadCpu(raw), null);
  });
  test(`CPU stage ${stage} rejects nonmonotonic clocks`, () => {
    const raw = { before: { ThreadTime: 1 }, afterAnimation: { ThreadTime: 2 },
      beforeCleanup: { ThreadTime: 3 }, afterCleanup: { ThreadTime: 4 } };
    raw[stage].ThreadTime = stage === 'before' ? 5 : 0;
    assert.equal(completedThreadCpu(raw), null);
  });
}

function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve };
}

async function integratedNativeSample(failure) {
  const f = fixture(), order = [], triggered = deferred(), completion = deferred();
  const frames = Array.from({ length: 4 }, deferred);
  let nextFrame = 0, threadTime = 1, clock = 10, metricStage, activeEffects = 0;
  const cpu = { status: 'UNAVAILABLE', raw: {}, errors: [] };
  f.env.performance.now = () => clock;
  f.env.__targets = Array.from({ length: 1000 }, (_, index) => ({ index, remove() { order.push('remove-target'); } }));
  f.env.__adapterModule = { start() {
    order.push('start'); threadTime += 0.125; activeEffects = 1;
    return { finished() { order.push('subscribe-finished'); return completion.promise; },
      cancel() { order.push('cancel'); threadTime += 0.0625; activeEffects = 0; } };
  } };
  const oldGetElement = f.env.document.getElementById;
  f.env.document.getElementById = id => {
    const element = oldGetElement(id);
    element.remove = () => { order.push('remove-control'); };
    return element;
  };
  f.env.document.getAnimations = () => Array.from({ length: activeEffects }, () => ({}));
  const originalObserve = f.env.PerformanceObserver.prototype.observe;
  f.env.PerformanceObserver.prototype.observe = function(options) { order.push('observe-input'); originalObserve.call(this, options); };
  const context = { async newCDPSession() { return { async send(method, options) {
    if (method === 'Performance.enable') {
      order.push('enable'); assert.deepEqual(options, { timeDomain: 'threadTicks' });
      if (failure === 'enable') throw new Error('enable failure');
      return {};
    }
    assert.equal(method, 'Performance.getMetrics'); order.push(`metrics-${metricStage}`);
    if (failure === metricStage) throw new Error(`metrics ${metricStage} failure`);
    return { metrics: [{ name: 'ThreadTime', value: threadTime }] };
  } }; } };
  const page = {
    async exposeFunction(name, fn) {
      f.env[name] = async stage => { metricStage = stage; return fn(stage); };
    },
    async evaluate(fn, config) {
      if (fn === installKeyboardCollector) { order.push('install'); return fn(config, f.env); }
      return fn(config);
    },
    keyboard: { async press(key) {
      assert.equal(key, 'Space'); order.push('Space'); clock = 20; f.trigger(); triggered.resolve();
    } },
  };
  const globals = { window: f.env, document: f.env.document,
    requestAnimationFrame: callback => { const index = nextFrame++; order.push(`request-frame-${index}`); frames[index].resolve(callback); },
    setTimeout: f.env.setTimeout, clearTimeout: f.env.clearTimeout,
    getComputedStyle: element => {
      order.push('geometry'); threadTime += 0.001; return { transform: String(element.index) };
    },
    DOMMatrixReadOnly: class { constructor() { this.e = 300; } },
  };
  const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    await prepareKeyboardCpu(context, page, cpu);
    const running = runKeyboardSample(page, { ...KEYBOARD_PLAN, kind: 'vendor', nativeDiscriminator: true });
    await triggered.promise;
    // Exact input and public finished signals, then four exact frame callbacks.
    clock = 40; order.push('input-delivery'); f.deliver();
    order.push('finished-delivery'); completion.resolve();
    for (let index = 0; index < frames.length; index++) {
      const callback = await frames[index].promise; order.push(`frame-${index}`); callback(40 + index * 16);
    }
    const result = await running; finishKeyboardCpu(cpu);
    assert.equal(result.receipt.status, 'ENTRY');
    assert.deepEqual(result.endpoint, { count: 1000, finite: true, maxError: 0 });
    assert.equal(result.useful, true); assert.equal(result.effects, 0); assert.equal(result.finished.completed, true);
    assert.equal(f.listeners.size, 0); assert.equal(f.timers.size, 0);
    const before = (a, b) => {
      assert.ok(order.includes(a) && order.includes(b));
      assert.ok(order.indexOf(a) < order.indexOf(b), `${a} must precede ${b}`);
    };
    before('metrics-before', 'install'); before('install', 'observe-input'); before('observe-input', 'Space');
    before('subscribe-finished', 'input-delivery'); before('input-delivery', 'metrics-afterAnimation');
    before('finished-delivery', 'frame-0'); before('frame-1', 'metrics-afterAnimation');
    before('metrics-afterAnimation', 'geometry');
    assert.ok(order.lastIndexOf('geometry') < order.indexOf('metrics-beforeCleanup'));
    before('metrics-beforeCleanup', 'cancel'); before('cancel', 'remove-target');
    assert.ok(order.lastIndexOf('remove-control') < order.indexOf('frame-2'));
    before('frame-3', 'metrics-afterCleanup');
    return { result, cpu, order };
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('actual native CPU bridge + sample excludes geometry and preserves exact observer/completion order', { timeout: 2000 }, async () => {
  const { cpu } = await integratedNativeSample();
  assert.equal(cpu.status, 'AVAILABLE');
  assert.ok(Math.abs(cpu.raw.beforeCleanup.ThreadTime - cpu.raw.afterAnimation.ThreadTime - 1) < 1e-9);
  assert.ok(Math.abs(cpu.threadCpuMs - 187.5) < 1e-9);
});
for (const stage of ['enable', 'before', 'afterAnimation', 'beforeCleanup', 'afterCleanup'])
  test(`actual CPU owner ${stage} failure retains ENTRY/endpoints/cleanup and UNAVAILABLE`, { timeout: 2000 }, async () => {
    const { cpu } = await integratedNativeSample(stage);
    assert.equal(cpu.status, 'UNAVAILABLE'); assert.equal(cpu.errors.length, 1);
    assert.match(cpu.errors[0], /failure/);
    if (stage !== 'enable') assert.equal(cpu.raw[stage], undefined);
    assert.ok(Object.keys(cpu.raw).length >= 3);
  });

test('native analysis preserves original vendor family and requires same-job CPU protection', () => {
  const samples = [];
  for (let round = 0; round < 3; round++) {
    samples.push({ kind: 'empty', round, useful: true, receipt: receipt(16) });
    const blocking = receipt(48); blocking.raw[0].processingEnd = 41;
    samples.push({ kind: 'blocking', round, useful: true, receipt: blocking });
  }
  for (let round = 0; round < 20; round++) for (const id of ['lab', 'motion', 'anime', 'lab-native'])
    samples.push({ kind: 'vendor', round, id, useful: true, receipt: receipt(id === 'lab-native' ? 32 : 80),
      cpu: { status: 'AVAILABLE', raw: { before: { ThreadTime: 1 }, afterAnimation: { ThreadTime: 1.125 },
        beforeCleanup: { ThreadTime: 2 }, afterCleanup: { ThreadTime: 2.0625 } } } });
  const result = analyzeNativeSamples(samples);
  assert.deepEqual(result.original, analyzeKeyboardSamples(samples.filter(s => s.id !== 'lab-native')));
  assert.equal(result.status, 'STRUCTURAL_PROPOSAL_JUSTIFIED');
  samples.find(s => s.id === 'lab-native').cpu = { status: 'UNAVAILABLE', raw: {} };
  const unavailable = analyzeNativeSamples(samples);
  assert.equal(unavailable.status, 'CPU_TRADEOFF_UNRESOLVED');
  assert.equal(unavailable.cpu.status, 'UNAVAILABLE');
  assert.equal(analyzeNativeSamples(samples.slice(1)).status, 'INCONCLUSIVE');
});
