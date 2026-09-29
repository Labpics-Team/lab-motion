import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createReorder, type ReorderSession } from '../../src/behaviors/reorder/index.js';

const gc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof gc, 'function');
const keep: unknown[] = [];
function setup(destroy: boolean): WeakRef<object> {
  const marker = { value: 1 };
  const weak = new WeakRef(marker);
  const state = createReorder({ items: [{ key: 'a', rect: { x: 0, y: 0, width: 1, height: 1 } }], onReorder() { assert.equal(marker.value, 1); } });
  keep.push(state, state.start('a'));
  if (destroy) state.destroy();
  return weak;
}
const done = setup(true), live = setup(false);
function stale(): WeakRef<object> {
  const marker = { value: 2 };
  const state = createReorder({ items: [{ key: 'a', rect: { x: 0, y: 0, width: 1, height: 1 } }], onReorder() { assert.equal(marker.value, 2); } });
  const session: ReorderSession = state.start('a')!;
  session.end(); keep.push(session);
  return new WeakRef(marker);
}
const ended = stale();
for (let i = 0; i < 30; i++) { await setImmediate(); gc!(); }
assert.equal(done.deref(), undefined, 'destroyed owner retains callback');
assert.equal(ended.deref(), undefined, 'ended session retains owner');
assert.notEqual(live.deref(), undefined, 'positive control lost live callback');
console.log('reorder-gc: PASS', keep.length);
