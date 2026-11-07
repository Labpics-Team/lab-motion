import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureBoundary, captureObserver, qualifyCapture } from './capture-boundaries.mjs';

test('counter observer preserves original once, receiver, return and nested call', () => {
  captureObserver.begin(false);
  const style = { calls: 0, getPropertyValue() { assert.equal(this, style); this.calls++; return 'none'; } };
  const result = captureBoundary('styles', () => {
    assert.equal(captureBoundary('transformProperty', () => style.getPropertyValue('transform')), 'none');
    return style;
  });
  assert.equal(result, style);
  assert.equal(style.calls, 1);
  const snapshot = captureObserver.snapshot();
  assert.equal(snapshot.boundaries.styles.calls, 1);
  assert.equal(snapshot.boundaries.styles.returned, 1);
  assert.equal(snapshot.boundaries.transformProperty.calls, 1);
  assert.equal(snapshot.boundaries.matrixDecode.calls, 0);
  assert.equal(snapshot.boundaries.styles.spans.length, 1);
  assert.equal(snapshot.boundaries.styles.spans[0].elapsedMs, null);
  assert.equal(snapshot.boundaries.transformProperty.inputs.none, 1);
});

test('throw identity and synchronous nested successor are not replaced', () => {
  captureObserver.begin(false);
  const failure = new Error('original'), events = [];
  assert.throws(() => captureBoundary('styles', () => {
    events.push('outer');
    captureBoundary('styles', () => { events.push('successor'); return 42; });
    throw failure;
  }), error => error === failure);
  assert.deepEqual(events, ['outer', 'successor']);
  const bucket = captureObserver.snapshot().boundaries.styles;
  assert.equal(bucket.calls, 2);
  assert.equal(bucket.returned, 1);
  assert.equal(bucket.threw, 1);
});

test('sparse clock counts are explicit and batch resets separate warmup', () => {
  captureObserver.begin(true);
  for (let i = 0; i < 130; i++) assert.equal(captureBoundary('transformProperty', () => i), i);
  captureObserver.timerControl();
  const snapshot = captureObserver.snapshot();
  assert.deepEqual(snapshot.boundaries.transformProperty.spans.map(span => span.call), [1, 65, 129]);
  assert.equal(snapshot.timerControl.length, 16);
  assert.equal(snapshot.clockErrors, 0);
  assert.equal(snapshot.boundaries.transformProperty.returned, 130);
  captureObserver.begin(false);
  assert.equal(captureObserver.snapshot().boundaries.transformProperty.calls, 0);
});

function captureInputs(timing) {
  captureObserver.begin(timing);
  for (const value of ['', 'none', 'matrix(1, 0, 0, 1, 30, 40)']) {
    const style = captureBoundary('styles', () => ({ getPropertyValue: () => value }));
    const text = captureBoundary('transformProperty', () => style.getPropertyValue('transform'));
    if (text && text !== 'none') captureBoundary('matrixDecode', () => ({ x: 30, y: 40 }));
  }
  captureObserver.timerControl();
  return captureObserver.snapshot();
}

test('engagement rejects empty observation, missing buckets, wrong mode and missing decoder', () => {
  captureObserver.begin(false);
  assert.equal(qualifyCapture(captureObserver.snapshot(), 'counter'), false);
  const evidence = captureInputs(false);
  assert.equal(qualifyCapture(evidence, 'counter', true), true);
  assert.equal(qualifyCapture(evidence, 'sparse'), false);
  const missing = structuredClone(evidence); delete missing.boundaries.styles;
  assert.equal(qualifyCapture(missing, 'counter'), false);
  const noDecoder = structuredClone(evidence);
  noDecoder.boundaries.matrixDecode = { calls: 0, returned: 0, threw: 0, spans: [] };
  assert.equal(qualifyCapture(noDecoder, 'counter', true), false);
  const overflow = structuredClone(evidence); overflow.overflow = 1;
  assert.equal(qualifyCapture(overflow, 'counter'), false);
  const unknownClock = structuredClone(evidence); unknownClock.clockErrors = 1;
  assert.equal(qualifyCapture(unknownClock, 'counter'), false);
});

test('actual single-return input partition and equal mode record shapes', () => {
  const counter = captureInputs(false), sparse = captureInputs(true);
  assert.equal(qualifyCapture(counter, 'counter', true), true);
  assert.equal(qualifyCapture(sparse, 'sparse', true), true);
  assert.deepEqual(counter.boundaries.transformProperty.inputs, { empty: 1, none: 1, nonidentity: 1, unknown: 0 });
  for (const name of ['styles', 'transformProperty', 'matrixDecode']) {
    assert.equal(counter.boundaries[name].spans.length, sparse.boundaries[name].spans.length);
    assert.deepEqual(counter.boundaries[name].spans.map(s => s.call), sparse.boundaries[name].spans.map(s => s.call));
  }
  assert.equal(counter.timerControl.length, sparse.timerControl.length);
  assert.ok(counter.timerControl.every(pair => pair.elapsedMs === null && !pair.timed));
  assert.ok(sparse.timerControl.every(pair => Number.isFinite(pair.elapsedMs) && pair.timed));
  captureObserver.begin(false);
  captureBoundary('transformProperty', () => undefined);
  const failure = new Error('property');
  assert.throws(() => captureBoundary('transformProperty', () => { throw failure; }), error => error === failure);
  const bucket = captureObserver.snapshot().boundaries.transformProperty;
  assert.equal(bucket.inputs.unknown, 1);
  assert.equal(bucket.threw, 1);
  assert.equal(bucket.returned + bucket.threw, 2);
});
