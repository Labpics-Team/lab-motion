import { strict as assert } from 'node:assert';
import { setImmediate } from 'node:timers/promises';
import { animate } from '../../src/animate/index.js';
import { WaapiUnit } from '../../src/animate/waapi-unit.js';
import { clearSpringExecutionArtifactCacheUnchecked,
  compileSpringExecutionArtifactTupleUnchecked, DEFAULT_TOLERANCE } from '../../src/compositor/curve.js';
import { SurfaceBatch } from '../../src/animate/surface-batch.js';

// Наблюдатель не меняет исполнение: вызывает исходный метод с тем же this,
// не держит units/buffers сильными ссылками и не зависит от приватных имён.
const observed: Array<{ unit: WeakRef<object>; buffers: WeakRef<object>[] }> = [];
const seen = new WeakSet<object>();
const mainUnits: WeakRef<object>[] = [];
const originalAdd = SurfaceBatch.prototype._add;
SurfaceBatch.prototype._add = function (unit, paused): void {
  mainUnits.push(new WeakRef(unit));
  originalAdd.call(this, unit, paused);
};
const originalCommit = WaapiUnit.prototype._commit;
WaapiUnit.prototype._commit = function (): void {
  if (!seen.has(this)) {
    seen.add(this);
    observed.push({ unit: new WeakRef(this), buffers: Object.values(this)
      .filter(value => Array.isArray(value) || ArrayBuffer.isView(value))
      .map(value => new WeakRef(value)) });
  }
  originalCommit.call(this);
};
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => true } });
const physics = Object.freeze({ mass: 1, stiffness: 100, damping: 10 });

function fixture() {
  const styles = new Map<string, string>();
  let effects = 0;
  const timers = new Map<object, () => void>();
  const target = { style: {
    getPropertyValue: (name: string) => styles.get(name) ?? '',
    setProperty: (name: string, value: string) => { styles.set(name, value); },
  }, animate() { effects++; return { currentTime: 32, cancel() { effects--; } }; } };
  return { target, styles, timers, effects: () => effects,
    options: { spring: physics, now: () => 0,
      setTimer(callback: () => void) {
        const key = {}; timers.set(key, callback);
        return () => { timers.delete(key); };
      },
    },
    finishOne() {
      const next = timers.entries().next().value;
      assert.ok(next); timers.delete(next[0]); next[1]();
    },
  };
}
async function collect() {
  assert.equal(typeof globalThis.gc, 'function', 'probe requires --expose-gc');
  for (let i = 0; i < 4; i++) { await setImmediate(); globalThis.gc!(); }
}
const alive = (refs: WeakRef<object>[]) => refs.filter(ref => ref.deref() !== undefined).length;
const holds: unknown[] = [];
const records: Array<{ name: string; start: number; count: number }> = [];

for (const terminal of ['cancel', 'stop', 'natural'] as const) {
  const f = fixture(), start = observed.length;
  const controls = animate(f.target, { opacity: [0, 1] }, f.options);
  assert.equal(f.effects(), 1, 'positive native owner');
  assert.equal(observed.length - start, 1);
  assert.ok(observed[start]!.buffers.length > 0, 'observer must see live trajectory storage');
  if (terminal === 'natural') f.finishOne(); else controls[terminal]();
  await controls.finished;
  assert.equal(f.effects(), 0);
  assert.equal(f.timers.size, 0);
  holds.push(controls, controls.finished);
  records.push({ name: terminal, start, count: 1 });
}

// Один завершённый слот не вправе держать кривую, пока sibling ещё играет.
const partial = fixture(), partialStart = observed.length;
const partialControls = animate(partial.target, { opacity: [0, 1], x: [0, 100] }, partial.options);
assert.equal(observed.length - partialStart, 2);
partial.finishOne();
assert.equal(partial.effects(), 1);
holds.push(partialControls);
await collect();
const partialVectors = observed.slice(partialStart).map(item => alive(item.buffers));
console.log(JSON.stringify({ phase: 'partial', retainedBuffers: partialVectors }));
// Общая кривая может законно жить в sibling/cache: проверяется lease слота,
// а не ложное требование собрать shared value при живом потребителе.
const ownsBuffers = (ref: WeakRef<object>) => Object.values(ref.deref() ?? {})
  .some(value => Array.isArray(value) || ArrayBuffer.isView(value));
