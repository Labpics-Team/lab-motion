import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installKeyboardCollector, firstInputInterval, analyzeKeyboardSamples, KEYBOARD_PLAN } from './keyboard-timing.mjs';

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
