import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Packed = { readonly root: string; readonly tarball: string; readonly sha256: string };

function packOnce(): Packed {
  const root = mkdtempSync(join(tmpdir(), 'journey-direct-package-'));
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', root,
  ], { cwd: resolve('.'), encoding: 'utf8', timeout: 30_000 })) as Array<{ filename: string }>;
  expect(packed).toHaveLength(1);
  const tarball = join(root, packed[0]!.filename);
  return {
    root,
    tarball,
    sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
  };
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
// New pointer input owns the same controller and kills the queued old generation.
sheet.pointerDown({ x: 0, y: boundary.value, t: 1 });
assert.equal(sheet.state.phase, 'follow');
clock.drain();
assert.equal(clock.pending(), 0);
sheet.pointerCancel(); clock.drain();
// Native keyboard controls only need this public intent operation; no app-side
// velocity handoff, generation token, cancel collection or second state owner.
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
// Keyboard-equivalent intents use the same public owner and clock.
pager.prev(); clock.drain();
assert.equal(pager.state.index, 2);
pager.next(); clock.drain();
assert.equal(pager.state.index, 3);
// RTL pointer direction remains part of the same shipped controller semantics.
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

describe('JOURNEY-01 direct-control family — two independent real-package consumers', () => {
  let packed: Packed;

  beforeAll(() => {
    packed = packOnce();
  }, 30_000);

  afterAll(() => {
    if (packed) rmSync(packed.root, { recursive: true, force: true });
  });

  it('sheet consumer: interruption, live constraints, intent control and reduced motion', () => {
    const output = installConsumer(packed.root, 'sheet-app', packed.tarball, sheetConsumer);
    expect(output).toContain('journey-sheet-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('pager consumer: resize, RTL, intent control and reduced motion', () => {
    const output = installConsumer(packed.root, 'pager-app', packed.tarball, pagerConsumer);
    expect(output).toContain('journey-pager-package: PASS');
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
});
