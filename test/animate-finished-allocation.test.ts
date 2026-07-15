/**
 * Один публичный animate-вызов владеет одним завершением независимо от числа
 * внутренних поверхностей. Иначе Promise+executor на каждый Unit превращают
 * start N=1000 в GC-зависимый hot path, хотя наружу виден только один finished.
 * Тест пинит конструкторы Promise самой библиотеки, не host-аллокации WAAPI.
 */

import { describe, expect, it } from 'vitest';
import { animate as animateFull } from '../src/animate/index.js';
import { MotionParamError } from '../src/errors.js';
import { fakeEl } from './animate-facade-helpers.js';

const N = 1_000;

/** Считает только Promise, синхронно созданные внутри проверяемого вызова. */
function countPromises(run: () => void): number {
  const NativePromise = globalThis.Promise;
  let allocations = 0;

  class CountingPromise<T> extends NativePromise<T> {
    constructor(
      executor: (
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason?: unknown) => void,
      ) => void,
    ) {
      allocations++;
      super(executor);
    }
  }

  globalThis.Promise = CountingPromise as PromiseConstructor;
  try {
    run();
  } finally {
    globalThis.Promise = NativePromise;
  }
  return allocations;
}

describe.sequential('animate finished: O(1) library Promise constructors', () => {
  it('full main-path: N=1000 создаёт только aggregate finished', () => {
    const targets = Array.from({ length: N }, () => fakeEl().el);
    const allocations = countPromises(() => {
      const controls = animateFull(targets, { x: 100 }, { duration: 100, requestFrame: () => 1 });
      controls.cancel();
    });
    expect(allocations).toBe(1);
  });

  it('full WAAPI-path: N=1000 создаёт только aggregate finished', () => {
    const targets = Array.from({ length: N }, () => fakeEl({}, true).el);
    const allocations = countPromises(() => {
      const controls = animateFull(
        targets,
        { x: 100 },
        {
          spring: { mass: 1, stiffness: 170, damping: 26 },
          now: () => 0,
          setTimer: () => () => {},
        },
      );
      controls.cancel();
    });
    expect(allocations).toBe(1);
  });

  it('empty/reduced не создают скрытые Promise поверх aggregate', () => {
    const fullReducedTargets = Array.from({ length: N }, () => fakeEl().el);
    expect(
      countPromises(() => {
        void animateFull([], { x: 100 });
      }),
    ).toBe(1);
    expect(
      countPromises(() => {
        void animateFull(fullReducedTargets, { x: 100 }, { matchMedia: () => ({ matches: true }) });
      }),
    ).toBe(1);
  });

  it('plan/read-ошибка бросает целевой MotionParamError до Promise', () => {
    expect(
      countPromises(() => {
        expect(() => animateFull({} as never, { x: 1 })).toThrow(MotionParamError);
      }),
    ).toBe(0);
  });

  it('onComplete-микрозадача сохраняет прежний порядок перед finished', async () => {
    for (const animate of [animateFull] as const) {
      const events: string[] = [];
      const targets = [fakeEl().el, fakeEl().el];
      const controls = animate(targets, { x: 1 }, {
        matchMedia: () => ({ matches: true }),
        onComplete: () => {
          events.push('complete');
          queueMicrotask(() => events.push('complete-microtask'));
        },
      });
      void controls.finished.then(() => events.push('finished'));
      await controls.finished;
      expect(events).toEqual(['complete', 'complete-microtask', 'finished']);
    }
  });

  it('cancel не даёт finished обогнать уже поставленную микрозадачу', async () => {
    for (const animate of [animateFull] as const) {
      const events: string[] = [];
      const controls = animate(fakeEl().el, { x: 1 }, {
        duration: 100,
        requestFrame: () => 1,
      });
      void controls.finished.then(() => events.push('finished'));
      controls.cancel();
      queueMicrotask(() => events.push('after-cancel'));
      await controls.finished;
      expect(events).toEqual(['after-cancel', 'finished']);
    }
  });
});
