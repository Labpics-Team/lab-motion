import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';

const { layout } = await import(pathToFileURL(process.argv[2]).href);
let resolve;
const pending = new Promise(done => { resolve = done; });
const documents = [];
function create(native) {
  const document = { defaultView: native ? { CSS: { supports: () => true } } : null,
    head: { append() {} }, createElement: () => ({ remove() {} }), getAnimations: () => [],
    ...(native ? { startViewTransition(callback) {
      const updateCallbackDone = Promise.resolve().then(callback);
      return { updateCallbackDone, ready: updateCallbackDone, finished: updateCallbackDone, skipTransition() {} };
    } } : {}) };
  documents.push(document);
  const properties = new Map();
  const root = { ownerDocument: document,
    style: { getPropertyValue: key => properties.get(key) ?? '', getPropertyPriority: () => '',
      setProperty(key, value) { properties.set(key, value); }, removeProperty(key) { properties.delete(key); } },
    getBoundingClientRect() { return {}; } };
  const run = layout(root, () => pending, native ? { duration: 100 } : { reducedMotion: 'always' });
  run.stop(); return { run, reference: new WeakRef(root) };
}
const controls = [create(false), create(true)], deliberate = {}, positive = new WeakRef(deliberate);
globalThis.__layoutControl = { controls: controls.map(c => c.run), documents };
for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
assert.equal(positive.deref(), deliberate);
for (const current of controls) assert.equal(current.reference.deref(), undefined,
  'Отменённый layout удерживает DOM root через незавершённое обновление');
resolve();
for (const current of controls) assert.deepEqual(await current.run.finished, { status: 'stopped' });
console.log('native/fallback stopped layout releases root while application update remains pending');
