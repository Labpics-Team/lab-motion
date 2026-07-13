/** Транзакционность смены владельца и освобождение WAAPI fill-effect. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { MotionParamError } from '../src/errors.js';
import { settleTimeUpperBound } from '../src/spring.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

beforeEach(() => {
  __resetDetectionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

function element() {
  const inline = new Map<string, string>();
  const writes: string[] = [];
  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  let reads = 0;
  const el = {
    style: {
      getPropertyValue: (name: string) => inline.get(name) ?? '',
      setProperty(name: string, value: string) {
        writes.push(`${name}:${value}`);
        inline.set(name, value);
      },
    },
    animate: vi.fn(() => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return {
        cancel,
        get currentTime() {
          reads++;
          return 100;
        },
      };
    }),
  };
  return { el, writes, cancels, reads: () => reads };
}

function firstTargetCrossingMs(spring = SPRING): number {
  const samples = compileSpringExecutionArtifactUnchecked(
    spring,
    0,
    DEFAULT_TOLERANCE,
  ).samples;
  const durationMs = settleTimeUpperBound(spring, 0) * 1000;
  for (let i = 0; i + 3 < samples.length; i += 2) {
    const p0 = samples[i + 1]!;
    const p1 = samples[i + 3]!;
    if (p0 < 1 && p1 >= 1) {
      const q = (1 - p0) / (p1 - p0);
      return (samples[i]! + q * (samples[i + 2]! - samples[i]!)) / 100 * durationMs;
    }
  }
  throw new Error('target crossing отсутствует');
}

describe('animate: атомарный lifecycle', () => {
  it('first-owner WAAPI host reentry ловит LM157 до nested construction', () => {
    const f = element();
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    let calls = 0;
    let code: string | undefined;
    f.el.animate.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        try {
          animate(f.el, { x: 999 }, { spring: SPRING, setTimer: () => () => {} });
        } catch (error) {
          code = (error as MotionParamError).code;
        }
      }
      const cancel = vi.fn();
      cancels.push(cancel);
      return { currentTime: 0, cancel };
    });

    const controls = animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: () => () => {},
    });

    expect(code).toBe('LM157');
    expect(calls).toBe(1);
    controls.cancel();
    expect(cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('first-owner WAAPI uncaught host reentry откатывает outer', () => {
    const f = element();
    let reentered = false;
    f.el.animate.mockImplementation(() => {
      if (!reentered) {
        reentered = true;
        animate(f.el, { x: 999 }, { spring: SPRING, setTimer: () => () => {} });
      }
      return { currentTime: 0, cancel: vi.fn() };
    });

    let error: unknown;
    try {
      animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    } catch (cause) {
      error = cause;
    }

    expect((error as MotionParamError).code).toBe('LM157');
    expect(f.el.animate).toHaveBeenCalledTimes(1);
  });

  it('first-owner Main scheduler reentry ловит LM157 до nested subscription', () => {
    const f = element();
    delete (f.el as { animate?: unknown }).animate;
    let calls = 0;
    let code: string | undefined;
    const requestFrame = (): number => {
      calls++;
      if (calls === 1) {
        try {
          animate(f.el, { x: 999 }, { spring: SPRING, requestFrame });
        } catch (error) {
          code = (error as MotionParamError).code;
        }
      }
      return 1;
    };

    const controls = animate(f.el, { x: 100 }, { spring: SPRING, requestFrame });

    expect(code).toBe('LM157');
    expect(calls).toBe(1);
    controls.cancel();
  });

  it('first-owner Main uncaught scheduler reentry откатывает outer', () => {
    const f = element();
    delete (f.el as { animate?: unknown }).animate;
    let reentered = false;
    const requestFrame = (): number => {
      if (!reentered) {
        reentered = true;
        animate(f.el, { x: 999 }, { spring: SPRING, requestFrame });
      }
      return 1;
    };

    let error: unknown;
    try {
      animate(f.el, { x: 100 }, { spring: SPRING, requestFrame });
    } catch (cause) {
      error = cause;
    }

    expect((error as MotionParamError).code).toBe('LM157');
  });

  it('first-owner reduced style reentry ловит LM157, outer target побеждает', () => {
    const f = element();
    let code: string | undefined;
    let nested = false;
    f.el.style.setProperty = (_name, value) => {
      f.writes.push(`transform:${value}`);
      if (nested) return;
      nested = true;
      try {
        animate(f.el, { x: 999 }, { spring: SPRING, setTimer: () => () => {} });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
    };

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(code).toBe('LM157');
    expect(f.el.animate).not.toHaveBeenCalled();
    expect(f.writes.at(-1)).toBe('transform:translateX(300px)');
  });

  it('снимает один WAAPI currentTime на весь transform-вектор с residual', () => {
    const f = element();
    animate(f.el, { x: 100, y: 200, rotate: 30 }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });

    animate(f.el, { x: 300, y: 600 }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });

    expect(f.reads()).toBe(1);
  });

  it('host-ошибка successor оставляет старый owner/effect живым', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    f.el.animate.mockImplementationOnce(() => {
      throw new Error('constructor failed');
    });

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).toThrow('constructor failed');
    expect(f.cancels[0]).not.toHaveBeenCalled();

    animate(f.el, { x: 300 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('бросающий timer successor откатывает только новый effect', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => { throw new Error('timer failed'); },
    })).toThrow('timer failed');

    expect(f.cancels[0]).not.toHaveBeenCalled();
    expect(f.cancels[1]).toHaveBeenCalledTimes(1);
  });

  it('бросающий main scheduler не снимает старый compositor-owner', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    delete (f.el as { animate?: unknown }).animate;

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      requestFrame: () => { throw new Error('scheduler failed'); },
    })).toThrow('scheduler failed');
    expect(f.cancels[0]).not.toHaveBeenCalled();
  });

  it('saved main frame не пишет старый owner во время successor construction', () => {
    const f = element();
    delete (f.el as { animate?: unknown }).animate;
    let frame!: (ts?: number) => void;
    animate(f.el, { x: 100 }, {
      spring: SPRING,
      requestFrame: (callback) => {
        frame = callback;
        return 1;
      },
    });
    f.el.animate = vi.fn(() => {
      frame(16);
      return { currentTime: 0, cancel: vi.fn() };
    });
    const writesBefore = f.writes.length;

    const controls = animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => () => {},
    });

    expect(f.writes).toHaveLength(writesBefore);
    controls.cancel();
  });

  it('hostile style при supersede сохраняет старый effect и откатывает новый', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    const original = f.el.style.setProperty;
    f.el.style.setProperty = () => { throw new Error('style failed'); };

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).toThrow('style failed');
    expect(f.cancels[0]).not.toHaveBeenCalled();
    expect(f.cancels[1]).toHaveBeenCalledTimes(1);

    f.el.style.setProperty = original;
    animate(f.el, { x: 300 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('WAAPI → delayed main фиксирует снимок до cancel без base-flash', () => {
    const f = element();
    const events: string[] = [];
    f.el.style.setProperty = (name, value) => {
      events.push(`write:${name}:${value}`);
    };
    f.el.animate.mockImplementationOnce(() => ({
      currentTime: 100,
      cancel: () => events.push('cancel'),
    }));
    animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });

    delete (f.el as { animate?: unknown }).animate;
    animate(f.el, { x: 200 }, {
      spring: SPRING,
      delay: 500,
      requestFrame: () => 1,
    });

    expect(events[0]).toMatch(/^write:transform:translateX\(/);
    expect(events[1]).toBe('cancel');
  });

  it('reduced replacement проходит через WAAPI-wrapper после handoff в live', () => {
    const f = element();
    const underdamped = { mass: 1, stiffness: 170, damping: 10 };
    const first = animate(f.el, { x: [0, 100] }, {
      spring: underdamped,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame: () => 1,
    });
    first.seek(firstTargetCrossingMs(underdamped));

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(f.writes.at(-1)).toBe('transform:translateX(300px)');
  });

  it('supersede чистит timer до host cancel и не блокируется его ошибкой', () => {
    const f = element();
    const events: string[] = [];
    f.el.animate.mockImplementationOnce(() => ({
      currentTime: 100,
      cancel: () => {
        events.push('cancel');
        throw new Error('cancel failed');
      },
    }));
    animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: () => () => { events.push('timer'); },
    });

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).not.toThrow();
    expect(events).toEqual(['timer', 'cancel']);
  });

  it('reentrant timer-cancel не превращает supersede в natural completion', () => {
    const f = element();
    const complete = vi.fn();
    let timerCallback!: () => void;
    animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: (callback) => {
        timerCallback = callback;
        return () => timerCallback();
      },
      onComplete: complete,
    });

    animate(f.el, { x: 200 }, { spring: SPRING, setTimer: () => () => {} });

    expect(complete).not.toHaveBeenCalled();
  });

  it('reentrant timer-cancel не переписывает reduced replacement', () => {
    const f = element();
    const complete = vi.fn();
    let timerCallback!: () => void;
    animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: (callback) => {
        timerCallback = callback;
        return () => timerCallback();
      },
      onComplete: complete,
    });

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(f.writes.at(-1)).toBe('transform:translateX(300px)');
    expect(complete).not.toHaveBeenCalled();
  });

  it('timer, fired внутри failed successor, завершается после release owner', async () => {
    const f = element();
    const complete = vi.fn();
    let timerCallback!: () => void;
    const first = animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: (callback) => {
        timerCallback = callback;
        return () => {};
      },
      onComplete: complete,
    });
    let completedInside = -1;
    f.el.animate.mockImplementationOnce(() => {
      timerCallback();
      completedInside = complete.mock.calls.length;
      throw new Error('successor failed');
    });

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).toThrow('successor failed');
    await first.finished;

    expect(completedInside).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(f.writes.at(-1)).toBe('transform:translateX(100px)');
  });

  it('ошибка onComplete при release не скрывает исходный сбой successor', async () => {
    const f = element();
    let timerCallback!: () => void;
    const first = animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: (callback) => {
        timerCallback = callback;
        return () => {};
      },
      onComplete: () => { throw new Error('complete failed'); },
    });
    f.el.animate.mockImplementationOnce(() => {
      timerCallback();
      throw new Error('successor failed');
    });

    expect(() => animate(f.el, { x: 200 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).toThrow('successor failed');
    await expect(first.finished).resolves.toBeUndefined();
    expect(f.writes.at(-1)).toBe('transform:translateX(100px)');
  });

  it('natural finish пишет target и снимает effect до onComplete/finished', async () => {
    const f = element();
    const events: string[] = [];
    let finish!: () => void;
    f.el.style.setProperty = (name, value) => events.push(`write:${name}:${value}`);
    f.el.animate.mockImplementationOnce(() => ({
      currentTime: 0,
      cancel: () => events.push('cancel'),
    }));
    const controls = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      setTimer: (callback) => {
        finish = callback;
        return () => {};
      },
      onComplete: () => events.push('complete'),
    });
    void controls.finished.then(() => events.push('finished'));

    finish();
    expect(events).toEqual([
      'write:transform:translateX(100px)',
      'cancel',
      'complete',
    ]);
    await controls.finished;
    await Promise.resolve();
    expect(events.at(-1)).toBe('finished');
  });

  it('reentrant cancel из host cancel не подавляет natural completion', async () => {
    const f = element();
    const complete = vi.fn();
    let finish!: () => void;
    let controls!: ReturnType<typeof animate>;
    f.el.animate.mockImplementationOnce(() => ({
      currentTime: 0,
      cancel: () => controls.cancel(),
    }));
    controls = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      setTimer: (callback) => {
        finish = callback;
        return () => {};
      },
      onComplete: complete,
    });

    finish();
    await controls.finished;

    expect(f.writes.at(-1)).toBe('transform:translateX(100px)');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('reentrant style controls.cancel не разрушает pause-транзакцию', () => {
    const f = element();
    let controls!: ReturnType<typeof animate>;
    controls = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });
    let reentered = false;
    f.el.style.setProperty = () => {
      if (!reentered) {
        reentered = true;
        controls.cancel();
      }
    };

    controls.pause();
    controls.play();

    expect(f.el.animate).toHaveBeenCalledTimes(2);
    controls.cancel();
  });

  it('reentrant style controls.cancel не разрушает paused seek', () => {
    const f = element();
    const controls = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });
    controls.pause();
    let reentered = false;
    f.el.style.setProperty = () => {
      if (!reentered) {
        reentered = true;
        controls.cancel();
      }
    };

    controls.seek(100);
    controls.play();

    expect(f.el.animate).toHaveBeenCalledTimes(2);
    controls.cancel();
  });

  it('reentrant style controls.cancel не терминализирует WAAPI→live handoff', async () => {
    const f = element();
    const underdamped = { mass: 1, stiffness: 170, damping: 10 };
    let controls!: ReturnType<typeof animate>;
    controls = animate(f.el, { x: [0, 100] }, {
      spring: underdamped,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame: () => 1,
    });
    let settled = false;
    void controls.finished.then(() => { settled = true; });
    let reentered = false;
    f.el.style.setProperty = () => {
      if (!reentered) {
        reentered = true;
        controls.cancel();
      }
    };

    controls.seek(firstTargetCrossingMs(underdamped));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    controls.cancel();
  });

  it('reentrant animate→controls.cancel при play не оставляет новый effect вне controls', () => {
    const f = element();
    const controls = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });
    controls.pause();
    const replayCancel = vi.fn();
    f.el.animate.mockImplementationOnce(() => {
      controls.cancel();
      return { currentTime: 0, cancel: replayCancel };
    });

    controls.play();
    controls.cancel();

    expect(replayCancel).toHaveBeenCalledTimes(1);
  });

  it('reentrant animate→controls.cancel при active seek не теряет новый effect', () => {
    const f = element();
    const controls = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
    });
    const replayCancel = vi.fn();
    f.el.animate.mockImplementationOnce(() => {
      controls.cancel();
      return { currentTime: 0, cancel: replayCancel };
    });

    controls.seek(100);
    controls.cancel();

    expect(replayCancel).toHaveBeenCalledTimes(1);
  });

  it('reentrant cancel не переписывает reduced target после replacement', () => {
    const f = element();
    let first!: ReturnType<typeof animate>;
    f.el.animate.mockImplementationOnce(() => ({
      currentTime: 100,
      cancel: () => first.cancel(),
    }));
    first = animate(f.el, { x: [0, 100] }, {
      spring: SPRING,
      setTimer: () => () => {},
    });

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(f.writes.at(-1)).toBe('transform:translateX(300px)');
  });

  it('natural hostile style оставляет visual effect, но не логического owner', async () => {
    const f = element();
    let finish!: () => void;
    f.el.style.setProperty = () => { throw new Error('style failed'); };
    const controls = animate(f.el, { x: 100 }, {
      spring: SPRING,
      setTimer: (callback) => {
        finish = callback;
        return () => {};
      },
    });

    expect(() => finish()).not.toThrow();
    await expect(controls.finished).resolves.toBeUndefined();
    expect(f.cancels[0]).not.toHaveBeenCalled();

    f.el.style.setProperty = () => {};
    animate(f.el, { x: 200 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).not.toHaveBeenCalled();
  });

  it('reduced replacement остаётся последней записью после cleanup старого owner', () => {
    const f = element();
    const events: string[] = [];
    f.el.style.setProperty = (_name, value) => events.push(value);
    f.el.animate.mockImplementationOnce(() => ({
      currentTime: 100,
      cancel: () => events.push('cancel'),
    }));
    animate(f.el, { x: [0, 100] }, { spring: SPRING, setTimer: () => () => {} });

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(events.at(-2)).toBe('translateX(300px)');
    expect(events.at(-1)).toBe('cancel');
  });

  it('ошибка reduced replacement не снимает старый owner после успешного hold', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    let writes = 0;
    f.el.style.setProperty = () => {
      if (++writes === 2) throw new Error('snap failed');
    };

    expect(() => animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    })).toThrow('snap failed');
    expect(f.cancels[0]).not.toHaveBeenCalled();

    f.el.style.setProperty = () => {};
    animate(f.el, { x: 400 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('дубликат цели коммитится в исходном порядке и оставляет последний owner', () => {
    const f = element();
    animate([f.el, f.el], { x: 100 }, {
      spring: SPRING,
      setTimer: () => () => {},
    });

    expect(f.el.animate).toHaveBeenCalledTimes(2);
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
    expect(f.cancels[1]).not.toHaveBeenCalled();
  });

  it('ошибка конструктора второго дубликата сохраняет owner первого', () => {
    const f = element();
    f.el.animate.mockImplementationOnce(() => {
      const cancel = vi.fn();
      f.cancels.push(cancel);
      return { currentTime: 100, cancel };
    });
    f.el.animate.mockImplementationOnce(() => {
      throw new Error('second duplicate failed');
    });

    expect(() => animate([f.el, f.el], { x: 100 }, {
      spring: SPRING,
      setTimer: () => () => {},
    })).toThrow('second duplicate failed');
    expect(f.cancels[0]).not.toHaveBeenCalled();

    animate(f.el, { x: 200 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('sync timer дубликата не пишет target до публикации последнего owner', async () => {
    const events: string[] = [];
    let effect = 0;
    const el = {
      style: {
        getPropertyValue: () => '',
        setProperty: (_name: string, value: string) => { events.push(`write:${value}`); },
      },
      animate: vi.fn(() => {
        const id = ++effect;
        events.push(`animate:${id}`);
        return {
          currentTime: 0,
          cancel: () => { events.push(`cancel:${id}`); },
        };
      }),
    };

    const controls = animate([el, el], { x: [0, 100] }, {
      spring: SPRING,
      setTimer(callback) {
        callback();
        return () => {};
      },
    });

    const secondEffect = events.indexOf('animate:2');
    const firstTarget = events.indexOf('write:translateX(100px)');
    expect(secondEffect).toBeGreaterThanOrEqual(0);
    expect(firstTarget).toBeGreaterThan(secondEffect);
    await controls.finished;
  });

  it('nested animate из style без catch fail-closed откатывает outer successor', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    let nested = false;
    f.el.style.setProperty = () => {
      if (nested) return;
      nested = true;
      animate(f.el, { x: 999 }, { spring: SPRING, setTimer: () => () => {} });
    };

    let error: unknown;
    try {
      animate(f.el, { x: 200 }, { spring: SPRING, setTimer: () => () => {} });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM157');
    expect(f.el.animate).toHaveBeenCalledTimes(2);
    expect(f.cancels[0]).not.toHaveBeenCalled();
    expect(f.cancels[1]).toHaveBeenCalledTimes(1);

    f.el.style.setProperty = () => {};
    animate(f.el, { x: 300 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('пойманный LM157 позволяет outer reduced завершиться без nested effect', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    let code: string | undefined;
    let nested = false;
    f.el.style.setProperty = (_name, value) => {
      f.writes.push(`transform:${value}`);
      if (nested) return;
      nested = true;
      try {
        animate(f.el, { x: 999 }, { spring: SPRING, setTimer: () => () => {} });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
    };

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(code).toBe('LM157');
    expect(f.el.animate).toHaveBeenCalledTimes(1);
    expect(f.writes.at(-1)).toBe('transform:translateX(300px)');
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });

  it('MainUnit использует тот же LM157 transition guard', () => {
    const f = element();
    delete (f.el as { animate?: unknown }).animate;
    animate(f.el, { x: 100 }, {
      spring: SPRING,
      requestFrame: () => 1,
    });
    let code: string | undefined;
    let nested = false;
    f.el.style.setProperty = (_name, value) => {
      f.writes.push(`transform:${value}`);
      if (nested) return;
      nested = true;
      try {
        animate(f.el, { x: 999 }, {
          spring: SPRING,
          requestFrame: () => 1,
        });
      } catch (error) {
        code = (error as MotionParamError).code;
      }
    };

    animate(f.el, { x: 300 }, {
      spring: SPRING,
      matchMedia: () => ({ matches: true }),
    });

    expect(code).toBe('LM157');
    expect(f.writes.at(-1)).toBe('transform:translateX(300px)');
  });

  it('hostile successor animate не рекурсирует до owner preflight', () => {
    const f = element();
    animate(f.el, { x: 100 }, { spring: SPRING, setTimer: () => () => {} });
    f.el.animate.mockImplementationOnce(() => {
      animate(f.el, { x: 999 }, { spring: SPRING, setTimer: () => () => {} });
      return { currentTime: 0, cancel: vi.fn() };
    });

    let error: unknown;
    try {
      animate(f.el, { x: 200 }, { spring: SPRING, setTimer: () => () => {} });
    } catch (cause) {
      error = cause;
    }
    expect((error as MotionParamError).code).toBe('LM157');
    expect(f.el.animate).toHaveBeenCalledTimes(2);
    expect(f.cancels[0]).not.toHaveBeenCalled();

    animate(f.el, { x: 300 }, { spring: SPRING, setTimer: () => () => {} });
    expect(f.cancels[0]).toHaveBeenCalledTimes(1);
  });
});
