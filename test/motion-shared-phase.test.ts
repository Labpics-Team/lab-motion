import { expect, it } from 'vitest';
import { Run } from '../src/motion/runtime.js';
import { playhead } from '../src/motion/playhead.js';
import { harness } from './fixtures/motion-runtime.js';

const options = { duration: 1000, ease: 'linear' } as const;

it('one cohort shares its time, reads the clock once per frame, and forks only when a binding changes control', async () => {
  const hosts = Array.from({ length: 32 }, () => harness());
  const h = hosts[0]!;
  let reads = 0;
  const now = h.host.now;
  h.host.now = () => { reads++; return now(); };
  const old = playhead(h.runtime.animate(hosts.map(x => x.element), { width: 100, height: 200 }, options)) as Run & ReturnType<typeof playhead>;
  const phases = () => new Set([...old._tracks].map(track => track._phase));
  try {
    expect(old._tracks.size).toBe(64);
    expect(phases().size).toBe(1);
    reads = 0; h.step(125);
    expect(reads).toBe(1);
    expect(old.time).toBe(125);
    for (const target of hosts) {
      expect(target.values.get('width')).toBe('12.5px');
      expect(target.values.get('height')).toBe('25px');
    }
    const moved = playhead(h.runtime.animate(h.element, { width: 100 }, options)) as Run & ReturnType<typeof playhead>;
    try {
      expect(moved._tracks.size).toBe(1);
      expect([...moved._tracks][0]!._phase).toBe([...old._tracks][0]!._phase);
      moved.timeScale = 2;
      expect([...moved._tracks][0]!._phase).not.toBe([...old._tracks][0]!._phase);
      expect(phases().size).toBe(1);
      h.step(250);
      expect(moved.time).toBe(375); expect(old.time).toBe(250);
      expect(h.values.get('width')).toBe('37.5px');
      expect(h.values.get('height')).toBe('50px');
      for (const target of hosts.slice(1)) expect(target.values.get('width')).toBe('25px');
      moved.pause(); h.step(375);
      expect(moved.time).toBe(375); expect(old.time).toBe(375);
      moved.reverse(); moved.play(); h.step(425);
      expect(moved.time).toBe(275); expect(old.time).toBe(425);
      moved.finish(); expect(await moved.finished).toEqual({ status: 'finished' });
    } finally { moved.stop(); }
    old.finish(); expect(await old.finished).toEqual({ status: 'stopped' });
    expect(h.updates.size + h.renders.size).toBe(0);
  } finally { old.stop(); }
});

it('absolute phase is invariant to the number of frames and preserves a clamped backward host clock', () => {
  const a = harness(), b = harness();
  const ra = playhead(a.runtime.animate(a.element, { width: 100 }, options));
  const rb = playhead(b.runtime.animate(b.element, { width: 100 }, options));
  ra.seek(100); rb.seek(100); ra.timeScale = .7; rb.timeScale = .7;
  for (let i = 1; i <= 100; i++) a.step(i / 7);
  b.step(100 / 7);
  expect(ra.time).toBe(rb.time);
  expect(a.values.get('width')).toBe(b.values.get('width'));
  a.step(1); expect(ra.time).toBe(rb.time);
  a.step(30); expect(ra.time).toBe(121);
  ra.stop(); rb.stop();
});

it('native time does not advance a JS sibling and handoff reanchors only the detached binding', () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: 100, width: 100 }, options));
  const native = h.effects[0]!;
  native.currentTime = 250; h.step(100);
  const x = playhead(h.runtime.animate(h.element, { x: 100 }, options));
  expect(x.time).toBe(250); expect(run.time).toBe(100);
  x.reverse(); expect(native.cancelled).toBe(true);
  h.step(150); expect(x.time).toBe(200); expect(run.time).toBe(150);
  expect(h.x()).toBe(20); expect(h.values.get('width')).toBe('15px');
  x.stop(); run.stop();
});

it('advancing host reads during startup cannot create different initial phases', () => {
  const hosts = Array.from({ length: 50 }, () => harness());
  const h = hosts[0]!;
  let reads = 0;
  h.host.now = () => ++reads / 100;
  const run = h.runtime.animate(hosts.map(x => x.element), { width: 100, height: 200 }, options) as Run;
  expect(reads).toBe(2); // preparation and publication snapshots
  expect(new Set([...run._tracks].map(track => track._phase)).size).toBe(1);
  run.stop();
});
