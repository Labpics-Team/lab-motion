import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bounded, traceObserver, inventory, recordProperties, mutationControls, finalizeBoundary, CONFIG } from './s5-cdp-boundary-probe.mjs';

function deadlineDriver() {
  const pending = new Map(); let next = 0;
  return { setTimeout(fn) { pending.set(++next, fn); return next; },
    clearTimeout(id) { pending.delete(id); },
    fire() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    get size() { return pending.size; } };
}

function control(send) {
  const cdp = new EventEmitter();
  cdp.send = send;
  const timers = deadlineDriver(), snapshots = [];
  const observer = traceObserver(cdp, state => snapshots.push(structuredClone(state)), timers);
  return { cdp, timers, snapshots, observer };
}

test('complete stream is subscribed before commands and records parsed fragments/config', async () => {
  let c;
  c = control(async (method, params) => {
    assert.equal(c.cdp.listenerCount('Tracing.dataCollected'), 1);
    assert.equal(c.cdp.listenerCount('Tracing.tracingComplete'), 1);
    if (method === 'Tracing.start') {
      assert.deepEqual(params, CONFIG);
      c.cdp.emit('Tracing.dataCollected', { value: [{ name: 'native-event' }] });
    } else c.cdp.emit('Tracing.tracingComplete', { dataLossOccurred: false });
    return {};
  });
  await c.observer.start(); await c.observer.stop();
  assert.equal(c.observer.state.status, 'complete');
  assert.equal(c.observer.state.fragments[0].value[0].name, 'native-event');
  assert.equal(c.timers.size, 0);
  c.observer.detach();
  assert.equal(c.cdp.listenerCount('Tracing.dataCollected'), 0);
});

test('start rejection retains command error and partial data', async () => {
  let c;
  c = control(async () => {
    c.cdp.emit('Tracing.dataCollected', { value: [{ name: 'partial' }] });
    throw new Error('start failed');
  });
  await assert.rejects(c.observer.start(), /start failed/);
  assert.equal(c.observer.state.status, 'incomplete');
  assert.equal(c.observer.state.commands[0].status, 'failed');
  assert.equal(c.observer.state.fragments.length, 1);
  assert.equal(c.observer.state.errors.length, 1);
  c.observer.detach();
});

test('end rejection clears completion timer and preserves incomplete trace', async () => {
  const c = control(async method => { if (method === 'Tracing.end') throw new Error('end failed'); });
  await c.observer.start();
  await assert.rejects(c.observer.stop(), /end failed/);
  assert.equal(c.observer.state.status, 'incomplete');
  assert.equal(c.timers.size, 0);
  c.observer.detach();
});

test('missing completion is bounded after successful end', async () => {
  let endSubscribed;
  const endSent = new Promise(resolve => { endSubscribed = resolve; });
  const c = control(async method => { if (method === 'Tracing.end') endSubscribed(); });
  await c.observer.start();
  const stopping = c.observer.stop();
  const rejected = assert.rejects(stopping, /deadline/);
  await endSent; c.timers.fire(); await rejected;
  assert.equal(c.observer.state.status, 'incomplete');
  assert.ok(c.observer.state.errors.length > 0);
  c.observer.detach();
});

test('completion loss cannot declare a complete observation', async () => {
  let c;
  c = control(async method => {
    if (method === 'Tracing.end') c.cdp.emit('Tracing.tracingComplete', { dataLossOccurred: true });
  });
  await c.observer.start(); await c.observer.stop();
  assert.equal(c.observer.state.status, 'incomplete');
  c.observer.detach();
});

test('pending end deadline retains incomplete state without sleep or polling', async () => {
  let c, endSubscribed;
  const endSent = new Promise(resolve => { endSubscribed = resolve; });
  c = control(method => {
    if (method === 'Tracing.start') return Promise.resolve({});
    endSubscribed(); return new Promise(() => {});
  });
  await c.observer.start();
  c.cdp.emit('Tracing.dataCollected', { value: [{ name: 'partial' }] });
  const stopping = c.observer.stop();
  const rejected = assert.rejects(stopping, /deadline/);
  await endSent; c.timers.fire(); await rejected;
  assert.equal(c.observer.state.status, 'incomplete');
  assert.equal(c.observer.state.fragments.length, 1);
  assert.equal(c.observer.state.commands[1].status, 'failed');
  assert.ok(c.observer.state.errors.length > 0);
  c.observer.detach();
});

