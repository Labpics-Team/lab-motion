import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';

const { scope, layout } = await import(pathToFileURL(process.argv[2]).href);
assert.equal(typeof global.gc, 'function');
let frames = new Map(), frameId = 0, currentTime = 0, createdEffects = 0, removedEffects = 0;
globalThis.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
globalThis.cancelAnimationFrame = id => { frames.delete(id); };
globalThis.CSS = { supports: () => true };
const holds = [], references = [], pending = [];
function effect() {
  let done, cancel;
  const finished = new Promise((resolve, reject) => { done = resolve; cancel = reject; });
  let live = true; createdEffects++;
  return { currentTime: 0, finished, finish() { done(); }, cancel() {
    if (!live) return; live = false; removedEffects++; cancel(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  } };
}
function target(owner, native) {
  const css = new Map();
  return { marker: owner, style: {
    getPropertyValue: name => css.get(name) ?? '',
    getPropertyPriority: () => '',
    setProperty(name, value) { owner.writes++; css.set(name, value); },
    removeProperty(name) { const old = css.get(name) ?? ''; css.delete(name); return old; },
  }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }),
  ...(native ? { animate: effect } : {}),
  ownerDocument: { defaultView: null },
  addEventListener(_name, listener) { owner.listeners.add(listener); },
  removeEventListener(_name, listener) { owner.listeners.delete(listener); },
  };
}
function listener(owner) { return () => { owner.calls++; }; }
function root(element) { return { querySelectorAll: () => [element] }; }
function mutation(owner) { return () => { owner.calls++; }; }
function cycle(i, native, retained) {
  const owner = { id: i, payload: new Array(128).fill(i), writes: 0, calls: 0, listeners: new Set() };
  references.push(new WeakRef(owner));
  const element = target(owner, native), area = scope(root(element));
  const off = area.on(element, 'click', listener(owner));
  const scalar = area.value(0); scalar.subscribe(listener(owner));
  const scalarRun = scalar.animate(100, { duration: 1000, ease: 'linear' });
  const first = area.animate(element, { x: [0, 100], opacity: [0, 1] }, { duration: 1000, ease: 'linear' });
  const second = area.animate(element, { x: 200 }, { duration: 1000, ease: 'linear' });
  first.stop(); second.seek(100); area.dispose();
  assert.equal(owner.listeners.size, 0); assert.equal(area.disposed, true);
  pending.push(first.finished, second.finished, scalarRun.finished);
  holds.push(area, scalar, off, first, second, scalarRun);
  const transition = layout(element, mutation(owner), { reducedMotion: 'always' });
  pending.push(transition.finished); holds.push(transition);
  if (retained) return owner;
}
const ownedResources = [];
const persistent = scope({ querySelectorAll: () => [] });
for (let i = 0; i < 1000; i++) {
  const child = persistent.scope({ querySelectorAll: () => [] });
  const scalar = persistent.value(i);
  ownedResources.push(new WeakRef(child), new WeakRef(scalar));
  child.dispose(); scalar.dispose();
}
const positive = cycle(-1, true, true);
for (let i = 0; i < 10_000; i++) {
  cycle(i, i % 2 === 0, false);
  if (i % 500 === 499) { await Promise.all(pending.splice(0)); await setImmediate(); }
}
await Promise.all(pending);
for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
assert.ok(positive); assert.equal(references[0].deref(), positive, 'Положительный контроль должен удерживаться');
assert.equal(references.slice(1).filter(ref => ref.deref() !== undefined).length, 0, 'Завершённые controllers удержали компоненты');
assert.equal(ownedResources.filter(ref => ref.deref() !== undefined).length, 0, 'Живая родительская область накопила завершённые ресурсы');
persistent.dispose();
assert.equal(createdEffects, removedEffects, 'Остался native effect');
assert.equal(frames.size, 0, 'Осталась заявка кадра');
console.log(JSON.stringify({ cycles: 10_000, heldControllers: holds.length, retainedComponents: 0, nativeCreated: createdEffects,
  nativeRemoved: removedEffects, frames: frames.size, positiveControl: true }));
