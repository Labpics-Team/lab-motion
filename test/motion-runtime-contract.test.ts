import { describe, expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

describe('единый runtime: временной контракт', () => {
  for (const native of [false, true]) it(`stop/finish и завершение одинаковы, native=${native}`, async () => {
    const h = harness(native);
    const a = h.runtime.animate(h.element, { x: 100, opacity: 1 }, { duration: 1000, ease: 'linear' });
    a.seek(250);
    expect(h.x()).toBe(25);
    a.pause(); a.seek(500); expect(a.state).toBe('paused'); expect(h.x()).toBe(50);
    a.play(); expect(a.state).toBe('running');
    a.stop(); expect(await a.finished).toEqual({ status: 'stopped' });
    const writes = h.writes.length;
    a.finish(); a.play(); a.pause(); a.seek(100);
    expect(h.writes).toHaveLength(writes);
    const b = h.runtime.animate(h.element, { x: 0 }, { duration: 200, ease: 'linear' });
    b.finish(); expect(await b.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(0);
    expect(h.updates.size + h.renders.size).toBe(0);
    expect(h.effects.every(effect => effect.cancelled)).toBe(true);
  });

  it('повторные цели сохраняют native effects; изменение x не прерывает opacity', async () => {
    const h = harness(true);
    const a = h.runtime.animate(h.element, { x: 100, opacity: 1 }, { duration: 1000, ease: 'linear' });
    expect(h.effects).toHaveLength(2);
    h.effects[0]!.currentTime = 200; h.effects[1]!.currentTime = 200;
    const same = h.runtime.animate(h.element, { x: 100, opacity: 1 }, { duration: 1000, ease: 'linear' });
    expect(h.effects).toHaveLength(2); expect(h.effects.every(e => !e.cancelled)).toBe(true);
    const x = h.runtime.animate(h.element, { x: 200 }, { duration: 1000, ease: 'linear' });
    expect(h.effects[1]!.cancelled).toBe(false);
    expect(h.x()).toBe(20);
    h.effects[1]!.complete(); x.finish();
    expect(await a.finished).toEqual({ status: 'stopped' });
    expect(await same.finished).toEqual({ status: 'stopped' });
    expect(await x.finished).toEqual({ status: 'finished' });
  });

  it('изменение x сохраняет исходную временную шкалу y', async () => {
    const h = harness(false);
    const a = h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' });
    h.step(250); expect(h.x()).toBe(25); expect(h.y()).toBe(50);
    const b = h.runtime.animate(h.element, { x: 50 }, { duration: 1000, ease: 'linear' });
    h.step(500); expect(h.x()).toBe(31.25); expect(h.y()).toBe(100);
    h.step(1000); expect(h.y()).toBe(200);
    h.step(1250); expect(h.x()).toBe(50);
    expect(await a.finished).toEqual({ status: 'stopped' });
    expect(await b.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('частичная пауза native-группы сохраняет продолжающийся канал', async () => {
    const h = harness(true);
    const a = h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' });
    h.effects[0]!.currentTime = 200;
    const x = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
    x.pause();
    h.step(400); expect(h.x()).toBe(20); expect(h.y()).toBe(120);
    x.finish(); h.effects.at(-1)!.currentTime = 1000; h.effects.at(-1)!.complete();
    expect(await a.finished).toEqual({ status: 'stopped' });
    expect(await x.finished).toEqual({ status: 'finished' });
  });

  it('массивы проигрываются каждый раз и не теряют промежуточные точки', async () => {
    const h = harness();
    const a = h.runtime.animate(h.element, { x: [0, 100, -50, 0] }, { duration: 300, ease: 'linear' });
    a.seek(100); expect(h.x()).toBe(100);
    a.seek(200); expect(h.x()).toBe(-50);
    a.seek(150); expect(h.x()).toBe(25);
    const b = h.runtime.animate(h.element, { x: [0, 100, -50, 0] }, { duration: 300, ease: 'linear' });
    expect(await a.finished).toEqual({ status: 'stopped' }); expect(h.x()).toBe(0);
    b.finish(); expect(await b.finished).toEqual({ status: 'finished' });
  });

  it('последовательность использует миллисекунды, промежутки и независимые свойства', async () => {
    const h = harness();
    const c = h.runtime.sequence([
      [h.element, { x: 100 }, { duration: 100, ease: 'linear' }],
      [h.element, { y: 50 }, { at: 50, duration: 100, ease: 'linear' }],
      [h.element, { x: 200 }, { at: 200, duration: 100, ease: 'linear' }],
    ]);
    expect(c.duration).toBe(300);
    c.seek(75); expect(h.x()).toBe(75); expect(h.y()).toBe(12.5);
    c.seek(150); expect(h.x()).toBe(100); expect(h.y()).toBe(50);
    c.seek(250); expect(h.x()).toBe(150);
    c.pause(); c.seek(25); expect(h.x()).toBe(25); expect(c.state).toBe('paused');
    c.finish(); expect(await c.finished).toEqual({ status: 'finished' }); expect(h.x()).toBe(200);
  });

  it('ошибка позднего свойства не меняет уже работающее движение', () => {
    const h = harness();
    const a = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
    h.step(200); const writes = h.writes.length;
    expect(() => h.runtime.animate(h.element, { x: 200, opacity: NaN })).toThrow();
    expect(h.writes.length).toBe(writes);
    h.step(500); expect(h.x()).toBe(50); a.stop();
  });

  it('исключение easing завершает все каналы прогона и передаётся finished', async () => {
    const h = harness(); const error = new Error('easing');
    const a = h.runtime.animate(h.element, { x: 100, opacity: 1 }, { duration: 1000, ease(t) { if (t > 0) throw error; return t; } });
    h.step(500); await expect(a.finished).rejects.toBe(error);
    expect(a.state).toBe('failed'); expect(h.updates.size + h.renders.size).toBe(0);
  });
});
