import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bounded, traceObserver, inventory, recordProperties, mutationControls, finalizeBoundary, nativeIntervals, CONFIG } from './s5-cdp-boundary-probe.mjs';

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
    ({ name: 'TimeStamp', pid: 1, tid: 1, ts: 10, args: { data: { message: `${token}:${label}` } } }));
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
  const unrelated = valid();
  unrelated.trace.fragments[0].value.push({ name: 'unrelated', args: { unsafe: Number.MAX_SAFE_INTEGER + 1 } });
  assert.equal(finalizeBoundary(unrelated), 0);
  assert.equal(unrelated.controls.payloadNumericIdentityAccepted, false);
  assert.equal(unrelated.controls.numericIdentityAccepted, true);
  assert.equal(inventory(unrelated.trace.fragments[0].value).unsafeNumbers.length, 1);
  for (const mutate of [
    report => report.trace.fragments[0].value.pop(),
    report => report.trace.fragments[0].value.push(structuredClone(markers[0])),
    report => { report.trace.status = 'incomplete'; },
    report => { report.trace.completion.dataLossOccurred = true; },
    report => report.errors.push({ phase: 'probe', message: 'failed' }),
    report => { report.pages[1].status = 'failed'; },
    report => { report.pages[1].playState = 'running'; },
    report => { report.pages[1].label = 'A'; },
    report => { report.trace.fragments[0].value[0].ts = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const report = valid(); mutate(report);
    const before = structuredClone(report.trace.fragments);
    assert.equal(finalizeBoundary(report), 1);
    assert.equal(report.status, 'incomplete');
    assert.deepEqual(report.trace.fragments, before);
    assert.equal(report.presentationProof, 'unresolved');
  }
});

function nativeFixture(sequence = 1, start = 0, pid = 10, local = '0x52') {
  const event = (name, ph, ts, args = {}) => ({ cat: 'cc,benchmark,disabled-by-default-devtools.timeline.frame',
    pid, tid: pid, id2: { local }, name, ph, ts, args });
  return [event('PipelineReporter', 'b', start, { frame_reporter: { frame_source: 8589934592,
    frame_sequence: sequence, layer_tree_host_id: 2, state: 'STATE_PRESENTED_ALL', has_missing_content: false,
    surface_frame_trace_id: Number.MAX_SAFE_INTEGER + 1 } }),
  event('SubmitCompositorFrameToPresentationCompositorFrame', 'b', start + 1),
  event('SwapEndToPresentationCompositorFrame', 'b', start + 2),
  event('SwapEndToPresentationCompositorFrame', 'e', start + 3),
  event('SubmitCompositorFrameToPresentationCompositorFrame', 'e', start + 3),
  event('PipelineReporter', 'e', start + 3)];
}

