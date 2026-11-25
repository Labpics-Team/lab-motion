import { expect, it } from 'vitest';
import { properties, timing } from '../src/motion/model.js';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';

const options = { duration: 1000, ease: 'linear' } as const;

it('the prepared binding and its unpublished CSS surface become the live binding without copying', async () => {
  const hosts = Array.from({ length: 24 }, () => harness());
  const h = hosts[0]!;
  const drafts = h.runtime._draft(hosts.map(x => x.element), properties({ width: 100, height: 200, x: 100, y: 200 }), timing(options));
  const surfaces = drafts.map(draft => draft._group);
  const run = h.runtime._execute(drafts) as Run;
  try {
    const accepted = [...run._tracks];
    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i]!;
      expect(accepted[i]).toBe(draft);
      expect(draft._group).toBe(surfaces[i]);
    }
    run.seek(250);
    for (const target of hosts) {
      expect(target.values.get('width')).toBe('25px');
      expect(target.values.get('height')).toBe('50px');
      expect(target.x()).toBe(25);
      expect(target.y()).toBe(50);
    }
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  } finally { run.stop(); }
});

it('publishing a prepared binding selects the currently registered surface after intervening adoption', async () => {
  const h = harness();
  const drafts = h.runtime._draft(h.element, properties({ width: [0, 200] }), timing(options));
  const retired = drafts[0]!._group;
  const intervening = h.runtime.animate(h.element, { width: 100 }, options) as Run;
  intervening.seek(250);
  const live = [...intervening._tracks][0]!._group;
  expect(live).not.toBe(retired);
  const run = h.runtime._execute(drafts) as Run;
  try {
    expect([...run._tracks][0]).toBe(drafts[0]);
    expect([...run._tracks][0]!._group).toBe(live);
    expect(await intervening.finished).toEqual({ status: 'stopped' });
    run.seek(500);
    expect(h.values.get('width')).toBe('100px');
    intervening.stop(); run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.values.get('width')).toBe('200px');
  } finally { run.stop(); intervening.stop(); }
});

it('batch startup captures one preparation and one publication time for every CSS surface', () => {
  const hosts = Array.from({ length: 25 }, () => harness());
  const h = hosts[0]!;
  let reads = 0;
  h.host.now = () => ++reads;
  const run = h.runtime.animate(hosts.map(x => x.element), { width: 100, height: 200, x: 100 }, options) as Run;
  try {
    expect(reads).toBe(2);
    expect(new Set([...run._tracks].map(track => track._group._stamp))).toEqual(new Set([2]));
    run.seek(500);
    for (const target of hosts) {
      expect(target.values.get('width')).toBe('50px');
      expect(target.values.get('height')).toBe('100px');
      expect(target.x()).toBe(50);
    }
  } finally { run.stop(); }
});

it('one successful clock snapshot advances all JS surfaces in an update frame', () => {
  const hosts = Array.from({ length: 24 }, () => harness());
  const h = hosts[0]!;
  const original = h.host.now;
  let reads = 0;
  h.host.now = () => { reads++; return original(); };
  const run = h.runtime.animate(hosts.map(x => x.element), { width: 100, height: 200 }, options);
  try {
    reads = 0; h.step(250);
    expect(reads).toBe(1);
    for (const target of hosts) {
      expect(target.values.get('width')).toBe('25px');
      expect(target.values.get('height')).toBe('50px');
    }
    reads = 0; h.step(750);
    expect(reads).toBe(1);
    for (const target of hosts) expect(target.values.get('width')).toBe('75px');
  } finally { run.stop(); }
});

it('a clock failure in one frame does not leave another independent run unsampled', async () => {
  const h = harness(), b = harness();
  const a = h.runtime.animate(h.element, { width: 100 }, options);
  const other = h.runtime.animate(b.element, { width: 200 }, options);
  const original = h.host.now;
  const failure = Error('clock failed');
  let fail = true;
  h.host.now = () => {
    if (fail) { fail = false; throw failure; }
    return original();
  };
  try {
    h.step(250);
    await expect(a.finished).rejects.toBe(failure);
    expect(other.state).toBe('running');
    expect(b.values.get('width')).toBe('50px');
  } finally { h.host.now = original; a.stop(); other.stop(); }
});
