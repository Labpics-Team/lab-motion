import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CompositorSpring } from '../../src/compositor/index.js';
import { __resetSpringExecutionCache } from '../../src/compositor/execution.js';

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof forceGc, 'function');

let controller!: CompositorSpring;
let timerController!: CompositorSpring;
const references = await (async (): Promise<readonly WeakRef<object>[]> => {
  let effect: { cancel(): void } | undefined = { cancel() {} };
  const effectReference = new WeakRef(effect);
  let target: { marker: number; animate(): { cancel(): void } } | undefined = {
    marker: 7,
    animate: () => effect!,
  };
  const weak = new WeakRef(target);
  const captured = target;
  controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (value) => `${captured.marker}:${value}`,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => captured.marker,
    setTimer: () => () => { void captured.marker; },
  });
  controller.start();
  const artifact = (controller as unknown as {
    _artifact: readonly [string, object, number];
  })._artifact;
  const samples = new WeakRef(artifact[1]);
  // После eviction единственной допустимой сильной ссылкой остаётся активный owner.
  __resetSpringExecutionCache();
  controller.destroy();
  effect = undefined;
  target = undefined;

  let timerToken: { marker: number } | undefined = { marker: 11 };
  const timerReference = new WeakRef(timerToken);
  const capturedTimer = timerToken;
  timerController = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    delay: 10,
    requestFrame: () => 1,
    setTimer: () => () => { void capturedTimer.marker; },
  });
  timerController.start();
  timerController.destroy();
  timerToken = undefined;
  return [weak, samples, effectReference, timerReference];
})();

for (let i = 0; i < 50; i++) {
  await setImmediate();
  forceGc!();
}

assert.equal(controller.value, 0);
assert.equal(timerController.value, 0);
for (const reference of references) assert.equal(reference.deref(), undefined);
console.log('compositor-retention: PASS');
