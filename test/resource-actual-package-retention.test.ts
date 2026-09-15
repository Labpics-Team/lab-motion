import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const FRAME_ESM = resolve('dist/frame/index.js');
const FRAME_CJS = resolve('dist/frame/index.cjs');
const COMPOSITOR_ESM = resolve('dist/compositor/index.js');
const COMPOSITOR_CJS = resolve('dist/compositor/index.cjs');

function runGcChild(script: string): string {
  const temp = mkdtempSync(join(tmpdir(), 'resource-actual-package-'));
  try {
    const file = join(temp, 'probe.mjs');
    writeFileSync(file, script);
    return execFileSync(process.execPath, ['--expose-gc', file], {
      encoding: 'utf8',
      timeout: 60_000,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const frameEsmScript = (entry: string): string => `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(entry)}).href);
const { createFrameLoop } = mod;
const gc = globalThis.gc;
assert.equal(typeof gc, 'function', '--expose-gc missing');
const droppedRef = await (async () => {
  const payload = { id: 'dropped' };
  const ref = new WeakRef(payload);
  const hold = (v) => () => { void v.id; };
  const cb = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(cb);
  off();
  globalThis.__droppedOwner = [loop, off];
  return ref;
})();
const liveRef = await (async () => {
  const payload = { id: 'live' };
  const ref = new WeakRef(payload);
  const hold = (v) => () => { void v.id; };
  const cb = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(cb);
  globalThis.__live = [payload, cb, loop, off];
  return ref;
})();
const deliberateRef = await (async () => {
  const payload = { id: 'deliberate' };
  const ref = new WeakRef(payload);
  const hold = (v) => () => { void v.id; };
  const cb = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(cb);
  off();
  globalThis.__deliberate = [payload, cb, loop, off];
  return ref;
})();
for (let i = 0; i < 60; i++) { await setImmediate(); gc(); }
assert.equal(droppedRef.deref(), undefined, 'actual package frame retains dropped callback while owner alive');
assert.notEqual(liveRef.deref(), undefined, 'live-owner control collected too early');
assert.notEqual(deliberateRef.deref(), undefined, 'deliberate-retention control not retained');
console.log('resource-actual-frame: PASS');
`;

const frameCjsScript = (entry: string): string => `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createRequire } from 'node:module';
const mod = createRequire(import.meta.url)(${JSON.stringify(entry)});
const { createFrameLoop } = mod;
const gc = globalThis.gc;
assert.equal(typeof gc, 'function', '--expose-gc missing');
const droppedRef = await (async () => {
  const payload = { id: 'dropped' };
  const ref = new WeakRef(payload);
  const hold = (v) => () => { void v.id; };
  const cb = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(cb);
  off();
  globalThis.__droppedOwner = [loop, off];
  return ref;
})();
const liveRef = await (async () => {
  const payload = { id: 'live' };
  const ref = new WeakRef(payload);
  const hold = (v) => () => { void v.id; };
  const cb = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(cb);
  globalThis.__live = [payload, cb, loop, off];
  return ref;
})();
const deliberateRef = await (async () => {
  const payload = { id: 'deliberate' };
  const ref = new WeakRef(payload);
  const hold = (v) => () => { void v.id; };
  const cb = hold(payload);
  const loop = createFrameLoop({ requestFrame: () => 1 });
  const off = loop.update(cb);
  off();
  globalThis.__deliberate = [payload, cb, loop, off];
  return ref;
})();
for (let i = 0; i < 60; i++) { await setImmediate(); gc(); }
assert.equal(droppedRef.deref(), undefined, 'actual package frame retains dropped callback while owner alive');
assert.notEqual(liveRef.deref(), undefined, 'live-owner control collected too early');
assert.notEqual(deliberateRef.deref(), undefined, 'deliberate-retention control not retained');
console.log('resource-actual-frame: PASS');
`;

const compositorEsmScript = (entry: string): string => `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(entry)}).href);
const { CompositorSpring } = mod;
const gc = globalThis.gc;
assert.equal(typeof gc, 'function', '--expose-gc missing');
const droppedRef = await (async () => {
  const target = { marker: 7, animate: () => ({ cancel() {} }) };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (v) => captured.marker + ':' + v,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  controller.destroy();
  globalThis.__droppedOwner = [controller];
  return ref;
})();
const liveRef = await (async () => {
  const target = { marker: 9, animate: () => ({ cancel() {} }) };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (v) => captured.marker + ':' + v,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  globalThis.__live = [target, controller];
  return ref;
})();
const deliberateRef = await (async () => {
  const target = { marker: 11, animate: () => ({ cancel() {} }) };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (v) => captured.marker + ':' + v,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  controller.destroy();
  globalThis.__deliberate = [target, controller];
  return ref;
})();
for (let i = 0; i < 60; i++) { await setImmediate(); gc(); }
assert.equal(droppedRef.deref(), undefined, 'actual package compositor retains dropped target while owner alive');
assert.notEqual(liveRef.deref(), undefined, 'live-owner control collected too early');
assert.notEqual(deliberateRef.deref(), undefined, 'deliberate-retention control not retained');
console.log('resource-actual-compositor: PASS');
`;

const compositorCjsScript = (entry: string): string => `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createRequire } from 'node:module';
const mod = createRequire(import.meta.url)(${JSON.stringify(entry)});
const { CompositorSpring } = mod;
const gc = globalThis.gc;
assert.equal(typeof gc, 'function', '--expose-gc missing');
const droppedRef = await (async () => {
  const target = { marker: 7, animate: () => ({ cancel() {} }) };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (v) => captured.marker + ':' + v,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  controller.destroy();
  globalThis.__droppedOwner = [controller];
  return ref;
})();
const liveRef = await (async () => {
  const target = { marker: 9, animate: () => ({ cancel() {} }) };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (v) => captured.marker + ':' + v,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  globalThis.__live = [target, controller];
  return ref;
})();
const deliberateRef = await (async () => {
  const target = { marker: 11, animate: () => ({ cancel() {} }) };
  const ref = new WeakRef(target);
  const captured = target;
  const controller = new CompositorSpring({
    spring: { mass: 1, stiffness: 170, damping: 26 },
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    format: (v) => captured.marker + ':' + v,
    apply: () => { void captured.marker; },
    now: () => captured.marker,
    requestFrame: () => 1,
    setTimer: () => () => {},
  });
  controller.start();
  controller.destroy();
  globalThis.__deliberate = [target, controller];
  return ref;
})();
for (let i = 0; i < 60; i++) { await setImmediate(); gc(); }
assert.equal(droppedRef.deref(), undefined, 'actual package compositor retains dropped target while owner alive');
assert.notEqual(liveRef.deref(), undefined, 'live-owner control collected too early');
assert.notEqual(deliberateRef.deref(), undefined, 'deliberate-retention control not retained');
console.log('resource-actual-compositor: PASS');
`;

it('actual package освобождает frame callbacks из собранного артефакта (esm)', () => {
  expect(existsSync(FRAME_ESM), `missing built artifact ${FRAME_ESM}; сначала pnpm build`).toBe(true);
  const output = runGcChild(frameEsmScript(FRAME_ESM));
  expect(output).toContain('resource-actual-frame: PASS');
}, 60_000);

it('actual package освобождает frame callbacks из собранного артефакта (cjs)', () => {
  expect(existsSync(FRAME_CJS), `missing built artifact ${FRAME_CJS}; сначала pnpm build`).toBe(true);
  const output = runGcChild(frameCjsScript(FRAME_CJS));
  expect(output).toContain('resource-actual-frame: PASS');
}, 60_000);

it('actual package освобождает compositor target из собранного артефакта (esm)', () => {
  expect(existsSync(COMPOSITOR_ESM), `missing built artifact ${COMPOSITOR_ESM}; сначала pnpm build`).toBe(true);
  const output = runGcChild(compositorEsmScript(COMPOSITOR_ESM));
  expect(output).toContain('resource-actual-compositor: PASS');
}, 60_000);

it('actual package освобождает compositor target из собранного артефакта (cjs)', () => {
  expect(existsSync(COMPOSITOR_CJS), `missing built artifact ${COMPOSITOR_CJS}; сначала pnpm build`).toBe(true);
  const output = runGcChild(compositorCjsScript(COMPOSITOR_CJS));
  expect(output).toContain('resource-actual-compositor: PASS');
}, 60_000);