assert.equal(ownsBuffers(observed[partialStart]!.unit), false,
  'completed slot retains a trajectory lease while sibling is live');
assert.ok(partialVectors[1]! > 0, 'healthy live sibling lost its trajectory');
partialControls.cancel(); await partialControls.finished;
assert.equal(partial.effects(), 0);
records.push({ name: 'partial-then-cancel', start: partialStart, count: 2 });

// Новый owner остаётся живым, когда predecessor полностью завершён и удерживается.
const next = fixture(), nextStart = observed.length;
const old = animate(next.target, { opacity: [0, 1] }, next.options);
const successor = animate(next.target, { opacity: 0.2 }, next.options);
await old.finished;
holds.push(old, successor);
await collect();
assert.equal(observed[nextStart]!.unit.deref(), undefined, 'superseded aggregate keeps its executor');
assert.ok(observed[nextStart + 1]!.unit.deref(), 'healthy successor disappeared');
assert.equal(next.effects(), 1);
successor.cancel(); await successor.finished;
records.push({ name: 'superseded', start: nextStart, count: 2 });

// Live handoff не превращает terminal wrapper в владельца завершённого
// MainUnit, пока другой слот того же aggregate продолжает жить.
function crossingMs(): number {
  const artifact = compileSpringExecutionArtifactTupleUnchecked(physics, 0, DEFAULT_TOLERANCE);
  const samples = artifact[1];
  for (let i = 0; i + 3 < samples.length; i += 2) {
    const p0 = samples[i + 1]!, p1 = samples[i + 3]!;
    if (p0 < 1 && p1 >= 1) return (samples[i]! + (1 - p0) / (p1 - p0)
      * (samples[i + 2]! - samples[i]!)) / 100 * artifact[2];
  }
  throw new Error('positive target crossing is required');
}
const handoff = fixture(), mainStart = mainUnits.length, nativeStart = observed.length;
let jobs: Array<(timestamp?: number) => void> = [];
const handoffOptions = { ...handoff.options,
  requestFrame(callback: (timestamp?: number) => void) { jobs.push(callback); return jobs.length; },
};
const crossing = crossingMs();
const handoffControls = animate(handoff.target, { opacity: [0, 1], x: [0, 100] }, handoffOptions);
handoffControls.seek(crossing);
assert.equal(mainUnits.length - mainStart, 2, 'both native slots must reach live handoff');
const replacement = animate(handoff.target, { opacity: [0, 0.2] }, handoff.options);
await collect();
assert.equal(mainUnits[mainStart]!.deref(), undefined,
  'terminal native wrapper retains its superseded main delegate');
assert.ok(mainUnits[mainStart + 1]!.deref(), 'healthy live sibling lost its main delegate');
handoffControls.cancel(); replacement.cancel();
await Promise.all([handoffControls.finished, replacement.finished]);
const pending = jobs; jobs = [];
for (const callback of pending) callback(16);
assert.equal(jobs.length, 0);
holds.push(handoffControls, replacement);
records.push({ name: 'handoff', start: nativeStart, count: observed.length - nativeStart });

// Кэш имеет собственное законное владение; его очистка отделяет его от controls.
clearSpringExecutionArtifactCacheUnchecked();
await collect();
for (const record of records) {
  const items = observed.slice(record.start, record.start + record.count);
  assert.equal(alive(items.map(item => item.unit)), 0, `${record.name}: terminal controls retain executors`);
  assert.equal(alive(items.flatMap(item => item.buffers)), 0, `${record.name}: terminal controls retain trajectory buffers`);
}
// Все controls по-прежнему удерживаются вызывающей стороной, а не выброшены тестом.
assert.equal(holds.length, 11);
assert.equal(alive(mainUnits), 0, 'terminal controls retain main delegates');
SurfaceBatch.prototype._add = originalAdd;
WaapiUnit.prototype._commit = originalCommit;
console.log('animate-terminal-retention: PASS');
