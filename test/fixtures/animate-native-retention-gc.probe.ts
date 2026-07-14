import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { springTo, type NativeSpringElement } from '../../src/animate/native/index.js';

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof forceGc, 'function', '--expose-gc не включён');
(globalThis as { CSS?: { supports(): boolean } }).CSS = { supports: () => true };

const retainedHostPromises: Promise<void>[] = [];
const reference = await (async (): Promise<WeakRef<NativeSpringElement>> => {
  const hostFinished = new Promise<void>(() => {});
  retainedHostPromises.push(hostFinished);
  let element: NativeSpringElement | undefined = {
    style: { setProperty() {} },
    animate: () => ({ finished: hostFinished, cancel() {} }),
  };
  const weak = new WeakRef(element);
  const controls = springTo(element, { opacity: [0, 1] });
  controls.cancel();
  await controls.finished;
  element = undefined;
  return weak;
})();

// WeakRef живёт до конца текущего job: GC и deref разнесены по task-границам.
for (let i = 0; i < 50; i++) {
  await setImmediate();
  forceGc!();
}

assert.equal(retainedHostPromises.length, 1);
assert.equal(reference.deref(), undefined, 'host finished удерживает element');
console.log('gc-retention: PASS');
