import { describe, expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { MotionResult } from '../src/motion/types.js';

const linear = { duration: 1200, ease: 'linear' } as const;
type Harness = ReturnType<typeof harness>;

function rotate(h: Harness): number {
  return Number(/rotate\(([^d]+)deg\)/.exec(h.values.get('transform') ?? '')?.[1] ?? 0);
}

describe('fallback takeover сохраняет последнюю успешную CSS-позу', () => {
  it.each([
    { property: 'rotate', target: 360, duration: 1800, visible: 0.6 },
    { property: 'x', target: 6, duration: 1200, visible: 0.015 },
    { property: 'y', target: 8, duration: 1200, visible: 0.02 },
    { property: 'opacity', target: 1, duration: 600, visible: 0.005 },
  ])('$property: более поздний clock не заменяет видимое начало', async ({ property, target, duration, visible }) => {
    const h = harness();
    const read = () => property === 'rotate' ? rotate(h)
      : property === 'x' ? h.x() : property === 'y' ? h.y() : Number(h.values.get('opacity'));
    const first = h.runtime.animate(h.element, { [property]: [0, target] }, { duration, ease: 'linear' });
    first.seek(3);
    expect(read()).toBeCloseTo(visible, 12);
    const before = h.values.get(property === 'opacity' ? 'opacity' : 'transform');
    // Clock продвинулся между CSS-записями; rAF ещё не материализовал эту фазу.
    h.setClock(12.8);
    const next = h.runtime.animate(h.element, { [property]: 0 }, { duration: 600, ease: 'linear' });
    expect(h.values.get(property === 'opacity' ? 'opacity' : 'transform')).toBe(before);
    expect(await first.finished).toEqual({ status: 'stopped' });
    const writes = h.writes.length;
    first.stop(); first.finish();
    expect(h.writes).toHaveLength(writes);
    next.finish();
    expect(read()).toBe(0);
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it.each(['paused', 'same-clock'] as const)('здоровый контроль %s сохраняет начало и завершение', async mode => {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: [0, 6] }, linear);
    first.seek(3);
    if (mode === 'paused') { first.pause(); h.setClock(12.8); }
    const before = h.values.get('transform');
    const next = h.runtime.animate(h.element, { x: 0 }, linear);
    expect(h.values.get('transform')).toBe(before);
    next.finish();
    expect(h.x()).toBe(0);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('между update и paint новая цель сохраняет ещё видимую CSS-позу', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: [0, 6] }, linear);
    first.seek(3);
    const before = h.values.get('transform');
    h.update(12.8);
    expect(h.values.get('transform')).toBe(before);
    const next = h.runtime.animate(h.element, { x: 0 }, linear);
    expect(h.values.get('transform')).toBe(before);
    h.paint();
    expect(h.values.get('transform')).toBe(before);
    next.finish();
    expect(h.x()).toBe(0);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('spring продолжает скорость последнего paint, а не скрытую скорость модели', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000, ease: t => t * t });
    h.step(250);
    expect(h.x()).toBe(6.25);
    const before = h.values.get('transform');
    // На paint скорость была 50 units/s; более поздний clock даёт модели 100.
    h.setClock(500);
    const next = h.runtime.animate(h.element, { x: 0 }, { spring: { mass: 1, stiffness: 100, damping: 20 } });
    expect(h.values.get('transform')).toBe(before);
    h.step(510);
    // Независимое решение x'' + 20x' + 100x = 0 при x(0)=6.25, x'(0)=50.
    const seconds = 0.01;
    const expected = Math.exp(-10 * seconds) * (6.25 + (50 + 10 * 6.25) * seconds);
    // Бюджет serialized spring здесь ≤6.25×0.001; ошибка live-velocity ≈0.452.
    expect(Math.abs(h.x() - expected)).toBeLessThan(0.01);
    next.finish();
    expect(h.x()).toBe(0);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('явное начало X не материализует скрытое продвижение Y общей поверхности', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: [0, 6], y: [0, 8] }, linear);
    first.seek(3);
    const visibleX = h.x(), before = h.values.get('transform');
    expect(visibleX).toBe(0.015); expect(h.y()).toBe(0.02);
    h.setClock(12.8);
    const next = h.runtime.animate(h.element, { x: [visibleX, 0] }, { duration: 600, ease: 'linear' });
    expect(h.values.get('transform')).toBe(before);
    expect(first.state).toBe('running');
    h.step(112.8);
    expect(h.x()).toBeCloseTo(visibleX * (1 - 100 / 600), 12);
    // У Y сохраняется исходная шкала: seek(3) + реальный wall-clock.
    expect(h.y()).toBeCloseTo(8 * (3 + 112.8) / 1200, 12);
    next.finish(); h.step(1200);
    expect(h.x()).toBe(0); expect(h.y()).toBe(8);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('canonical rotation сохраняет обороты вместе с нетронутой X-фазой', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { rotate: [720, 1080], x: [0, 6] }, linear);
    first.seek(600);
    expect(rotate(h)).toBe(900); expect(h.x()).toBe(3);
    const before = h.values.get('transform');
    h.setClock(12.8);
    const next = h.runtime.animate(h.element, { rotate: 720 }, { duration: 600, ease: 'linear' });
    expect(h.values.get('transform')).toBe(before);
    h.step(112.8);
    expect(rotate(h)).toBeCloseTo(900 + (720 - 900) * 100 / 600, 12);
    expect(h.x()).toBeCloseTo(6 * (600 + 112.8) / 1200, 12);
    next.seek(300); expect(rotate(h)).toBe(810);
    next.finish(); h.step(600);
    expect(rotate(h)).toBe(720); expect(h.x()).toBe(6);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('равная цель сохраняет траекторию и не выдаёт model sample за CSS-запись', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: 6, y: 8 }, linear);
    first.seek(3);
    const before = h.values.get('transform'), writes = h.writes.length;
    h.setClock(12.8);
    const same = h.runtime.animate(h.element, { x: 6 }, linear);
    expect(h.values.get('transform')).toBe(before);
    expect(h.writes).toHaveLength(writes);
    h.step(112.8);
    expect(h.x()).toBeCloseTo(6 * (3 + 112.8) / 1200, 12);
    expect(h.y()).toBeCloseTo(8 * (3 + 112.8) / 1200, 12);
    first.stop();
    same.seek(600); expect(h.x()).toBe(3);
    const owned = h.values.get('transform');
    first.finish(); expect(h.values.get('transform')).toBe(owned);
    same.finish(); expect(h.x()).toBe(6);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await same.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('третье намерение не теряет видимое начало и переживает поздние старые controls', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { rotate: [0, 360] }, { duration: 1800, ease: 'linear' });
    first.seek(3);
    h.setClock(12.8);
    const second = h.runtime.animate(h.element, { rotate: 0 }, { duration: 600, ease: 'linear' });
    const before = h.values.get('transform');
    h.setClock(25.6);
    const third = h.runtime.animate(h.element, { rotate: 180 }, { duration: 600, ease: 'linear' });
    expect(h.values.get('transform')).toBe(before);
    expect(rotate(h)).toBe(0.6);
    first.finish(); second.stop(); second.finish();
    expect(h.values.get('transform')).toBe(before);
    third.finish(); expect(rotate(h)).toBe(180);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await second.finished).toEqual({ status: 'stopped' });
    expect(await third.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  for (const nativeAvailable of [false, true]) for (const reduced of [false, true]) {
    it(`мгновенный X не завершает ещё не записанный Y: native=${nativeAvailable}, reduced=${reduced}`, async () => {
      const h = harness(nativeAvailable);
      h.host.supports = () => false;
      const first = h.runtime.animate(h.element, { y: 100 }, { duration: 100, ease: 'linear' });
      let result: MotionResult | undefined;
      void first.finished.then(value => { result = value; });
      h.step(25); expect(h.y()).toBe(25);
      h.setClock(150);
      h.host.supports = () => nativeAvailable;
      const next = h.runtime.animate(h.element, { x: 6 }, {
        duration: reduced ? 100 : 0, ease: 'linear', reducedMotion: reduced ? 'always' : 'user',
      });
      expect(h.x()).toBe(6); expect(h.y()).toBe(25);
      expect(first.state).toBe('running');
      expect(await next.finished).toEqual({ status: 'finished' });
      expect(result).toBeUndefined();
      expect(h.effects).toHaveLength(0);
      expect(h.updates.size + h.renders.size).toBeGreaterThan(0);
      h.step(150);
      expect(h.x()).toBe(6); expect(h.y()).toBe(100);
      expect(await first.finished).toEqual({ status: 'finished' });
      expect(h.updates.size + h.renders.size).toBe(0);
      expect(h.effects).toHaveLength(0);
    });
  }

  it('native takeover читает currentTime и сохраняет шкалу другого канала', async () => {
    const h = harness(true);
    const first = h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' });
    const effect = h.effects[0]!;
    effect.currentTime = 200;
    h.setClock(800);
    const next = h.runtime.animate(h.element, { x: 200 }, { duration: 1000, ease: 'linear' });
    expect(h.x()).toBe(20); expect(h.y()).toBe(40);
    expect(effect.cancelled).toBe(true); expect(h.effects).toHaveLength(1);
    h.step(900);
    expect(h.x()).toBe(38); expect(h.y()).toBe(60);
    next.finish();
    const returned = h.effects.at(-1)!;
    expect(returned).not.toBe(effect); expect(returned.cancelled).toBe(false);
    returned.currentTime = 1000; returned.complete();
    expect(h.x()).toBe(200); expect(h.y()).toBe(200);
    expect(await first.finished).toEqual({ status: 'stopped' });
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.effects.every(item => item.cancelled)).toBe(true);
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('отказ CSS-записи не превращает скрытое model value в новое начало', async () => {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000, ease: 'linear' });
    h.step(200); expect(h.x()).toBe(20);
    const before = h.values.get('transform'), failure = new Error('CSS write failed');
    const write = h.element.style.setProperty.bind(h.element.style);
    h.element.style.setProperty = () => { throw failure; };
    h.step(500);
    await expect(first.finished).rejects.toBe(failure);
    expect(first.state).toBe('failed'); expect(h.values.get('transform')).toBe(before);
    h.element.style.setProperty = write;
    const next = h.runtime.animate(h.element, { x: 0 }, { duration: 1000, ease: 'linear' });
    expect(h.x()).toBe(20);
    next.seek(500); expect(h.x()).toBe(10);
    next.finish(); expect(h.x()).toBe(0);
    expect(await next.finished).toEqual({ status: 'finished' });
    expect(h.updates.size + h.renders.size).toBe(0);
  });
});
