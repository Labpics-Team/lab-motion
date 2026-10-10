import { describe, expect, it } from 'vitest';
import { animate as legacy } from '../src/animate/index.js';
import { surfaceRecord } from '../src/internal/surface.js';
import { harness } from './fixtures/motion-runtime.js';

const linear = (value: number): number => value;
const frame = (): (() => void) => () => {};
const options = { duration: 1000, ease: linear, requestFrame: frame };

function x(element: HTMLElement): number {
  const text = element.style.getPropertyValue('transform');
  return Number(/translate(?:X)?\(([^p]+)px/.exec(text)?.[1] ?? 0);
}

describe('один владелец CSS-декларации', () => {
  it('root принимает legacy-положение и скорость; прежние controls теряют право записи', async () => {
    const h = harness();
    const before = legacy(h.element, { x: [0, 100] }, options);
    before.seek(250);
    expect(x(h.element)).toBe(25);
    const after = h.runtime.animate(h.element, { x: 200 });
    expect(await before.finished).toBeUndefined();
    expect(x(h.element)).toBe(25);
    expect(surfaceRecord(h.element, 'transform').owner!.readNumber('x')!.velocity).toBeCloseTo(100);
    before.cancel(); before.seek(900);
    expect(x(h.element)).toBe(25);
    after.finish();
    expect(await after.finished).toEqual({ status: 'finished' });
    expect(x(h.element)).toBe(200);
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('legacy принимает root без одновременных писателей и без потери другой декларации', async () => {
    const h = harness();
    const before = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
    const opacity = h.runtime.animate(h.element, { opacity: [0, 1] }, { duration: 1000, ease: 'linear' });
    before.seek(250);
    const after = legacy(h.element, { x: 200 }, options);
    expect(await before.finished).toEqual({ status: 'stopped' });
    after.seek(0);
    expect(x(h.element)).toBe(25);
    before.finish(); before.stop();
    expect(x(h.element)).toBe(25);
    expect(opacity.state).toBe('running');
    after.seek(500);
    expect(x(h.element)).toBe(112.5);
    after.cancel(); opacity.finish();
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('невалидный successor оставляет работающего владельца и его эффект', () => {
    const h = harness(true);
    const before = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
    const owner = surfaceRecord(h.element, 'transform').owner;
    expect(() => legacy(h.element, { x: NaN }, options)).toThrow();
    expect(surfaceRecord(h.element, 'transform').owner).toBe(owner);
    expect(h.effects[0]!.cancelled).toBe(false);
    expect(before.state).toBe('running');
    before.stop();
  });

  it('поздний отказ подготовки не вытесняет legacy-владельца ранней цели', () => {
    const h = harness();
    const before = legacy(h.element, { x: [0, 100] }, options);
    before.seek(250);
    const owner = surfaceRecord(h.element, 'transform').owner;
    const hostile = { style: { getPropertyValue() { throw new Error('read'); }, setProperty() {} } } as unknown as HTMLElement;
    expect(() => h.runtime.animate([h.element, hostile], { x: 200 })).toThrow('read');
    expect(surfaceRecord(h.element, 'transform').owner).toBe(owner);
    before.seek(500);
    expect(x(h.element)).toBe(50);
    before.cancel();
  });

  it('смена владельца сохраняет CSS-значение и его численную производную', async () => {
    const h = harness();
    const before = h.runtime.animate(h.element, { width: ['0px', '100px'] }, { duration: 1000, ease: 'linear' });
    before.seek(250);
    const after = legacy(h.element, { width: '200px' }, { spring: { mass: 1, stiffness: 170, damping: 26 }, requestFrame: frame });
    expect(await before.finished).toEqual({ status: 'stopped' });
    after.seek(0);
    expect(h.element.style.getPropertyValue('width')).toBe('25px');
    const snapshot = surfaceRecord(h.element, 'width').owner!.readCss('width')!;
    expect(snapshot.velocity[0]).toBeCloseTo(100);
    after.cancel();
  });
});
