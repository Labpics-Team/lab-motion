import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const frames = new Map(); let frameId = 0, reduced = 0, supports = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => { frames.delete(id); };
globalThis.matchMedia = () => { reduced++; return { matches: false }; };
globalThis.CSS = { supports: () => { supports++; return false; } };
const format = process.argv[2];
const api = format === 'cjs' ? createRequire(import.meta.url)('@labpics/motion') : await import('@labpics/motion');
const LIMIT = 100_000, receipts = [];
class GetterProbeError extends Error {}
function element() {
  const counts = { style: 0, reads: 0, writes: 0, native: 0 }, css = new Map();
  const style = {
    getPropertyValue(name) { counts.reads++; return css.get(name) ?? ''; },
    getPropertyPriority: () => '',
    setProperty(name, value) { counts.writes++; css.set(name, value); },
    removeProperty(name) { counts.writes++; const old = css.get(name) ?? ''; css.delete(name); return old; },
  };
  return { css, counts, target: {
    get style() { counts.style++; return style; },
    get animate() { counts.native++; return undefined; },
  } };
}
function values(length) { return Array.from({ length }, (_, i) => i === length - 1 ? 1 : 0); }
function noExpensive(probes, before) {
  for (const p of probes) {
    assert.equal(p.counts.reads, 0); assert.equal(p.counts.writes, 0); assert.equal(p.counts.native, 0);
  }
  assert.deepEqual({ reduced, supports }, before);
}