test('bounded synchronous failure and deadline clean timer resources', async () => {
  const timers = deadlineDriver();
  await assert.rejects(bounded(() => { throw new Error('bad'); }, 'x', 1, timers), /bad/);
  assert.equal(timers.size, 0);
  const waiting = bounded(() => new Promise(() => {}), 'x', 1, timers);
  const rejected = assert.rejects(waiting, /deadline/);
  timers.fire(); await rejected;
  assert.equal(timers.size, 0);
});

test('inventory preserves field types, rejects unsafe numbers, never claims uint64 fidelity', () => {
  const result = inventory([{ id: Number.MAX_SAFE_INTEGER + 1, id2: { local: 'a' }, ts: 1.25 }]);
  assert.equal(result.numericIdentityAccepted, false);
  assert.deepEqual(result.unsafeNumbers, [{ eventIndex: 0, path: '$.id' }]);
  assert.equal(result.fields['$.id2.local'].string, 1);
  assert.equal(result.rawWireBytesRetained, false);
});

test('actual finalization and CLI predicate enforce marker/native/transport controls', () => {
  const token = 'boundary-control';
  const markers = ['A:start', 'A:end', 'B:start', 'B:end'].map(label =>
    ({ name: 'TimeStamp', args: { data: { message: `${token}:${label}` } } }));
  const valid = () => ({ metadata: { markerToken: token }, errors: [],
    pages: ['A', 'B'].map(label => ({ label, status: 'complete', playState: 'finished' })),
    properties: { reporters: 0, feedback: 0 }, presentationProof: 'unresolved',
    trace: { status: 'complete', completion: { dataLossOccurred: false }, fragments: [{ value: structuredClone(markers) }] } });
  const positive = valid();
  assert.equal(finalizeBoundary(positive), 0);
  assert.equal(positive.status, 'complete');
  assert.equal(positive.transportStatus, 'complete');
  assert.equal(positive.controls.producer, 'unresolved');
  assert.equal(positive.presentationProof, 'unresolved');
  for (const mutate of [
    report => report.trace.fragments[0].value.pop(),
    report => report.trace.fragments[0].value.push(structuredClone(markers[0])),
    report => { report.trace.status = 'incomplete'; },
    report => { report.trace.completion.dataLossOccurred = true; },
    report => report.errors.push({ phase: 'probe', message: 'failed' }),
    report => { report.pages[1].status = 'failed'; },
    report => { report.pages[1].playState = 'running'; },
    report => { report.pages[1].label = 'A'; },
    report => report.trace.fragments[0].value.push({ id: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    const report = valid(); mutate(report);
    const before = structuredClone(report.trace.fragments);
    assert.equal(finalizeBoundary(report), 1);
    assert.equal(report.status, 'incomplete');
    assert.deepEqual(report.trace.fragments, before);
    assert.equal(report.presentationProof, 'unresolved');
  }
});

test('record mutation controls change machine properties, not presentation ownership', () => {
  const events = [{ name: 'PipelineReporter', ph: 'b', id: 'a', ts: 1, args: { control: 1 } },
    { name: 'SwapEndToPresentationCompositorFrame', ph: 'e', id: 'a', ts: 2 }];
  const result = mutationControls(events);
  assert.equal(result.missingReporterArgs.reportersWithArgs, 0);
  assert.equal(result.missingFeedbackTiming.timingShapes[0].finiteTimestamp, false);
  assert.equal(result.missingReporter.reporters, 0);
  assert.equal(result.missingFeedback.feedback, 0);
  assert.equal(result.duplicate.duplicates, 2);
  assert.equal(result.unsafeNumeric.numericIdentityAccepted, false);
  assert.equal(result.crossOwner.status, 'unavailable');
  assert.equal(recordProperties(events).ownership, 'unresolved');
  assert.equal(mutationControls([]).status, 'unavailable');
});
