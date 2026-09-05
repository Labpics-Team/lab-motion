/** Последнее lifecycle-действие аннулирует уже начатое вычисление/запись кадра. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate, type AnimateControls, type AnimatableElement } from '../src/animate/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { frame as defaultFrame } from '../src/frame/index.js';
import {
  fakeEl,
  translateXSeries,
  type FakeElement,
} from './animate-facade-helpers.js';

const LINEAR = (t: number): number => t;

function target(id: string, events: string[]): AnimatableElement {
  return {
    style: {
      getPropertyValue: () => '',
      setProperty: (_name, value) => { events.push(`${id}:${value}`); },
    },
  };
}

function latestX(f: FakeElement): number | undefined {
  return translateXSeries(f.writes).at(-1);
}

function underdampedValue(
  from: number,
  to: number,
  velocity: number,
  tSeconds: number,
): number {
  // m=1, k=170, c=26: alpha=13, damped angular frequency=1 rad/s.
  const displacement = from - to;
  return to + Math.exp(-13 * tSeconds) * (
    displacement * Math.cos(tSeconds) +
    (velocity + 13 * displacement) * Math.sin(tSeconds)
  );
}

beforeEach(() => {
  defaultFrame.cancelAll();
  __resetDetectionCache();
});

afterEach(() => {
  defaultFrame.cancelAll();
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('animate: seek reentry generation', () => {
  it('seek между terminal compute и следующим кадром аннулирует stale convergence', () => {
    const queue: Array<(ts?: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return queue.length;
    });
    const step = (ts: number): void => {
      for (const cb of queue.splice(0)) cb(ts);
    };
    const events: string[] = [];
    let second: AnimateControls | undefined;
    let secondCompletions = 0;
    const first = animate(target('first', events), { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      onComplete() {
        second!.pause();
        second!.seek(200);
      },
    });
    second = animate(target('second', events), { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      onComplete: () => { secondCompletions++; },
    });

    step(0);
    step(1000);
    expect(events.at(-1)).toBe('second:translateX(20px)');

    second.play();
    step(1016); // первый кадр после play имеет нулевую локальную дельту
    expect(events.at(-1)).toBe('second:translateX(20px)');
    expect(secondCompletions).toBe(0);
    step(1032);
    expect(events.at(-1)).toBe('second:translateX(21.6px)');
    expect(secondCompletions).toBe(0);

    first.cancel();
    second.cancel();
  });

  it('live seek между compute/render не допускает stale terminal write в том же кадре', () => {
    const queue: Array<(ts?: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return queue.length;
    });
    const step = (ts: number): void => {
      for (const cb of queue.splice(0)) cb(ts);
    };
    const firstTarget = fakeEl();
    const secondTarget = fakeEl();
    let second: AnimateControls | undefined;
    let secondCompletions = 0;
    const first = animate(firstTarget.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      onComplete: () => second!.seek(0),
    });
    second = animate(secondTarget.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      onComplete: () => { secondCompletions++; },
    });

    step(0);
    step(1000);
    expect(latestX(secondTarget)).toBe(0);
    expect(secondCompletions).toBe(0);
    step(1016);
    expect(latestX(secondTarget)).toBe(0);
    step(1032);
    expect(latestX(secondTarget)).toBeCloseTo(1.6, 12);
    expect(secondCompletions).toBe(0);

    first.cancel();
    second.cancel();
  });

  it.each([
    ['к начальной границе', 200, 0, 0],
    ['назад', 800, 200, 20],
    ['вперёд', 200, 700, 70],
    ['к конечной границе', 200, 1000, 100],
  ])('вложенный seek %s побеждает внешний', (_name, outerMs, nestedMs, expected) => {
    const f = fakeEl();
    let controls: AnimateControls;
    let armed = false;
    controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease(t) {
        if (armed) {
          armed = false;
          controls.seek(nestedMs);
        }
        return t;
      },
      requestFrame: () => 1,
    });
    controls.pause();
    controls.seek(100);

    armed = true;
    expect(() => controls.seek(outerMs)).not.toThrow();
    expect(latestX(f)).toBe(expected);
    controls.cancel();
  });

  it('вложенный aggregate seek аннулирует хвост внешнего fan-out', () => {
    const first = fakeEl();
    const second = fakeEl();
    let controls: AnimateControls;
    let armed = false;
    controls = animate([first.el, second.el], { x: [0, 100] }, {
      duration: 1000,
      ease(t) {
        if (armed) {
          armed = false;
          controls.seek(700);
        }
        return t;
      },
      requestFrame: () => 1,
    });
    controls.pause();
    controls.seek(100);

    armed = true;
    controls.seek(200);
    expect([latestX(first), latestX(second)]).toEqual([70, 70]);
    controls.cancel();
  });

  it('вложенный WAAPI aggregate seek применяет latest время ко всем целям', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const first = fakeEl({}, true);
    const second = fakeEl({}, true);
    const reference = fakeEl({}, true);
    const options = {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      now: () => 0,
      setTimer: () => () => {},
    };
    let controls: AnimateControls;
    controls = animate([first.el, second.el], { x: [0, 100] }, options);
    const expected = animate(reference.el, { x: [0, 100] }, options);
    controls.pause();
    expected.pause();
    expected.seek(200);

    const apply = first.el.style.setProperty.bind(first.el.style);
    let armed = true;
    first.el.style.setProperty = (name, value): void => {
      apply(name, value);
      if (armed) {
        armed = false;
        controls.seek(200);
      }
    };

    controls.seek(100);
    expect([latestX(first), latestX(second)]).toEqual([
      latestX(reference),
      latestX(reference),
    ]);
    controls.cancel();
    expected.cancel();
  });

  it('cancel из ease аннулирует внешний seek без поздней записи', async () => {
    const f = fakeEl();
    let controls: AnimateControls;
    let armed = false;
    controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease(t) {
        if (armed) {
          armed = false;
          controls.cancel();
        }
        return t;
      },
      requestFrame: () => 1,
    });
    controls.pause();
    controls.seek(100);
    const writesBefore = f.writes.length;

    armed = true;
    expect(() => controls.seek(200)).not.toThrow();
    expect(f.writes).toHaveLength(writesBefore);
    expect(latestX(f)).toBe(10);
    await controls.finished;
  });

  it('retarget из ease отбирает lease до продолжения внешнего seek', () => {
    const f = fakeEl();
    let controls: AnimateControls;
    let successor: AnimateControls | undefined;
    let armed = false;
    controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease(t) {
        if (armed) {
          armed = false;
          successor = animate(f.el, { x: 200 }, {
            duration: 1000,
            ease: LINEAR,
            requestFrame: () => 1,
          });
        }
        return t;
      },
      requestFrame: () => 1,
    });
    controls.pause();
    controls.seek(100);
    const writesBefore = f.writes.length;

    armed = true;
    expect(() => controls.seek(200)).not.toThrow();
    expect(f.writes).toHaveLength(writesBefore);
    expect(latestX(f)).toBe(10);

    successor!.pause();
    successor!.seek(500);
    expect(latestX(f)).toBe(105);
    successor!.cancel();
  });

  it('seek из terminal host-write аннулирует stale natural completion', () => {
    const f = fakeEl();
    const queue: Array<(ts?: number) => void> = [];
    let completions = 0;
    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame(cb) {
        queue.push(cb);
        return queue.length;
      },
      onComplete: () => { completions++; },
    });
    controls.pause();
    controls.seek(100);
    const apply = f.el.style.setProperty.bind(f.el.style);
    let armed = true;
    f.el.style.setProperty = (name, value): void => {
      apply(name, value);
      if (armed) {
        armed = false;
        controls.seek(200);
      }
    };

    controls.seek(1000);
    expect(latestX(f)).toBe(20);
    expect(completions).toBe(0);

    controls.play();
    for (const cb of queue.splice(0)) cb(16);
    for (const cb of queue.splice(0)) cb(32);
    expect(latestX(f)).toBeCloseTo(21.6, 12);
    expect(completions).toBe(0);
    controls.cancel();
  });

  it('pause из terminal host-write откладывает completion до play', () => {
    const f = fakeEl();
    const queue: Array<(ts?: number) => void> = [];
    let completions = 0;
    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame(cb) {
        queue.push(cb);
        return queue.length;
      },
      onComplete: () => { completions++; },
    });
    const apply = f.el.style.setProperty.bind(f.el.style);
    let armed = true;
    f.el.style.setProperty = (name, value): void => {
      apply(name, value);
      if (armed) {
        armed = false;
        controls.pause();
      }
    };

    controls.seek(1000);
    expect(latestX(f)).toBe(100);
    expect(completions).toBe(0);

    controls.play();
    for (const cb of queue.splice(0)) cb(16);
    expect(completions).toBe(1);
  });

  it('унаследованная pause не меняет синхронный main terminal-seek контракт', async () => {
    const f = fakeEl();
    let completions = 0;
    const controls = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease: LINEAR,
      requestFrame: () => 1,
      onComplete: () => { completions++; },
    });
    controls.pause();

    controls.seek(1000);
    expect(latestX(f)).toBe(100);
    expect(completions).toBe(1);
    await controls.finished;
  });

  it('унаследованная pause сохраняет WAAPI terminal-pose pending до play', async () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const f = fakeEl({}, true);
    let completions = 0;
    const controls = animate(f.el, { x: [0, 100] }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      now: () => 0,
      setTimer: () => () => {},
      onComplete: () => { completions++; },
    });
    controls.pause();

    controls.seek(100_000);
    let settled = false;
    void controls.finished.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(latestX(f)).toBe(100);
    expect(completions).toBe(0);
    expect(settled).toBe(false);
    controls.cancel();
  });

  it('numeric capture fail-fast сохраняет latest seek и допускает согласованный retry', () => {
    const f = fakeEl();
    let source: AnimateControls;
    let armed = false;
    source = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease(t) {
        if (armed) {
          armed = false;
          source.seek(700);
        }
        return t * t;
      },
      requestFrame: () => 1,
    });
    source.pause();
    source.seek(100);

    armed = true;
    let failure: unknown;
    try {
      animate(f.el, { x: 200 }, {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        requestFrame: () => 1,
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as { code?: unknown } | undefined)?.code).toBe('LM157');
    expect(latestX(f)).toBeCloseTo(49, 12);

    const queue: Array<(ts?: number) => void> = [];
    const successor = animate(f.el, { x: 200 }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame(cb) {
        queue.push(cb);
        return queue.length;
      },
    });
    const step = (ts: number): void => {
      for (const cb of queue.splice(0)) cb(ts);
    };
    step(0);
    step(16);

    // Последний seek задаёт x(0)=49 и v(0)=2·0.7·100=140 px/s.
    expect(latestX(f)).toBeCloseTo(underdampedValue(49, 200, 140, 0.016), 9);
    successor.cancel();
  });

  it('css capture fail-fast сохраняет latest seek и допускает согласованный retry', () => {
    const f = fakeEl();
    let source: AnimateControls;
    let armed = false;
    source = animate(f.el, { width: ['0px', '100px'] }, {
      duration: 1000,
      ease(t) {
        if (armed) {
          armed = false;
          source.seek(700);
        }
        return t * t;
      },
      requestFrame: () => 1,
    });
    source.pause();
    source.seek(100);

    armed = true;
    let failure: unknown;
    try {
      animate(f.el, { width: '200px' }, {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        requestFrame: () => 1,
      });
    } catch (error) {
      failure = error;
    }
    expect((failure as { code?: unknown } | undefined)?.code).toBe('LM157');
    expect(parseFloat(f.writes.filter((write) => write.prop === 'width').at(-1)!.value))
      .toBeCloseTo(49, 12);

    const queue: Array<(ts?: number) => void> = [];
    const successor = animate(f.el, { width: '200px' }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame(cb) {
        queue.push(cb);
        return queue.length;
      },
    });
    const step = (ts: number): void => {
      for (const cb of queue.splice(0)) cb(ts);
    };
    step(0);
    step(16);

    const width = parseFloat(f.writes.filter((write) => write.prop === 'width').at(-1)!.value);
    expect(width).toBeCloseTo(underdampedValue(49, 200, 140, 0.016), 9);
    successor.cancel();
  });

  it('capture fail-fast вместо неограниченного retry изменяющего состояние ease', () => {
    const f = fakeEl();
    let source: AnimateControls;
    let probes = 0;
    source = animate(f.el, { x: [0, 100] }, {
      duration: 1000,
      ease(t) {
        if (Math.abs(t - 0.201) < 1e-12) {
          probes++;
          if (probes > 3) throw new Error('capture retry sentinel');
          source.seek(200);
        }
        return t;
      },
      requestFrame: () => 1,
    });
    source.pause();
    source.seek(200);

    let failure: unknown;
    try {
      animate(f.el, { x: 200 }, {
        spring: { mass: 1, stiffness: 170, damping: 26 },
        requestFrame: () => 1,
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as { code?: unknown } | undefined)?.code).toBe('LM157');
    expect(probes).toBe(1);
    expect(latestX(f)).toBe(20);
    source.cancel();
  });
});
