import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createFrameLoop } from '../../src/frame/index.js';

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof forceGc, 'function', '--expose-gc не включён');

const retainedLoops: Array<ReturnType<typeof createFrameLoop>> = [];
const retainedOffs: Array<() => void> = [];
const refs = await (async (): Promise<[WeakRef<object>, WeakRef<object>]> => {
  let outerPayload: { id: string } | undefined = { id: 'outer' };
  let innerPayload: { id: string } | undefined = { id: 'inner' };
  const result: [WeakRef<object>, WeakRef<object>] = [
    new WeakRef(outerPayload),
    new WeakRef(innerPayload),
  ];
  const hold = (payload: { id: string }): (() => void) => () => { void payload.id; };
  let outerCallback: (() => void) | undefined = hold(outerPayload);
  let innerCallback: (() => void) | undefined = hold(innerPayload);
  let first = true;
  let loop!: ReturnType<typeof createFrameLoop>;

  loop = createFrameLoop({
    requestFrame: () => {
      if (first) {
        first = false;
        const off = loop.update(innerCallback!);
        off();
        throw new Error('host failed');
      }
      return 1;
    },
  });
  try {
    loop.update(outerCallback);
  } catch { /* ожидаемый rollback host-заявки */ }

  outerPayload = undefined;
  innerPayload = undefined;
  outerCallback = undefined;
  innerCallback = undefined;
  retainedLoops.push(loop);
  return result;
})();

const pendingOffRef = (() => {
  let payload: { id: string } | undefined = { id: 'pending-off' };
  const ref = new WeakRef(payload);
  const hold = (value: { id: string }): (() => void) => () => { void value.id; };
  let callback: (() => void) | undefined = hold(payload);
  let teardown: (() => void) | undefined = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(callback, { onTeardown: teardown });
  off();

  payload = undefined;
  callback = undefined;
  teardown = undefined;
  retainedLoops.push(loop);
  retainedOffs.push(off);
  return ref;
})();

const naturalOnceRef = (() => {
  let payload: { id: string } | undefined = { id: 'natural-once' };
  const ref = new WeakRef(payload);
  const hold = (value: { id: string }): (() => void) => () => { void value.id; };
  let callback: (() => void) | undefined = hold(payload);
  let teardown: (() => void) | undefined = hold(payload);
  let fire: ((ts?: number) => void) | undefined;
  const loop = createFrameLoop({
    requestFrame: (cb) => {
      fire = cb;
      return 1;
    },
  });
  const off = loop.update(callback, { once: true, onTeardown: teardown });
  fire!(1);

  payload = undefined;
  callback = undefined;
  teardown = undefined;
  fire = undefined;
  retainedLoops.push(loop);
  retainedOffs.push(off);
  return ref;
})();

for (let i = 0; i < 60; i++) {
  await setImmediate();
  forceGc!();
}

assert.equal(refs[0].deref(), undefined, 'rollback удерживает outer callback');
assert.equal(refs[1].deref(), undefined, 'rollback удерживает dead reentrant callback');
assert.equal(pendingOffRef.deref(), undefined, 'retained off удерживает pending callback');
assert.equal(naturalOnceRef.deref(), undefined, 'retained off удерживает natural-once callback');
assert.equal(retainedLoops.length, 3);
assert.equal(retainedOffs.length, 2);
console.log('frame-gc-retention: PASS');
