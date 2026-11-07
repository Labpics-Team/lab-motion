import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => { frames.delete(id); };
globalThis.CSS = { supports: () => false };
const api = process.argv[2] === 'cjs'
  ? createRequire(import.meta.url)('@labpics/motion') : await import('@labpics/motion');
const LIMIT = 100_000;
const receipts = [];
class GetterProbeError extends Error {}

function element() {
  const counts = { style: 0, reads: 0, writes: 0, native: 0 };
  const css = new Map();
  const style = {
    getPropertyValue(name) { counts.reads++; return css.get(name) ?? ''; },
    getPropertyPriority: () => '',
    setProperty(name, value) { counts.writes++; css.set(name, value); },
    removeProperty(name) { counts.writes++; const old = css.get(name) ?? ''; css.delete(name); return old; },
  };
  const target = {
    get style() { counts.style++; return style; },
    get animate() { counts.native++; return undefined; },
  };
  return { target, counts, css };
}
function arrayLike(length, target) {
  const counts = { length: 0, index: 0 };
  const list = new Proxy({}, {
    get(_object, key) {
      if (key === 'length') { counts.length++; return length; }
      if (typeof key === 'string' && /^\d+$/.test(key)) { counts.index++; return target; }
      return undefined;
    },
  });
  return { list, counts };
}
function iterable(length, target) {
  const counts = { next: 0, closed: 0 };
  const list = { [Symbol.iterator]() {
    let index = 0;
    return {
      next() { counts.next++; return index++ < length ? { value: target, done: false } : { done: true }; },
      return() { counts.closed++; return { done: true }; },
    };
  } };
  return { list, counts };
}
function assertUntouched(probe) {
  assert.deepEqual(probe.counts, { style: 0, reads: 0, writes: 0, native: 0 });
  assert.equal(frames.size, 0);
}
function record(name, counts) { receipts.push({ name, counts }); }

for (const kind of ['array-like', 'iterable']) {
  for (const length of [LIMIT - 1, LIMIT]) {
    {
      // Длина исходного списка не зависит от числа каналов после дедупликации.
      const probe = element();
      const collection = kind === 'array-like' ? arrayLike(length, probe.target) : iterable(length, probe.target);
      // Публичный root принимает границу и выполняет реальную запись style.
      const run = api.animate(collection.list, { opacity: [0, 1] }, { duration: 0, ease: 'linear' });
      // Конечное значение, точный terminal result и отсутствие оставшихся кадров.
      assert.deepEqual(await run.finished, { status: 'finished' });
      assert.equal(run.state, 'finished');
      assert.equal(Number(probe.css.get('opacity')), 1);
      assert.ok(probe.counts.writes > 0);
      assert.equal(frames.size, 0);
      if (kind === 'array-like') assert.deepEqual(collection.counts, { length: 1, index: length });
      else assert.deepEqual(collection.counts, { next: length + 1, closed: 0 });
      record(`${kind}/${length}`, collection.counts);
    }
  }
  {
    // Счётчики обнаружат обращение к элементу при слишком позднем отказе.
    const probe = element();
    const collection = kind === 'array-like' ? arrayLike(LIMIT + 1, probe.target) : iterable(LIMIT + 1, probe.target);
    // Число исходных целей превышает лимит владельца.
    assert.throws(() => api.animate(collection.list, { opacity: 1 }), api.MotionError);
    // Работа с элементом/host не начата; iterable читает один surplus и закрывается.
    assertUntouched(probe);
    if (kind === 'array-like') assert.deepEqual(collection.counts, { length: 1, index: 0 });
    else assert.deepEqual(collection.counts, { next: LIMIT + 1, closed: 1 });
    record(`${kind}/overflow`, collection.counts);
  }
}

for (const length of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  {
    const probe = element();
    const collection = arrayLike(length, probe.target);
    assert.throws(() => api.animate(collection.list, { opacity: 1 }), api.MotionError);
    assert.deepEqual(collection.counts, { length: 1, index: 0 });
    assertUntouched(probe);
    record(`invalid/${String(length)}`, collection.counts);
  }
}

