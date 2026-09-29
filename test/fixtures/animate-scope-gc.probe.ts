import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createAnimateScope, type AnimateScope } from '../../src/animate/index.js';

const gc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof gc, 'function');
const kept: AnimateScope[] = [];
const weak: Array<{ label: string; ref: WeakRef<object> }> = [];
const timers = new Set<() => void>();
function setTimer(cb: () => void): () => void {
  const fire = (): void => { timers.delete(fire); cb(); };
  timers.add(fire); return (): void => { timers.delete(fire); };
}
function element() {
  return { style: { getPropertyValue: () => '', setProperty() {} }, animate: () => ({ cancel() {}, currentTime: 100 }) };
}
async function complete(destroy: boolean): Promise<void> {
  const root = { querySelectorAll: () => [] }; const scope = createAnimateScope(root);
  kept.push(scope);
  const target = element(); weak.push({ label: `target/${destroy}`, ref: new WeakRef(target) });
  const c = scope.animate(target, { opacity: [0, 1] }, { now: () => 0, setTimer });
  if (destroy) { weak.push({ label: 'destroyed root', ref: new WeakRef(root) }); scope.destroy(); }
  else for (const fire of [...timers]) fire();
  await c.finished;
}
for (let i = 0; i < 12; i++) { await complete(false); await complete(true); }
function live() {
  const scope = createAnimateScope({ querySelectorAll: () => [] }); const target = element();
  scope.animate(target, { opacity: [0, 1] }, { now: () => 0, setTimer }).pause();
  kept.push(scope); return { scope, ref: new WeakRef(target) };
}
const active = live();
async function collect(): Promise<void> { for (let i = 0; i < 20; i++) { await setImmediate(); gc!(); } }
await collect();
assert.notEqual(active.ref.deref(), undefined, 'положительный контроль: paused owner потерян');
for (const { label, ref } of weak) assert.equal(ref.deref(), undefined, `scope удерживает ${label}`);
active.scope.destroy(); await collect();
assert.equal(active.ref.deref(), undefined, 'уничтоженный scope удерживает paused target');
assert.equal(timers.size, 0, 'таймерный стенд сам удержал callback');
assert.equal(kept.length, 25);
console.log('animate-scope-gc: PASS');
