import { afterEach, describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import {
  makeClock,
  makeWorld,
  parseTranslateScale,
  pickCreateDomProjection,
  type FakeElement,
} from './projection-helpers.js';

const createDomProjection = pickCreateDomProjection(projection as unknown as Record<string, unknown>);
const savedScrollX = Object.getOwnPropertyDescriptor(globalThis, 'scrollX');
const savedScrollY = Object.getOwnPropertyDescriptor(globalThis, 'scrollY');

function restoreGlobal(name: 'scrollX' | 'scrollY', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}

afterEach(() => {
  restoreGlobal('scrollX', savedScrollX);
  restoreGlobal('scrollY', savedScrollY);
});

describe('R11 safe DOM state ownership', () => {
  it('retains the default hostile-global scroll sanitizer', () => {
    Object.defineProperty(globalThis, 'scrollX', { configurable: true, value: Infinity });
    Object.defineProperty(globalThis, 'scrollY', { configurable: true, value: 'hostile' });

    const world = makeWorld();
    const clock = makeClock();
    const E = world.el('E', { x: 0, y: 0, width: 100, height: 100 });
    const dom = createDomProjection({ requestFrame: clock.requestFrame });
    dom.capture([E]);
    E.rect = { x: 20, y: 0, width: 100, height: 100 };
    expect(() => dom.play()).not.toThrow();

    const write = world
      .writes(E)
      .find((op) => op.kind === 'set' && op.prop === 'transform' && op.value?.includes('translate('));
    expect(write).toBeDefined();
    const transform = parseTranslateScale(write!.value!);
    expect(transform?.tx).toBeCloseTo(-20, 9);
    expect(transform?.ty).toBeCloseTo(0, 9);
  });

  it('turns a throwing global scroll getter into the zero-scroll fallback', () => {
    Object.defineProperty(globalThis, 'scrollX', {
      configurable: true,
      get(): number {
        throw new Error('hostile scroll getter');
      },
    });
    Object.defineProperty(globalThis, 'scrollY', { configurable: true, value: 77 });

    const world = makeWorld();
    const clock = makeClock();
    const E = world.el('E', { x: 5, y: 7, width: 10, height: 10 });
    const dom = createDomProjection({ requestFrame: clock.requestFrame });
    expect(() => dom.capture([E])).not.toThrow();
    expect(() => dom.play()).not.toThrow();
  });

  it('does not retain an ancestor that disappears during the play measurement batch', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', { x: 0, y: 0, width: 100, height: 100 });
    const C = world.el('C', { x: 10, y: 10, width: 20, height: 20 }, { parent: P });
    const dom = createDomProjection({
      requestFrame: clock.requestFrame,
      getScroll: () => world.getScroll(),
      getComputedStyle: (el: unknown) => world.getComputedStyle(el),
    });

    dom.capture([P, C]);
    (P as FakeElement & { getBoundingClientRect(): never }).getBoundingClientRect = () => {
      throw new Error('removed between capture and play');
    };
    C.rect = { x: 35, y: 10, width: 20, height: 20 };

    expect(() => dom.play()).not.toThrow();
    expect(world.writes(P).some((op) => op.value?.includes('translate('))).toBe(false);
    expect(world.writes(C).some((op) => op.value?.includes('translate('))).toBe(true);
  });
});
