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
    'pack', '--ignore-scripts', '--json', '--pack-destination', root,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 30_000 }),
): Packed {
  const root = mkdtempSync(join(tmpdir(), 'journey-direct-package-'));
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
    pending() { return queue.length; },
    calls() { return calls; },
  };
}`;

const sheetConsumer = String.raw`
import assert from 'node:assert/strict';
import { createBottomSheet } from '@labpics/motion/behaviors';
${clockSource}
const clock = makeClock();
const sheet = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame: clock.requestFrame });
sheet.pointerDown({ x: 0, y: 0, t: 0 });
sheet.pointerMove({ x: 0, y: 180, t: 0.05 });
sheet.pointerUp({ x: 0, y: 180, t: 0.05 });
clock.step(); clock.step();
assert.equal(sheet.state.phase, 'release');
const boundary = { value: sheet.state.value, velocity: sheet.state.velocity };
assert.notEqual(boundary.velocity, 0);
sheet.update([0, 200, 400]);
assert.equal(sheet.state.value, boundary.value);
assert.equal(sheet.state.velocity, boundary.velocity);
// Новый ввод перехватывает того же владельца и гасит старое поколение.
sheet.pointerDown({ x: 0, y: boundary.value, t: 1 });
assert.equal(sheet.state.phase, 'follow');
clock.drain();
assert.equal(clock.pending(), 0);
sheet.pointerCancel(); clock.drain();
// Клавиатурному адаптеру достаточно публичного intent-вызова: без ручной
// передачи скорости, generation-token, коллекции cancel-handles или второго state-owner.
sheet.snapTo(2); clock.drain();
assert.equal(sheet.state.value, 400);
assert.equal(sheet.state.snapIndex, 2);
sheet.destroy();

const reducedClock = makeClock();
const reduced = createBottomSheet({
  snapPoints: [0, 200, 400], requestFrame: reducedClock.requestFrame,
  matchMedia: () => ({ matches: true }),
});
reduced.snapTo(2);
assert.equal(reduced.state.value, 400);
assert.equal(reducedClock.calls(), 0);
reduced.destroy();
console.log('journey-sheet-package: PASS');
`;

const pagerConsumer = String.raw`
import assert from 'node:assert/strict';
import { createCarousel } from '@labpics/motion/behaviors';
${clockSource}
const clock = makeClock();
const pager = createCarousel({ pageCount: 4, pageSize: 200, index: 1, rtl: true, requestFrame: clock.requestFrame });
pager.goTo(3); clock.step(); clock.step();
assert.equal(pager.state.phase, 'release');
const boundary = { value: pager.state.value, velocity: pager.state.velocity };
assert.notEqual(boundary.velocity, 0);
pager.update(4, 120);
assert.equal(pager.state.value, boundary.value);
assert.equal(pager.state.velocity, boundary.velocity);
clock.drain();
assert.equal(pager.state.index, 3);
assert.equal(pager.state.value, 360);
// Эквивалентные клавиатурные intents используют того же владельца и clock.
pager.prev(); clock.drain();
assert.equal(pager.state.index, 2);
pager.next(); clock.drain();
assert.equal(pager.state.index, 3);
// RTL-направление pointer остаётся семантикой того же поставляемого controller.
pager.pointerDown({ x: 0, y: 0, t: 1 });
pager.pointerMove({ x: -120, y: 0, t: 1.05 });
pager.pointerUp({ x: -120, y: 0, t: 1.05 });
clock.drain();
assert.equal(pager.state.index, 2);
pager.destroy();

const reducedClock = makeClock();
const reduced = createCarousel({
  pageCount: 3, pageSize: 100, requestFrame: reducedClock.requestFrame,
  matchMedia: () => ({ matches: true }),
});
reduced.next();
assert.equal(reduced.state.index, 1);
assert.equal(reduced.state.value, 100);
assert.equal(reducedClock.calls(), 0);
reduced.destroy();
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
// Commit принадлежит приложению: новый порядок, вставка и геометрия приходят через update().
items = itemsFor(['b', 'c', 'a', 'x']);
controller.update(items);
assert.equal(controller.isCurrent(accepted), false);
assert.equal(keyboard.active, true);
// Фильтрация активной identity отзывает сессию; отложенное старое предложение уже невалидно.
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
// Приложение подтверждает данные и присылает новую геометрию; resolver не держит второй store.
items = layout(['b', 'c', 'a', 'd'], 200);
controller.update(items);
assert.equal(controller.isCurrent(first), false);
assert.equal(session.active, true);
session.move({ x: 250, y: 250 });
assert.deepEqual(proposals.at(-1).keys, ['b', 'c', 'd', 'a']);
const second = proposals.at(-1).proposal;
assert.equal(controller.isCurrent(second), true);
// Фильтр удаляет активный ключ, а новый ключ после update становится обычной stable identity.
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

  it('sheet: перехват, живые ограничения, intent-управление и reduced motion', () => {
    const output = installConsumer(packed.root, 'sheet-app', packed.tarball, sheetConsumer);
    expect(output).toContain('journey-sheet-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('pager: resize, RTL, intent-управление и reduced motion', () => {
    const output = installConsumer(packed.root, 'pager-app', packed.tarball, pagerConsumer);
    expect(output).toContain('journey-pager-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('list: RTL pointer/keyboard, app-owned commit, insert/remove и stale revoke', () => {
    const output = installConsumer(packed.root, 'list-app', packed.tarball, listConsumer);
    expect(output).toContain('journey-list-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('grid: новая geometry, app-owned commit, filter/insert и stale revoke', () => {
    const output = installConsumer(packed.root, 'grid-app', packed.tarball, gridConsumer);
    expect(output).toContain('journey-grid-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
});