test('reused scoped tracks associate strict occurrences while retaining unsafe unconsumed diagnostics', () => {
  const events = [...nativeFixture(), ...nativeFixture(2, 10)];
  const before = structuredClone(events), result = nativeIntervals(events);
  assert.equal(result.status, 'accepted');
  assert.equal(result.associations.length, 2);
  assert.deepEqual(result.associations.map(item => item.tuple), [[10, 8589934592, 1, 2], [10, 8589934592, 2, 2]]);
  assert.equal(result.consumedIdentityAccepted, true);
  assert.equal(inventory(events).numericIdentityAccepted, false);
  assert.equal(inventory(events).unsafeNumbers.length, 2);
  assert.equal(result.presentationProof, 'unresolved');
  assert.equal(result.ownership, 'unresolved');
  assert.equal(result.nativeUUID, 'unproved');
  assert.deepEqual(events, before);
  const token = 'native-control';
  const markers = ['A:start', 'A:end', 'B:start', 'B:end'].map((label, index) =>
    ({ name: 'TimeStamp', pid: 10, tid: 10, ts: 20 + index, args: { data: { message: `${token}:${label}` } } }));
  const report = { metadata: { markerToken: token }, errors: [],
    pages: ['A', 'B'].map(label => ({ label, status: 'complete', playState: 'finished' })),
    properties: recordProperties(events), presentationProof: 'unresolved',
    trace: { status: 'complete', completion: { dataLossOccurred: false }, fragments: [{ value: [...events, ...markers] }] } };
  assert.equal(finalizeBoundary(report), 0);
  assert.equal(report.nativeIntervals.associations.length, 2);
  assert.equal(report.controls.numericIdentityAccepted, true);
  assert.equal(report.controls.payloadNumericIdentityAccepted, false);
  const unsafeConsumed = structuredClone(report);
  unsafeConsumed.trace.fragments[0].value[0].args.frame_reporter.frame_sequence = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(finalizeBoundary(unsafeConsumed), 1);
  const partial = structuredClone(report);
  partial.trace.status = 'incomplete';
  assert.equal(finalizeBoundary(partial), 1);
  assert.equal(partial.nativeIntervals.associations.length, 0);
  assert.equal(partial.nativeIntervals.status, 'rejected');
  const missingContent = nativeFixture();
  missingContent[0].args.frame_reporter.has_missing_content = true;
  assert.equal(nativeIntervals(missingContent).associations.length, 0);
  assert.equal(report.presentationProof, 'unresolved');
  const noUpdate = nativeFixture();
  noUpdate[0].args.frame_reporter.state = 'STATE_NO_UPDATE_DESIRED';
  const absentFeedback = [noUpdate[0], noUpdate[5]];
  const noCandidate = nativeIntervals(absentFeedback);
  assert.equal(noCandidate.status, 'accepted');
  assert.equal(noCandidate.occurrences.length, 1);
  assert.equal(noCandidate.associations.length, 0);
  const scopedProcesses = nativeIntervals([...nativeFixture(), ...nativeFixture(1, 0, 11)]);
  assert.equal(scopedProcesses.status, 'accepted');
  assert.equal(scopedProcesses.associations.length, 2);
});

test('full-track admission rejects malformed consumed fields and invalid lifetime counterexamples', () => {
  const mutations = [
    ['unsafe-scope', events => { events[0].pid = Number.MAX_SAFE_INTEGER + 1; }],
    ['nonliteral-id', events => { events[0].id2.local = 52; }],
    ['mixed-id', events => { events[0].id = 'other'; }],
    ['wrong-category', events => { events[2].cat = 'other'; }],
    ['wrong-scope', events => { events[2].scope = 'other'; }],
    ['malformed-scope', events => { events[2].scope = 1; }],
    ['cross-pid', events => { events[2].pid = 11; }],
    ['unsafe-time', events => { events[2].ts = Number.MAX_SAFE_INTEGER + 1; }],
    ['nonfinite-time', events => { events[2].ts = NaN; }],
    ['reversed-time', events => { events[2].ts = 0; }],
    ['unsafe-frame-sequence', events => { events[0].args.frame_reporter.frame_sequence = Number.MAX_SAFE_INTEGER + 1; }],
    ['missing-frame-fields', events => { delete events[0].args.frame_reporter.frame_source; }],
    ['orphan', events => events.shift()],
    ['open', events => events.pop()],
    ['overlap', events => events.splice(1, 0, structuredClone(events[0]))],
    ['duplicate-feedback', events => events.splice(3, 0, structuredClone(events[2]))],
    ['second-feedback', events => events.splice(4, 0, { ...structuredClone(events[2]), ts: 3 }, { ...structuredClone(events[3]), ts: 3 })],
    ['wrong-parent', events => { events[1].name = events[4].name = 'OtherStage'; }],
    ['wrong-top-end', events => { events[4].name = 'OtherStage'; }],
    ['reversed-ties', events => { [events[3], events[5]] = [events[5], events[3]]; }],
    ['hidden-invalid-nested-event', events => events.splice(2, 0, { ...structuredClone(events[1]), name: 'OtherStage', ts: 1.5 })],
    ['colliding-tuple', events => events.push(...nativeFixture(1, 10, 10, '0x65'))],
    ['missing-eligible-feedback', events => events.splice(2, 2)],
    ['no-update-with-feedback', events => { events[0].args.frame_reporter.state = 'STATE_NO_UPDATE_DESIRED'; }],
  ];
  for (const [label, mutate] of mutations) {
    const events = nativeFixture(); mutate(events);
    const before = structuredClone(events), result = nativeIntervals(events);
    assert.equal(result.status, 'rejected', label);
    assert.equal(result.consumedIdentityAccepted, false, label);
    assert.equal(result.associations.length, 0, label);
    assert.ok(result.issues.length > 0, label);
    assert.deepEqual(events, before, label);
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