// Все сценарии выполняются строго последовательно; receipt после завершения всех await.
const cases = [];
const opts = { duration: 0, ease: 'linear' };
function add(name, run) { cases.push({ name, run }); }
function keys(count, first = 1) {
  const result = Object.fromEntries(Array.from({ length: count }, (_, i) => ['--k' + i, 1]));
  Object.defineProperty(result, '--k0', { enumerable: true, get: () => first() });
  return result;
}
function checkedLength(length, first, hook = () => {}) {
  const data = Array(length).fill(first);
  let reads = 0, indices = 0;
  const proxy = new Proxy(data, { get(target, key, receiver) {
    if (key === 'length') { reads++; hook(); }
    if (key === '0') indices++;
    return Reflect.get(target, key, receiver);
  } });
  return { data: proxy, counts: () => ({ lengthReads: reads, firstIndexReads: indices }) };
}
function untouched(p, before) {
  noExpensive([p], before); assert.equal(p.counts.style, 0); assert.equal(frames.size, 0);
}
async function terminal(run) {
  try { assert.deepEqual(await run.finished, { status: 'finished' }); assert.equal(run.state, 'finished'); assert.equal(frames.size, 0); }
  finally { run.stop(); }
}
async function neighbor(action) {
  const p = element(); let nested;
  const start = () => { nested = api.animate(p.target, { opacity: [0, 1] }, { duration: 1000, ease: 'linear' }); };
  try {
    const data = await action(start);
    assert.ok(nested); assert.equal(nested.state, 'running'); assert.ok(frames.size > 0);
    nested.seek(250); assert.equal(Number(p.css.get('opacity')), 0.25);
    nested.finish(); assert.deepEqual(await nested.finished, { status: 'finished' });
    assert.equal(Number(p.css.get('opacity')), 1); assert.equal(frames.size, 0);
    return { ...data, neighbor: p.counts };
  } finally { nested?.stop(); }
}
// Property keys: положительная граница читает все getters, но не создаёт100k surfaces.
for (const count of [LIMIT - 1, LIMIT, LIMIT + 1]) add(`keys/${count}`, async () => {
  const p = element(), before = { reduced, supports }; let getter = 0;
  const props = Object.fromEntries(Array.from({ length: count }, (_, i) => ['--k' + i, 1]));
  Object.defineProperty(props, '--k0', { enumerable: true, get() { getter++; return 1; } });
  if (count > LIMIT) { assert.throws(() => api.animate(p.target, props, opts), api.MotionError); assert.equal(getter, 0); untouched(p, before); }
  else { await terminal(api.animate([], props, opts)); assert.equal(getter, 1); }
  // Достижимый consumer после boundary input выполняет настоящую запись.
  await terminal(api.animate(p.target, { opacity: [0, 1] }, opts)); assert.equal(Number(p.css.get('opacity')), 1);
  return { count, getter, host: p.counts, acceptedTargetVector: count <= LIMIT ? 'empty' : 'reachable-refused' };
});
add('keys/hostile-at-limit', () => {
  const sentinel = new GetterProbeError('keys'), p = element(), before = { reduced, supports };
  assert.throws(() => api.animate(p.target, keys(LIMIT, () => { throw sentinel; }), opts), e => e === sentinel);
  untouched(p, before); return { exactSentinel: true };
});
add('keys/reentry-at-limit', () => neighbor(async start => {
  let reads = 0; const run = api.animate([], keys(LIMIT, () => { reads++; start(); return 1; }), opts);
  try { assert.deepEqual(await run.finished, { status: 'finished' }); assert.equal(run.state, 'finished'); assert.equal(reads, 1); }
  finally { run.stop(); }
  return { reads, stage: 'admitted-property-getter' };
}));
// Authored snapshot: over-limit обязан отказаться до чтения indices.
for (const count of [LIMIT - 1, LIMIT, LIMIT + 1]) add(`array/${count}`, async () => {
  const p = element(), before = { reduced, supports }, data = values(count); let indices = 0;
  Object.defineProperty(data, '0', { get() { indices++; return 0; } });
  if (count > LIMIT) { assert.throws(() => api.animate(p.target, { opacity: data }, opts), api.MotionError); assert.equal(indices, 0); untouched(p, before); }
  else { await terminal(api.animate(p.target, { opacity: data }, opts)); assert.equal(indices, 1); assert.equal(Number(p.css.get('opacity')), 1); assert.ok(p.counts.writes > 0); }
  return { count, indices, host: p.counts };
});
add('array/hostile-index-at-limit', () => {
  const data = values(LIMIT), sentinel = new GetterProbeError('array'), p = element(), before = { reduced, supports };
  Object.defineProperty(data, '0', { get() { throw sentinel; } });
  assert.throws(() => api.animate(p.target, { opacity: data }, opts), e => e === sentinel); untouched(p, before); return { exactSentinel: true };
});
add('array/length-reentry-overflow', () => neighbor(start => {
  const p = element(), data = checkedLength(LIMIT + 1, 0, start);
  assert.throws(() => api.animate(p.target, { opacity: data.data }, opts), api.MotionError);
  assert.deepEqual(data.counts(), { lengthReads: 1, firstIndexReads: 0 });
  assert.deepEqual(p.counts, { style: 0, reads: 0, writes: 0, native: 0 }); return data.counts();
}));
// Aggregate count расширяет scale; snapshot каждого массива остаётся ниже собственного cap.
function aggregate(count, hook) {
  const data = values(count === LIMIT - 1 ? 49999 : 50000); let reads = 0;
  Object.defineProperty(data, '0', { get() { reads++; hook?.(); return 0; } });
  const props = count === LIMIT ? { scale: data } : { scale: data, '--extra': 1 };
  return { props, counts: () => ({ arrayLength: data.length, firstIndexReads: reads, normalizedValues: count }) };
}
for (const count of [LIMIT - 1, LIMIT, LIMIT + 1]) add(`aggregate/${count}`, async () => {
  const p = element(), before = { reduced, supports }, input = aggregate(count);
  if (count > LIMIT) { assert.throws(() => api.animate(p.target, input.props, opts), api.MotionError); untouched(p, before); }
  else { await terminal(api.animate(p.target, input.props, opts)); assert.equal(p.css.get('transform'), 'none'); if (count === LIMIT - 1) assert.equal(Number(p.css.get('--extra')), 1); assert.ok(p.counts.writes > 0); }
  assert.equal(input.counts().firstIndexReads, 1); return { ...input.counts(), host: p.counts };
});
add('aggregate/hostile-before-count', () => {
  const sentinel = new GetterProbeError('aggregate'), p = element(), before = { reduced, supports }, input = aggregate(LIMIT + 1, () => { throw sentinel; });
  assert.throws(() => api.animate(p.target, input.props, opts), e => e === sentinel); untouched(p, before); return { exactSentinel: true, stage: 'required-snapshot' };
});
add('aggregate/reentry-overflow', () => neighbor(start => {
  const p = element(), input = aggregate(LIMIT + 1, start);
  assert.throws(() => api.animate(p.target, input.props, opts), api.MotionError);
  assert.deepEqual(p.counts, { style: 0, reads: 0, writes: 0, native: 0 }); assert.equal(input.counts().firstIndexReads, 1); return input.counts();
}));
// List triplet: пустые steps не добавляют сегменты; один последний reachable step доказывает execution.
for (const count of [LIMIT - 1, LIMIT, LIMIT + 1]) add(`list/${count}`, async () => {
  const p = element(), before = { reduced, supports }, list = Array(count).fill([[], {}, opts]); let indices = 0;
  list[count - 1] = [p.target, { opacity: [0, 1] }, opts];
  Object.defineProperty(list, '0', { get() { indices++; return [[], {}, opts]; } });
  if (count > LIMIT) { assert.throws(() => api.sequence(list), api.MotionError); assert.equal(indices, 0); untouched(p, before); }
  else { await terminal(api.sequence(list)); assert.equal(indices, 1); assert.equal(Number(p.css.get('opacity')), 1); assert.ok(p.counts.writes > 0); }
  return { count, firstIndexReads: indices, actualSegments: count <= LIMIT ? 1 : 0, host: p.counts };
});
add('list/hostile-index-at-limit', () => {
  const p = element(), before = { reduced, supports }, list = Array(LIMIT).fill([[], {}, opts]), sentinel = new GetterProbeError('list');
  Object.defineProperty(list, '0', { get() { throw sentinel; } });
  assert.throws(() => api.sequence(list), e => e === sentinel); untouched(p, before); return { exactSentinel: true };
});
add('list/length-reentry-overflow', () => neighbor(start => {
  const p = element(), list = checkedLength(LIMIT + 1, [p.target, { opacity: 1 }, opts], start);
  assert.throws(() => api.sequence(list.data), api.MotionError);
  assert.deepEqual(list.counts(), { lengthReads: 1, firstIndexReads: 0 }); assert.deepEqual(p.counts, { style: 0, reads: 0, writes: 0, native: 0 }); return list.counts();
}));
// Два distinct channels:50000+49999/50000/50001 segments, без quadratic same-key merge.
function steps(count, p, hook) {
  const second = values(count - 50000 + 1); let reads = 0;
  const props = { get ['--tail']() { reads++; hook?.(); return second; } };
  return { list: [[p.target, { opacity: values(50001) }, opts], [p.target, props, opts]], counts: () => ({ steps: 2, firstSegments: 50000, secondSegments: second.length - 1, secondGetterReads: reads }) };
}
for (const count of [LIMIT - 1, LIMIT, LIMIT + 1]) add(`segments/${count}`, async () => {
  const p = element(), input = steps(count, p);
  if (count > LIMIT) {
    assert.throws(() => api.sequence(input.list), api.MotionError);
    assert.ok(p.counts.style > 0); assert.ok(p.counts.reads > 0);
    assert.equal(p.counts.writes, 0); assert.equal(p.counts.native, 0); assert.equal(frames.size, 0);
  } else {
    await terminal(api.sequence(input.list)); assert.equal(Number(p.css.get('opacity')), 1); assert.equal(Number(p.css.get('--tail')), 1); assert.ok(p.counts.writes > 0);
  }
  assert.equal(input.counts().secondGetterReads, 1); return { count, ...input.counts(), host: p.counts };
});
add('segments/hostile-second-property', () => {
  const p = element(), sentinel = new GetterProbeError('segments'), input = steps(LIMIT + 1, p, () => { throw sentinel; });
  assert.throws(() => api.sequence(input.list), e => e === sentinel);
  assert.ok(p.counts.reads > 0); assert.equal(p.counts.writes, 0); assert.equal(p.counts.native, 0); assert.equal(frames.size, 0);
  return { exactSentinel: true, host: p.counts, stage: 'first-draft-allowed' };
});
add('segments/reentry-overflow', () => neighbor(start => {
  const p = element(), input = steps(LIMIT + 1, p, start);
  assert.throws(() => api.sequence(input.list), api.MotionError);
  assert.ok(p.counts.reads > 0); assert.equal(p.counts.writes, 0); assert.equal(p.counts.native, 0);
  return { ...input.counts(), host: p.counts };
}));
cases.push(
  ...[[3, 33333, LIMIT - 1], [4, 25000, LIMIT], [11, 9091, LIMIT + 1]].map(([targets, count, product]) => ({
    name: `product/${product}`, async run() {
      const probes = Array.from({ length: targets }, element), data = values(count);
      const before = { reduced, supports }; let run;
      try {
        if (product > LIMIT) {
          assert.throws(() => api.animate(probes.map(p => p.target), { opacity: data }, { duration: 0, ease: 'linear' }), api.MotionError);
          noExpensive(probes, before); assert.equal(frames.size, 0);
          assert.ok(probes.every(p => p.counts.style > 0));
        } else {
          run = api.animate(probes.map(p => p.target), { opacity: data }, { duration: 0, ease: 'linear' });
          assert.deepEqual(await run.finished, { status: 'finished' }); assert.equal(run.state, 'finished');
          for (const p of probes) { assert.equal(Number(p.css.get('opacity')), 1); assert.ok(p.counts.reads > 0); assert.ok(p.counts.writes > 0); }
          assert.equal(frames.size, 0);
        }
        return { targets, values: count, product, counts: probes.map(p => p.counts) };
      } finally { run?.stop(); }
    },
  })),
  { name: 'dedup/raw-11-distinct-1', async run() {
    const p = element(); let run;
    try {
      run = api.animate(Array(11).fill(p.target), { opacity: values(9091) }, { duration: 0, ease: 'linear' });
      assert.deepEqual(await run.finished, { status: 'finished' }); assert.equal(Number(p.css.get('opacity')), 1);
      assert.equal(frames.size, 0); return { rawTargets: 11, distinctTargets: 1, values: 9091, counts: p.counts };
    } finally { run?.stop(); }
  } },
  { name: 'normalized-scale-expansion/overflow', run() {
    const probes = Array.from({ length: 4 }, element), before = { reduced, supports };
    assert.throws(() => api.animate(probes.map(p => p.target), { scale: values(12501) }), api.MotionError);
    noExpensive(probes, before); assert.equal(frames.size, 0);
    return { targets: 4, authoredValues: 12501, normalizedChannels: 2, product: 100008, counts: probes.map(p => p.counts) };
  } },
  ...['property', 'value-index', 'target-index'].map(kind => ({ name: `hostile/${kind}`, run() {
    const p = element(), sentinel = new GetterProbeError(kind), before = { reduced, supports }; let calls = 0;
    const boom = () => { calls++; throw sentinel; };
    const data = [0, 1]; let props = { opacity: data }, targets = [p.target];
    if (kind === 'property') props = { get opacity() { return boom(); } };
    if (kind === 'value-index') Object.defineProperty(data, '1', { get: boom });
    if (kind === 'target-index') targets = { length: 1, get 0() { return boom(); } };
    assert.throws(() => api.animate(targets, props), error => error === sentinel);
    assert.equal(calls, 1); noExpensive([p], before); assert.equal(p.counts.style, 0); assert.equal(frames.size, 0);
    return { calls, exactSentinel: true, counts: p.counts };
  } })),
  ...['property', 'target-index'].map(kind => ({ name: `reentry/${kind}/product-overflow`, async run() {
    const neighbor = element(), probes = Array.from({ length: 11 }, element); let nested, calls = 0;
    const reenter = () => { calls++; nested = api.animate(neighbor.target, { opacity: [0, 1] }, { duration: 1000, ease: 'linear' }); };
    const data = values(9091); let props = { opacity: data }, targets = probes.map(p => p.target);
    if (kind === 'property') props = { get opacity() { reenter(); return data; } };
    else targets = { length: 11, get 0() { reenter(); return probes[0].target; }, ...Object.fromEntries(probes.slice(1).map((p, i) => [i + 1, p.target])) };
    try {
      assert.throws(() => api.animate(targets, props), api.MotionError); assert.equal(calls, 1); assert.ok(nested);
      for (const p of probes) { assert.equal(p.counts.reads, 0); assert.equal(p.counts.writes, 0); assert.equal(p.counts.native, 0); }
      assert.equal(nested.state, 'running'); assert.ok(frames.size > 0);
      nested.seek(250); assert.equal(Number(neighbor.css.get('opacity')), 0.25);
      nested.finish(); assert.deepEqual(await nested.finished, { status: 'finished' }); assert.equal(Number(neighbor.css.get('opacity')), 1);
      assert.equal(frames.size, 0); return { calls, neighbor: neighbor.counts, refused: probes.map(p => p.counts) };
    } finally { nested?.stop(); }
  } })),
  { name: 'healthy-neighbor/product-refusal', async run() {
    const neighbor = element(), probes = Array.from({ length: 11 }, element);
    const run = api.animate(neighbor.target, { opacity: [0, 1] }, { duration: 1000, ease: 'linear' });
    const before = { reduced, supports };
    try {
      assert.throws(() => api.animate(probes.map(p => p.target), { opacity: values(9091) }), api.MotionError);
      noExpensive(probes, before); assert.equal(run.state, 'running');
      run.seek(500); assert.equal(Number(neighbor.css.get('opacity')), 0.5);
      run.stop(); assert.deepEqual(await run.finished, { status: 'stopped' }); assert.equal(frames.size, 0);
      return { neighbor: neighbor.counts, refused: probes.map(p => p.counts) };
    } finally { run.stop(); }
  } },
);

assert.equal(cases.length, 36);
for (const item of cases) {
  const data = await item.run();
  receipts.push({ name: item.name, data });
}
assert.equal(receipts.length, 36);
assert.equal(frames.size, 0);
console.log(JSON.stringify({ format, cap: LIMIT, checks: receipts.length, receipts, pendingFrames: frames.size }));
