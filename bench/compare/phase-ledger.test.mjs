import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exclusiveMarkerCpu } from './phase-ledger.mjs';

const marker = (edge, id, label, tts, ts) => ({ name: 'TimeStamp', pid: 1, tid: 2, ts, tts,
  args: { data: { message: `phase-ledger:${edge}:${id}:${label}` } } });
const rows = events => events.map(event => {
  const [, edge, id, ...label] = event.args.data.message.split(':');
  return { edge, id: Number(id), label: label.join(':') };
});
function lifecycle(spans) {
  const events = [marker('checkpoint', 10, 'root-start', 0, 0), ...spans,
    marker('checkpoint', 11, 'return', 200, 10), marker('checkpoint', 12, 'post-frame-commit', 210, 11),
    marker('checkpoint', 13, 'finished', 220, 12), marker('checkpoint', 14, 'cleanup-start', 230, 13),
    marker('checkpoint', 15, 'cleanup', 240, 14)];
  return { events, expected: rows(events) };
}
const nested = () => lifecycle([
  marker('begin', 1, 'draft', 100, 1), marker('begin', 2, 'computed-transform', 100, 2),
  marker('end', 2, 'computed-transform', 130, 3), marker('end', 1, 'draft', 150, 4),
]);
function rejects(events, expected, reason, completion) {
  const result = exclusiveMarkerCpu(events, expected, completion);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, reason);
  assert.equal(result.exclusiveCpuMs, undefined);
}

test('CPU: nested equal-clock start и zero siblings сохраняют exclusive totals', () => {
  const { events, expected } = lifecycle([
    marker('begin', 1, 'draft', 100, 1), marker('begin', 2, 'read', 100, 2),
    marker('end', 2, 'read', 100, 3), marker('begin', 3, 'native', 100, 4),
    marker('end', 3, 'native', 130, 5), marker('end', 1, 'draft', 150, 6),
  ]);
  const result = exclusiveMarkerCpu(events, expected);
  assert.deepEqual(result.exclusiveCpuMs, { read: 0, native: 0.03, draft: 0.02 });
  assert.equal(result.phases.length, 5);
});

test('CPU: wall timestamps без actual tts не становятся CPU', () => {
  const { events, expected } = nested();
  for (const event of events) delete event.tts;
  rejects(events, expected, 'INVALID_THREAD_CLOCK');
  rejects([], expected, 'LEDGER_MARKER_COUNT');
});

for (const [name, clocks] of [
  ['child before parent', [100, 50, 60, 150]],
  ['child after parent', [100, 160, 170, 150]],
  ['overlapping sequential spans', [100, 130, 120, 150]],
]) test(`CPU: отвергает ${name}`, () => {
  const { events, expected } = name === 'overlapping sequential spans' ? lifecycle([
    marker('begin', 1, 'read', 100, 1), marker('end', 1, 'read', 130, 2),
    marker('begin', 2, 'native', 120, 3), marker('end', 2, 'native', 150, 4),
  ]) : nested();
  clocks.forEach((clock, i) => { events[i + 1].tts = clock; });
  rejects(events, expected, 'THREAD_CLOCK_REGRESSION');
});

for (const [field, value, reason] of [
  ['tts', -1, 'INVALID_THREAD_CLOCK'], ['tts', NaN, 'INVALID_THREAD_CLOCK'],
  ['ts', Infinity, 'INVALID_TRACE_FIELDS'], ['pid', undefined, 'INVALID_TRACE_FIELDS'],
  ['tid', 2.5, 'INVALID_TRACE_FIELDS'],
]) test(`CPU: отвергает invalid ${field}/${String(value)}`, () => {
  const { events, expected } = nested(); events[1][field] = value;
  rejects(events, expected, reason);
});

test('CPU: whole balanced pair lost не становится partial AVAILABLE', () => {
  const { events, expected } = nested();
  rejects(events.filter((_, i) => i !== 2 && i !== 3), expected, 'LEDGER_MARKER_COUNT');
});

test('CPU: checkpoint loss и unexpected marker отвергаются по independent ledger', () => {
  const { events, expected } = nested();
  rejects(events.filter(event => !event.args.data.message.includes(':checkpoint:')), expected, 'LEDGER_MARKER_COUNT');
  rejects([...events, marker('checkpoint', 99, 'extra', 250, 15)], expected, 'LEDGER_MARKER_COUNT');
  const changed = structuredClone(events); changed[1].args.data.message = 'phase-ledger:begin:99:draft';
  rejects(changed, expected, 'LEDGER_MARKER_MISMATCH');
});

test('CPU: balanced stream без required lifecycle checkpoints unavailable', () => {
  const { events } = nested();
  const spans = events.filter(event => !event.args.data.message.includes(':checkpoint:'));
  rejects(spans, rows(spans), 'LIFECYCLE_CHECKPOINTS');
});

test('CPU: duplicate ID, label mismatch, non-LIFO и truncated pair отвергаются', () => {
  const make = spans => { const { events, expected } = lifecycle(spans); return [events, expected]; };
  rejects(...make([marker('begin', 1, 'a', 10, 1), marker('begin', 1, 'b', 20, 2)]), 'DUPLICATE_MARKER_ID');
  rejects(...make([marker('begin', 1, 'a', 10, 1), marker('end', 1, 'b', 20, 2)]), 'UNMATCHED_MARKER_PAIR');
  rejects(...make([marker('end', 1, 'a', 20, 1)]), 'UNMATCHED_MARKER_PAIR');
  rejects(...make([marker('begin', 1, 'a', 10, 1), marker('begin', 2, 'b', 20, 2),
    marker('end', 1, 'a', 30, 3), marker('end', 2, 'b', 40, 4)]), 'UNMATCHED_MARKER_PAIR');
  const { events, expected } = nested();
  const truncated = events.slice(0, 4); // Независимый ledger остаётся полным.
  rejects(truncated, expected, 'LEDGER_MARKER_COUNT');
});

test('CPU: duplicate exact marker и thread mismatch unavailable', () => {
  const { events, expected } = nested();
  rejects([events[0], events[1], events[1], ...events.slice(2)],
    [expected[0], expected[1], expected[1], ...expected.slice(2)], 'INVALID_LEDGER_MARKER');
  const changed = structuredClone(events); changed[2].tid = 3;
  rejects(changed, expected, 'MARKER_THREAD_MISMATCH');
});

test('CPU: CDP buffer loss прекращает attribution, counts/raw остаются caller-owned', () => {
  const { events, expected } = nested();
  const before = JSON.stringify({ events, expected });
  rejects(events, expected, 'TRACE_DATA_LOSS', { dataLossOccurred: true });
  assert.equal(JSON.stringify({ events, expected }), before);
});