{
  const sentinel = new GetterProbeError('index witness');
  let indexReads = 0;
  const make = length => ({ length, get 0() { indexReads++; throw sentinel; } });
  assert.throws(() => api.animate(make(LIMIT + 1), { opacity: 1 }), api.MotionError);
  assert.equal(indexReads, 0);
  assert.throws(() => api.animate(make(1), { opacity: 1 }), error => error === sentinel);
  assert.equal(indexReads, 1);
  assert.equal(frames.size, 0);
  record('index-sensitivity', { indexReads });
}

for (const key of ['length', 'iterator', 'style']) {
  {
    const sentinel = new GetterProbeError(key);
    let reads = 0;
    let list;
    switch (key) {
      case 'length': list = { get length() { reads++; throw sentinel; } }; break;
      case 'iterator': list = { get [Symbol.iterator]() { reads++; throw sentinel; } }; break;
      case 'style': list = [{ get style() { reads++; throw sentinel; } }]; break;
      default: throw new GetterProbeError('unknown witness variant');
    }
    assert.throws(() => api.animate(list, { opacity: 1 }), error => error === sentinel);
    assert.equal(reads, 1);
    assert.equal(frames.size, 0);
    record(`getter/${key}`, { reads });
  }
}

for (const key of ['length', 'index']) {
  {
    const neighbor = element();
    let nested, calls = 0;
    const sentinel = new GetterProbeError('outer index refusal');
    const reenter = () => {
      calls++;
      nested = api.animate(neighbor.target, { opacity: [0, 1] }, { duration: 1000, ease: 'linear' });
    };
    const list = key === 'length'
      ? { get length() { reenter(); return LIMIT + 1; } }
      : { length: 1, get 0() { reenter(); throw sentinel; } };
    try {
      assert.throws(() => api.animate(list, { opacity: 1 }), key === 'length' ? api.MotionError : error => error === sentinel);
      assert.equal(calls, 1);
      assert.ok(nested);
      const finished = nested.finished;
      assert.equal(nested.state, 'running');
      assert.ok(frames.size > 0);
      nested.seek(500);
      assert.equal(Number(neighbor.css.get('opacity')), 0.5);
      nested.stop();
      assert.deepEqual(await finished, { status: 'stopped' });
      assert.equal(frames.size, 0);
      record(`reentry/${key}`, { calls, writes: neighbor.counts.writes });
    } finally { nested?.stop(); }
  }
}

{
  const probe = element();
  const collection = arrayLike(LIMIT + 1, probe.target);
  let queries = 0;
  const area = api.scope({ querySelectorAll() { queries++; return collection.list; } });
  try {
    assert.throws(() => area.animate('.candidate', { opacity: 1 }), api.MotionError);
    assert.equal(queries, 1);
    assert.deepEqual(collection.counts, { length: 1, index: 0 });
    assertUntouched(probe);
    record('scope/selector-overflow', { queries, ...collection.counts });
  } finally { area.dispose(); }
}

{
  const neighbor = element(), poison = element();
  const run = api.animate(neighbor.target, { opacity: [0, 1] }, { duration: 1000, ease: 'linear' });
  const finished = run.finished;
  try {
    const collection = arrayLike(LIMIT + 1, poison.target);
    assert.throws(() => api.animate(collection.list, { opacity: 1 }), api.MotionError);
    assert.deepEqual(poison.counts, { style: 0, reads: 0, writes: 0, native: 0 });
    assert.equal(run.state, 'running');
    run.seek(250);
    assert.equal(Number(neighbor.css.get('opacity')), 0.25);
    run.finish();
    assert.deepEqual(await finished, { status: 'finished' });
    assert.equal(Number(neighbor.css.get('opacity')), 1);
    assert.equal(frames.size, 0);
    record('healthy-neighbor/refusal', { writes: neighbor.counts.writes });
  } finally { run.stop(); }
}

assert.equal(receipts.length, 19);
assert.equal(frames.size, 0);
console.log(JSON.stringify({ format: process.argv[2] ?? 'esm', cap: LIMIT, checks: receipts.length, receipts, pendingFrames: frames.size }));
