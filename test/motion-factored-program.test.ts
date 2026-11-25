import { expect, it } from 'vitest';
import { properties, timing } from '../src/motion/model.js';
import { harness } from './fixtures/motion-runtime.js';

const options = { duration: 1000, ease: 'linear' } as const;

it('one literal authored declaration produces one immutable program for the entire batch', async () => {
  const hosts = Array.from({ length: 20 }, () => harness());
  const engine = hosts[0]!.runtime;
  const drafts = engine._draft(hosts.map(h => h.element), properties({ width: [0, 100, 300] }), timing(options));
  expect(new Set(drafts.map(draft => draft._program)).size).toBe(1);
  const run = engine._execute(drafts);
  try {
    run.seek(250);
    for (const h of hosts) expect(h.values.get('width')).toBe('50px');
    const next = engine.animate(hosts[0]!.element, { width: [50, 600] }, options);
    run.seek(750);
    expect(hosts[0]!.values.get('width')).toBe('50px');
    for (const h of hosts.slice(1)) expect(h.values.get('width')).toBe('200px');
    run.finish(); next.finish();
    expect(await run.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(hosts[0]!.values.get('width')).toBe('600px');
    for (const h of hosts.slice(1)) expect(h.values.get('width')).toBe('300px');
  } finally { run.stop(); }
});

it('element-specific variable values and staggered time are not shared', () => {
  const a = harness(), b = harness();
  a.values.set('--end', '100px'); b.values.set('--end', '200px');
  const engine = a.runtime;
  const drafts = engine._draft([a.element, b.element], properties({ width: ['0px', 'var(--end)'] }), timing(options));
  expect(drafts[0]!._program).not.toBe(drafts[1]!._program);
  const run = engine._execute(drafts);
  run.seek(500); expect(a.values.get('width')).toBe('50px'); expect(b.values.get('width')).toBe('100px');
  run.stop();
  const staggered = engine.animate([a.element, b.element], { width: [0, 100] }, { ...options, stagger: 250 });
  staggered.seek(500); expect(a.values.get('width')).toBe('50px'); expect(b.values.get('width')).toBe('25px');
  staggered.stop();
});

it('sequence creates independent histories from shared input programs', async () => {
  const a = harness(), b = harness();
  const run = a.runtime.sequence([
    [[a.element, b.element], { x: [0, 100] }, options],
    [a.element, { x: 300 }, options],
  ]);
  run.seek(1500); expect(a.x()).toBe(200); expect(b.x()).toBe(100);
  run.seek(500); expect(a.x()).toBe(50); expect(b.x()).toBe(50);
  run.finish();
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(a.x()).toBe(300); expect(b.x()).toBe(100);
});

it('mixed declaration shares only its literal authored channel and keeps target-specific origins', () => {
  const a = harness(), b = harness();
  b.values.set('transform', 'translateX(40px)');
  a.values.set('--end', '10px'); b.values.set('--end', '20px');
  const drafts = a.runtime._draft([a.element, b.element], properties({
    x: 100, width: [0, 20, 40], height: ['0px', 'var(--end)'],
  }), timing(options));
  expect(drafts[1]!._program).toBe(drafts[4]!._program);
  expect(drafts[0]!._program).not.toBe(drafts[3]!._program);
  expect(drafts[2]!._program).not.toBe(drafts[5]!._program);
  const run = a.runtime._execute(drafts);
  run.seek(500);
  expect(a.x()).toBe(50); expect(b.x()).toBe(70);
  expect(a.values.get('width')).toBe('20px'); expect(b.values.get('width')).toBe('20px');
  expect(a.values.get('height')).toBe('5px'); expect(b.values.get('height')).toBe('10px');
  run.stop();
});
