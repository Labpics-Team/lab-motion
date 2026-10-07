import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Packed = { readonly root: string; readonly tarball: string; readonly sha256: string };

function packOnce(
  runPack: (root: string) => string = (root) => execFileSync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', process.platform === 'win32' ? `"${root}"` : root,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' }),
): Packed {
  // Пробел выявляет потерю границы аргумента в Windows shell.
  const root = mkdtempSync(join(tmpdir(), 'journey direct package-'));
  try {
    const packed = JSON.parse(runPack(root)) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);
    const tarball = join(root, packed[0]!.filename);
    return {
      root,
      tarball,
      sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function installConsumer(root: string, name: string, tarball: string, source: string): string {
  const work = join(root, name);
  const moduleRoot = join(work, 'node_modules', '@labpics', 'motion');
  mkdirSync(moduleRoot, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', moduleRoot, '--strip-components=1']);
  writeFileSync(join(work, 'package.json'), '{"type":"module"}');
  const entry = join(work, 'consumer.mjs');
  writeFileSync(entry, source);
  return execFileSync(process.execPath, [entry], {
    cwd: work,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const clockSource = String.raw`
function makeClock() {
  let now = 0;
  let calls = 0;
  const queue = [];
  return {
    requestFrame(cb) { calls++; queue.push(cb); return calls; },
    step(ms = 16) {
      now += ms;
      const batch = queue.splice(0);
      for (const cb of batch) cb(now);
    },
    drain(limit = 4000) {
      let steps = 0;
      while (queue.length) {
        if (++steps > limit) throw new Error('clock did not settle');
        this.step(16);
      }
    },
    now() { return now; },
    pending() { return queue.length; },
    calls() { return calls; },
  };
}`;

const sheetConsumer = String.raw`
import assert from 'node:assert/strict';
import { createCompositorFollow } from '@labpics/motion/compositor/follow';
${clockSource}
const clock = makeClock();
let snaps = [0, 300, 600], selected = 2, writes = 0;
const motion = createCompositorFollow({
  spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'transform',
  from: 0, to: 0, apply() { writes++; }, now: clock.now, requestFrame: clock.requestFrame,
});
motion.beginFollow(0); motion.follow(180, 0.05); motion.settle(snaps[selected], 0.05);
clock.step(); clock.step();
assert.ok(motion.value > 180, 'release не продолжил движение');
const beforeResize = motion.value;
snaps = [0, 200, 400]; motion.retarget(snaps[selected]);
assert.equal(motion.value, beforeResize, 'новая геометрия вызвала скачок');
clock.step(); clock.step();
const beforePickup = motion.value;
assert.equal(motion.beginFollow(1), beforePickup);
motion.follow(beforePickup + 20, 1.05);
const inputValue = motion.value, afterInputWrites = writes;
clock.drain();
assert.equal(motion.value, inputValue, 'старый release изменил новый ввод');
assert.equal(writes, afterInputWrites, 'старый callback получил право записи');
assert.equal(clock.pending(), 0);
motion.settle(snaps[selected], 1.05); clock.drain();
assert.equal(motion.value, 400);
selected = 1; motion.retarget(snaps[selected]); clock.drain();
assert.equal(motion.value, 200);
selected = 2; motion.retarget(snaps[selected]); clock.drain();
assert.equal(motion.value, 400);
motion.destroy();

const reducedClock = makeClock();
const reduced = createCompositorFollow({
  spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'transform', from: 0, to: 0,
  apply() {}, requestFrame: reducedClock.requestFrame, matchMedia: () => ({ matches: true }),
});
reduced.retarget(snaps[selected]);
assert.equal(reduced.value, 400);
assert.equal(reducedClock.calls(), 0);
assert.equal(reducedClock.pending(), 0);
reduced.destroy();
console.log('journey-sheet-package: PASS');
`;

const pagerConsumer = String.raw`
import assert from 'node:assert/strict';
import { createCompositorFollow } from '@labpics/motion/compositor/follow';
${clockSource}
function pager(rtl, reduced = false) {
  const clock = makeClock();
  const direction = rtl ? 1 : -1;
  let size = 200, selected = 1;
  const motion = createCompositorFollow({
    spring: { mass: 1, stiffness: 170, damping: 26 }, property: 'transform',
    from: direction * size, to: direction * size, apply() {},
    now: clock.now, requestFrame: clock.requestFrame, matchMedia: () => ({ matches: reduced }),
  });
  const target = () => direction * selected * size;
  return { motion, clock,
    get selected() { return selected; },
    select(index) { selected = Math.max(0, Math.min(3, index)); motion.retarget(target()); },
    resize(nextSize) { size = nextSize; motion.retarget(target()); },
    drag(delta) {
      const origin = motion.beginFollow(1);
      motion.follow(origin + delta, 1.05);
      selected = Math.max(0, Math.min(3, Math.round(motion.value / (direction * size))));
      motion.settle(target(), 1.05);
    },
  };
}
const rtl = pager(true);
rtl.select(3); rtl.clock.step(); rtl.clock.step();
assert.ok(rtl.motion.value > 200);
const beforeResize = rtl.motion.value;
rtl.resize(120);
assert.equal(rtl.motion.value, beforeResize);
rtl.clock.drain();
assert.equal(rtl.selected, 3); assert.equal(rtl.motion.value, 360);
rtl.select(rtl.selected - 1); rtl.clock.drain();
assert.equal(rtl.motion.value, 240);
rtl.select(rtl.selected + 1); rtl.clock.drain();
assert.equal(rtl.motion.value, 360);
rtl.select(1); rtl.clock.drain(); rtl.drag(-120); rtl.clock.drain();
assert.equal(rtl.selected, 0); assert.equal(rtl.motion.value, 0);

const ltr = pager(false);
ltr.resize(120); ltr.clock.drain(); ltr.drag(-120); ltr.clock.drain();
assert.equal(ltr.selected, 2); assert.equal(ltr.motion.value, -240);
rtl.motion.destroy(); ltr.motion.destroy();

const reduced = pager(false, true);
reduced.resize(100); reduced.select(2);
assert.equal(reduced.selected, 2); assert.equal(reduced.motion.value, -200);
assert.equal(reduced.clock.calls(), 0); assert.equal(reduced.clock.pending(), 0);
reduced.motion.destroy();
console.log('journey-pager-package: PASS');
`;

const listConsumer = String.raw`
import assert from 'node:assert/strict';
import { createReorder } from '@labpics/motion/behaviors/reorder';
const rect = (x) => ({ x, y: 0, width: 20, height: 20 });
const physicalX = { a: 0, b: 40, c: 80, x: 120 };
const itemsFor = (keys) => keys.map((key) => ({ key, rect: rect(physicalX[key]) }));
let items = itemsFor(['c', 'b', 'a']);
const proposals = [];
const controller = createReorder({
  items,
  axis: 'x',
  direction: 'rtl',
  onReorder(keys, proposal) { proposals.push({ keys: [...keys], proposal }); },
});
const pointer = controller.start('b');
pointer.move({ x: 90, y: 10 });
assert.deepEqual(proposals.at(-1).keys, ['b', 'c', 'a']);
const pointerProposal = proposals.at(-1).proposal;
assert.equal(controller.isCurrent(pointerProposal), true);
pointer.cancel();
const keyboard = controller.start('b');
keyboard.step('right');
assert.deepEqual(proposals.at(-1).keys, ['b', 'c', 'a']);
const accepted = proposals.at(-1).proposal;
// Подтверждение принадлежит приложению: новый порядок, вставка и геометрия приходят через update().
items = itemsFor(['b', 'c', 'a', 'x']);
controller.update(items);
assert.equal(controller.isCurrent(accepted), false);
assert.equal(keyboard.active, true);
// Фильтрация активной идентичности отзывает сессию; отложенное старое предложение уже невалидно.
controller.update(itemsFor(['c', 'a', 'x']));
assert.equal(keyboard.active, false);
assert.equal(controller.activeKey, undefined);
assert.equal(controller.isCurrent(accepted), false);
controller.destroy();
console.log('journey-list-package: PASS');
`;

const gridConsumer = String.raw`
import assert from 'node:assert/strict';
import { createReorder } from '@labpics/motion/behaviors/reorder';
const rect = (x, y) => ({ x, y, width: 20, height: 20 });
const layout = (keys, shift = 0) => keys.map((key, i) => ({
  key,
  rect: rect(shift + (i % 2) * 40, shift + Math.floor(i / 2) * 40),
}));
let items = layout(['a', 'b', 'c', 'd']);
const proposals = [];
const controller = createReorder({
  items,
  axis: 'both',
  onReorder(keys, proposal) { proposals.push({ keys: [...keys], proposal }); },
});
const session = controller.start('a');
session.step('down');
assert.deepEqual(proposals.at(-1).keys, ['b', 'c', 'a', 'd']);
const first = proposals.at(-1).proposal;
assert.equal(controller.isCurrent(first), true);
assert.deepEqual(items.map(({ key }) => key), ['a', 'b', 'c', 'd']);
// Приложение подтверждает данные и присылает новую геометрию; решатель не держит второе хранилище.
items = layout(['b', 'c', 'a', 'd'], 200);
controller.update(items);
assert.equal(controller.isCurrent(first), false);
assert.equal(session.active, true);
session.move({ x: 250, y: 250 });
assert.deepEqual(proposals.at(-1).keys, ['b', 'c', 'd', 'a']);
const second = proposals.at(-1).proposal;
assert.equal(controller.isCurrent(second), true);
// Фильтр удаляет активный ключ, а новый ключ после update становится обычной стабильной идентичностью.
items = layout(['b', 'c', 'd', 'e'], -100);
controller.update(items);
assert.equal(session.active, false);
assert.equal(controller.isCurrent(second), false);
const inserted = controller.start('e');
assert.equal(inserted.active, true);
inserted.step('first');
assert.deepEqual(proposals.at(-1).keys, ['e', 'b', 'c', 'd']);
controller.destroy();
console.log('journey-grid-package: PASS');
`;

const smartWorldSource = String.raw`
function makeSmartClock() {
  let now = 0;
  let calls = 0;
  const queue = [];
  return {
    requestFrame(cb) { calls++; queue.push(cb); return calls; },
    step(ms = 16) {
      now += ms;
      const batch = queue.splice(0);
      for (const cb of batch) cb(now);
    },
    drain(limit = 4000) {
      let steps = 0;
      while (queue.length) {
        if (++steps > limit) throw new Error('smart clock did not settle');
        this.step(16);
      }
    },
    now() { return now; },
    pending() { return queue.length; },
    calls() { return calls; },
  };
}
function parseTransform(raw) {
  const m = /^translate\(([-+\d.eE]+)px, ([-+\d.eE]+)px\) scale\(([-+\d.eE]+), ([-+\d.eE]+)\)$/.exec(raw);
  return m ? { tx: Number(m[1]), ty: Number(m[2]), sx: Number(m[3]), sy: Number(m[4]) } : null;
}
function makeSmartWorld() {
  function element(name, key, rect, children = []) {
    const inline = new Map();
    const attrs = new Map();
    const writes = [];
    if (key !== null) attrs.set('data-motion-key', key);
    const el = {
      name, rect: { ...rect }, children, shadowRoot: null, isConnected: true,
      focused: false, measures: 0, writes,
      computed: { 'border-radius': '0px' },
      style: {
        setProperty(prop, value) { writes.push({ prop, value }); inline.set(prop, value); },
        removeProperty(prop) { writes.push({ prop, value: null }); inline.delete(prop); },
        getPropertyValue(prop) { return inline.get(prop) ?? ''; },
      },
      getAttribute(prop) { return attrs.get(prop) ?? null; },
      getBoundingClientRect() {
        el.measures++;
        const t = parseTransform(inline.get('transform') ?? '');
        return {
          x: el.rect.x + (t?.tx ?? 0), y: el.rect.y + (t?.ty ?? 0),
          width: el.rect.width * (t?.sx ?? 1), height: el.rect.height * (t?.sy ?? 1),
        };
      },
    };
    return el;
  }
  function root(rect, children) {
    const r = element('root', null, rect, children);
    r.clientLeft = 0; r.clientTop = 0;
    r.appendChild = (node) => { if (!r.children.includes(node)) r.children.push(node); node.isConnected = true; return node; };
    r.removeChild = (node) => { const i = r.children.indexOf(node); if (i >= 0) r.children.splice(i, 1); node.isConnected = false; return node; };
    return r;
  }
  return { element, root };
}
function smartOptions(clock, extra = {}) {
  return {
    requestFrame: clock.requestFrame,
    getScroll: () => ({ x: 0, y: 0 }),
    getComputedStyle: (el) => ({ getPropertyValue: (name) => el.computed[name] ?? '' }),
    ...extra,
  };
}
function transforms(el) {
  return el.writes.filter((w) => w.prop === 'transform' && typeof w.value === 'string').map((w) => w.value);
}
`;

const cardDetailsConsumer = String.raw`
import assert from 'node:assert/strict';
import { captureSmart } from '@labpics/motion/smart';
${smartWorldSource}
const world = makeSmartWorld();
const media = world.element('media', 'media', { x: 12, y: 12, width: 48, height: 48 });
const card = world.element('card', 'card', { x: 0, y: 0, width: 120, height: 80 }, [media]);
const root = world.root({ x: 0, y: 0, width: 640, height: 720 }, [card]);
const clock = makeSmartClock();
const options = smartOptions(clock);
const first = captureSmart(root, options);
card.rect = { x: 40, y: 30, width: 360, height: 300 };
media.rect = { x: 80, y: 90, width: 200, height: 120 };
const h1 = first.animate();
assert.deepEqual(h1.plan.matched, ['card', 'media']);
for (let i = 0; i < 4; i++) clock.step();
const beforeTransform = parseTransform(transforms(card).at(-1));
assert.ok(beforeTransform);
const visualBefore = card.rect.x + beforeTransform.tx;
const cardMeasures = card.measures;
const mediaMeasures = media.measures;
const second = captureSmart(root, options);
assert.equal(card.measures, cardMeasures);
assert.equal(media.measures, mediaMeasures);
card.rect = { x: 20, y: 50, width: 420, height: 360 };
media.rect = { x: 64, y: 130, width: 260, height: 160 };
const h2 = second.animate();
await h1.finished;
assert.deepEqual(h2.plan.matched, ['card', 'media']);
const afterTransform = parseTransform(transforms(card).at(-1));
assert.ok(afterTransform);
assert.ok(Math.abs((card.rect.x + afterTransform.tx) - visualBefore) < 1e-6);
clock.drain();
await h2.finished;
assert.equal(card.style.getPropertyValue('transform'), '');
assert.equal(media.style.getPropertyValue('transform'), '');

// Нет изменения геометрии — нет анимационной работы и второго протокола.
const noMotionCalls = clock.calls();
const still = captureSmart(root, options).animate();
await still.finished;
assert.deepEqual(still.plan, { matched: [], entered: [], exited: [], skipped: [] });
assert.equal(clock.calls(), noMotionCalls);

// Сокращённое движение сохраняет ту же конечную раскладку без кадров преобразования.
const reducedWorld = makeSmartWorld();
const reducedCard = reducedWorld.element('card', 'card', { x: 0, y: 0, width: 120, height: 80 });
const reducedRoot = reducedWorld.root({ x: 0, y: 0, width: 640, height: 720 }, [reducedCard]);
const reducedClock = makeSmartClock();
const reducedCapture = captureSmart(reducedRoot, smartOptions(reducedClock, { matchMedia: () => ({ matches: true }) }));
reducedCard.rect = { x: 90, y: 80, width: 320, height: 240 };
const reduced = reducedCapture.animate();
assert.equal(reduced.tier, 'reduced');
await reduced.finished;
assert.equal(transforms(reducedCard).length, 0);
assert.equal(reducedClock.calls(), 0);
console.log('journey-card-details-package: PASS');
`;

const panelSourceConsumer = String.raw`
import assert from 'node:assert/strict';
import { captureSmart } from '@labpics/motion/smart';
${smartWorldSource}
const world = makeSmartWorld();
let surface = world.element('source', 'surface', { x: 300, y: 20, width: 80, height: 40 });
const root = world.root({ x: 0, y: 0, width: 720, height: 640 }, [surface]);
const clock = makeSmartClock();
const options = smartOptions(clock);
const openCapture = captureSmart(root, options);
const source = surface;
source.isConnected = false;
surface = world.element('panel', 'surface', { x: 40, y: 60, width: 420, height: 300 });
root.children = [surface];
const opening = openCapture.animate();
assert.deepEqual(opening.plan.matched, ['surface']);
for (let i = 0; i < 4; i++) clock.step();
const beforeTransform = parseTransform(transforms(surface).at(-1));
assert.ok(beforeTransform);
const visualBefore = surface.rect.x + beforeTransform.tx;
const measuresBefore = surface.measures;
const closeCapture = captureSmart(root, options);
assert.equal(surface.measures, measuresBefore);
const panel = surface;
panel.isConnected = false;
surface = world.element('source-again', 'surface', { x: 300, y: 20, width: 80, height: 40 });
root.children = [surface];
const closing = closeCapture.animate();
await opening.finished;
assert.deepEqual(closing.plan.matched, ['surface']);
const firstClose = parseTransform(transforms(surface).at(-1));
assert.ok(firstClose);
assert.ok(Math.abs((surface.rect.x + firstClose.tx) - visualBefore) < 1e-6);
clock.drain();
await closing.finished;

// Повторное открытие использует ту же стабильную идентичность, а не новое хранилище или владельца.
const reopenCapture = captureSmart(root, options);
surface.isConnected = false;
surface = world.element('panel-again', 'surface', { x: 60, y: 70, width: 400, height: 280 });
root.children = [surface];
const reopened = reopenCapture.animate();
assert.deepEqual(reopened.plan.matched, ['surface']);
clock.drain();
await reopened.finished;
assert.equal(surface.style.getPropertyValue('transform'), '');
console.log('journey-panel-source-package: PASS');
`;

describe('JOURNEY-01: независимые потребители реального пакета', () => {
  it('ошибка упаковки не оставляет временный каталог без владельца', () => {
    const marker = new Error('pack failed');
    let root = '';
    expect(() => packOnce((createdRoot) => {
      root = createdRoot;
      throw marker;
    })).toThrow(marker);
    expect(root).not.toBe('');
    expect(existsSync(root)).toBe(false);
  });

  let packed: Packed;

  beforeAll(() => {
    packed = packOnce();
  }, 30_000);

  afterAll(() => {
    if (packed) rmSync(packed.root, { recursive: true, force: true });
  });

  it('sheet: перехват, живые ограничения, управление намерением и сокращённое движение', () => {
    const output = installConsumer(packed.root, 'sheet-app', packed.tarball, sheetConsumer);
    expect(output).toContain('journey-sheet-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('pager: изменение размера, RTL, управление намерением и сокращённое движение', () => {
    const output = installConsumer(packed.root, 'pager-app', packed.tarball, pagerConsumer);
    expect(output).toContain('journey-pager-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('list: RTL указатель/клавиатура, подтверждение приложения, вставка/удаление и отзыв устаревшего', () => {
    const output = installConsumer(packed.root, 'list-app', packed.tarball, listConsumer);
    expect(output).toContain('journey-list-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('grid: новая геометрия, подтверждение приложения, фильтр/вставка и отзыв устаревшего', () => {
    const output = installConsumer(packed.root, 'grid-app', packed.tarball, gridConsumer);
    expect(output).toContain('journey-grid-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('card↔details: вложенная геометрия, перехват, изменение размера, сокращённое и отсутствующее движение', () => {
    const output = installConsumer(packed.root, 'card-details-app', packed.tarball, cardDetailsConsumer);
    expect(output).toContain('journey-card-details-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('panel↔source: пересоздание, обратный ход и повторное открытие', () => {
    const output = installConsumer(packed.root, 'panel-source-app', packed.tarball, panelSourceConsumer);
    expect(output).toContain('journey-panel-source-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
});
