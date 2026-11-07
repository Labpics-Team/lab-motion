import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { admitStaticFrame, collectStaticFrame, POSITIONS } from './s5-raster-calibration.mjs';
import { colorLeftEdge } from './bench.mjs';
const { PNG } = createRequire(import.meta.url)('pngjs');
const setup = x => ({ authoredX: x, deviceScaleFactor: 1, viewport: { width: 800, height: 200 }, domOwned: true });
const metadata = { timestamp: 123.456, offsetTop: 0, pageScaleFactor: 1, deviceWidth: 800, deviceHeight: 200, scrollOffsetX: 0, scrollOffsetY: 0 };
function scene(x = 117, mutate = () => {}, dimensions = { width: 800, height: 200 }, colorType = 2) {
  const png = new PNG(dimensions); png.data.fill(255);
  const left = Math.floor(x), right = Math.ceil(x + 30);
  for (let y = 20; y < 50; y++) for (let column = left; column < right; column++) {
    const i = (y * png.width + column) * 4;
    // Synthetic edge bytes exercise scene admission, NOT a browser coverage model.
    const g = !Number.isInteger(x) && (column === left || column === right - 1) ? 93 : 0;
    png.data[i + 1] = g; png.data[i + 2] = g;
  }
  mutate(png);
  return PNG.sync.write(png, { colorType });
}
const integer = scene();
const event = (bytes = integer, sessionId = 1) => ({ data: bytes.toString('base64'), metadata: { ...metadata }, sessionId });
class CDP extends EventEmitter {
  constructor(trigger, ack = () => ({}), stop = () => ({})) { super(); this.trigger = trigger; this.ack = ack; this.stop = stop; this.commands = []; }
  send(method, parameters) {
    this.commands.push({ method, parameters });
    if (method === 'Page.startScreencast') return this.trigger(this);
    if (method === 'Page.screencastFrameAck') return this.ack(parameters);
    if (method === 'Page.stopScreencast') return this.stop();
    throw new Error(method);
  }
}
test('actual pngjs codec fields and CURRENT classifier admit integer and reject fractional equality', () => {
  const decoded = PNG.sync.read(integer);
  assert.equal(decoded.depth, 8); assert.equal(decoded.colorType, 2); assert.equal(decoded.data.length, 800 * 200 * 4);
  assert.equal(admitStaticFrame(integer, metadata, setup(117)).status, 'admitted');
  assert.equal(colorLeftEdge(integer, 0), 117);
  const fractional = admitStaticFrame(scene(117.375), metadata, setup(117.375));
  assert.equal(fractional.status, 'admitted'); assert.equal(fractional.geometricEquality, false);
  assert.equal(fractional.classifierMinusAuthored, -0.375); // synthetic control only; browser result is not pinned.
  assert.deepEqual(POSITIONS, [117, 117.125, 117.25, 117.375, 117.5, 117.875]);
});
test('real two-pixel codec strip exercises the unchanged classifier, not scene admission', () => {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
  const bytes = PNG.sync.write(png);
  assert.equal(colorLeftEdge(bytes, 0), 0); assert.equal(colorLeftEdge(bytes, 1), 1);
  assert.equal(admitStaticFrame(bytes, metadata, setup(117)).status, 'rejected');
});
test('real codec scene controls reject wrong color, opacity, missing/occluded pixels, size and shifted top', () => {
  const mutations = [
    png => { png.data[(35 * 800 + 120) * 4] = 0; },
    png => { png.data[(35 * 800 + 120) * 4 + 3] = 128; },
    png => { png.data.fill(255); },
    png => { png.data.set([255, 255, 255, 255], (35 * 800 + 120) * 4); },
    png => { png.data.set([255, 0, 0, 255], (35 * 800 + 160) * 4); },
    png => { png.data.set([255, 0, 0, 255], (19 * 800 + 120) * 4); },
    png => { png.data.set([0, 0, 0, 255], (100 * 800 + 400) * 4); },
  ];
  for (const mutate of mutations) assert.equal(admitStaticFrame(scene(117, mutate, undefined, 6), metadata, setup(117)).status, 'rejected');
  assert.equal(admitStaticFrame(scene(117, () => {}, { width: 801, height: 200 }), metadata, setup(117)).status, 'rejected');
  for (const patch of [{ pageScaleFactor: 2 }, { deviceWidth: 799 }, { offsetTop: 1 }, { scrollOffsetX: 1 }, { timestamp: NaN }])
    assert.equal(admitStaticFrame(integer, { ...metadata, ...patch }, setup(117)).status, 'rejected');
  for (const patch of [{ deviceScaleFactor: 2 }, { domOwned: false }, { viewport: { width: 400, height: 100 } }])
    assert.equal(admitStaticFrame(integer, metadata, { ...setup(117), ...patch }).status, 'rejected');
  for (const bytes of [Buffer.from([255, 216, 255]), integer.subarray(0, 40), Buffer.from('not PNG')])
    assert.equal(admitStaticFrame(bytes, metadata, setup(117)).status, 'rejected');
});
test('synchronous frame before start response is retained, decoded and ACKed with original timestamp', async () => {
  const cdp = new CDP(self => { self.emit('Page.screencastFrame', event()); return {}; });
  const snapshots = [];
  const result = await collectStaticFrame(cdp, setup(117), state => snapshots.push(structuredClone(state)));
  assert.equal(result.status, 'complete'); assert.equal(result.frames[0].metadata.timestamp, metadata.timestamp);
  assert.equal(snapshots.find(state => state.frames.length)?.admission, null);
  assert.equal(result.frames[0].data, integer.toString('base64'));
  assert.deepEqual(cdp.commands.map(c => c.method).sort(), ['Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck'].sort());
  assert.equal(cdp.listenerCount('Page.screencastFrame'), 0);
});
test('invalid first frame cannot be replaced by a later good frame; both ACKs and bytes retained', async () => {
  const bad = Buffer.from('bad PNG');
  const cdp = new CDP(self => { self.emit('Page.screencastFrame', event(bad)); self.emit('Page.screencastFrame', { ...event(), metadata: { ...metadata, timestamp: metadata.timestamp + 1 } }); return {}; });
  const result = await collectStaticFrame(cdp, setup(117), () => {});
  assert.equal(result.status, 'incomplete'); assert.equal(result.admission.status, 'rejected');
  assert.equal(result.frames[0].data, bad.toString('base64'));
  assert.equal(cdp.commands.filter(c => c.method === 'Page.screencastFrameAck').length, 2);
});
test('event microtask delivery and asynchronous ACK failure are observed without timing luck', async () => {
  const cdp = new CDP(self => new Promise(resolve => { queueMicrotask(() => { self.emit('Page.screencastFrame', event()); resolve({}); }); }),
    () => Promise.reject(new Error('ACK failed')));
  const result = await collectStaticFrame(cdp, setup(117), () => {});
  assert.equal(result.status, 'incomplete'); assert.ok(result.errors.some(e => e.phase === 'frame-ack'));
});
test('same ACK session with distinct timestamps during stop retains both deliveries without replacing first admission', async () => {
  let cdp;
  cdp = new CDP(self => { self.emit('Page.screencastFrame', event()); return {}; }, undefined, () => {
    cdp.emit('Page.screencastFrame', { ...event(), metadata: { ...metadata, timestamp: metadata.timestamp + 1 } }); return {};
  });
  const result = await collectStaticFrame(cdp, setup(117), () => {});
  assert.equal(result.status, 'complete'); assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames.map(frame => frame.sessionId), [1, 1]);
  assert.deepEqual(result.frames.map(frame => frame.metadata.timestamp), [metadata.timestamp, metadata.timestamp + 1]);
  assert.equal(result.admission.classifier, 117);
  assert.equal(cdp.commands.filter(command => command.method === 'Page.screencastFrameAck').length, 2);
});
test('identical contents remain separate delivery observations and receive separate ACKs', async () => {
  const cdp = new CDP(self => { self.emit('Page.screencastFrame', event()); self.emit('Page.screencastFrame', event()); return {}; });
  const result = await collectStaticFrame(cdp, setup(117), () => {});
  assert.equal(result.status, 'complete'); assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames[0], result.frames[1]);
  assert.equal(cdp.commands.filter(command => command.method === 'Page.screencastFrameAck').length, 2);
});
test('stop failure and detachment fail closed', async () => {
  const detached = await collectStaticFrame(new CDP(self => { self.emit('Disconnected'); return {}; }), setup(117), () => {});
  assert.equal(detached.status, 'incomplete'); assert.ok(detached.errors.length);
  const result = await collectStaticFrame(new CDP(self => { self.emit('Page.screencastFrame', event()); return {}; }, undefined,
    () => Promise.reject(new Error('stop failed'))), setup(117), () => {});
  assert.equal(result.status, 'incomplete'); assert.ok(result.errors.some(e => e.phase === 'stop'));
});
test('no-frame deadline is manually driven after subscription and never waits real time', async () => {
  const pending = new Map(); let next = 0;
  const timers = { setTimeout(callback) { const id = ++next; pending.set(id, callback); return id; }, clearTimeout(id) { pending.delete(id); } };
  const cdp = new CDP(() => { pending.get(1)(); return {}; });
  const result = await collectStaticFrame(cdp, setup(117), () => {}, timers);
  assert.equal(result.status, 'incomplete'); assert.ok(result.errors.some(e => e.phase === 'first-frame'));
  assert.equal(pending.size, 0);
});
