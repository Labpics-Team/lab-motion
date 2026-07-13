import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { springTo, type NativeSpringElement } from '../src/animate/native/index.js';
import {
  compileRestingSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import {
  __resetSpringExecutionCache,
  compileRestingSpringRuntimeTimingIntoUnchecked,
} from '../src/compositor/execution.js';

beforeEach(() => {
  __resetDetectionCache();
  __resetSpringExecutionCache();
  vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
  __resetSpringExecutionCache();
});

function deferredElement() {
  const inline = new Map<string, string>();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const finished = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const cancel = vi.fn();
  return {
    inline,
    resolve,
    reject,
    cancel,
    element: {
      style: { setProperty: (name: string, value: string) => inline.set(name, value) },
      animate: () => ({ finished, cancel }),
    },
  };
}

describe('animate/native: независимое владение каналами', () => {
  it('сохраняет Chromium-контракт узкого шва тайминга', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Google Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36',
    });
    __resetDetectionCache();
    const spring = { mass: 2, stiffness: 210, damping: 18 };
    const timing: Record<string, unknown> = { fill: 'both', iterations: 1 };
    const artifact = compileRestingSpringExecutionArtifactTupleUnchecked(
      spring,
      DEFAULT_TOLERANCE,
    );

    const samples = compileRestingSpringRuntimeTimingIntoUnchecked(spring, timing);

    expect(samples).toBeUndefined();
    expect(timing).toEqual({
      fill: 'both',
      iterations: 1,
      easing: artifact[0],
      duration: artifact[2],
    });
  });

  it('сохраняет WebKit samples и обычный linear-тайминг', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    __resetDetectionCache();
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    const timing: Record<string, unknown> = { composite: 'replace' };
    const artifact = compileRestingSpringExecutionArtifactTupleUnchecked(
      spring,
      DEFAULT_TOLERANCE,
    );

    const samples = compileRestingSpringRuntimeTimingIntoUnchecked(spring, timing);

    expect(samples).toBe(artifact[1]);
    expect(timing).toEqual({
      composite: 'replace',
      easing: 'linear',
      duration: artifact[2],
    });
  });

  it('материализует завершённую цель, не ожидая вечный соседний эффект', async () => {
    const completed = deferredElement();
    const pending = deferredElement();
    const controls = springTo(
      [completed.element, pending.element],
      { opacity: [0, 1] },
    );
    let aggregateSettled = false;
    void controls.finished.then(() => { aggregateSettled = true; });

    completed.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(completed.inline.get('opacity')).toBe('1');
    expect(completed.cancel).toHaveBeenCalledTimes(1);
    expect(pending.cancel).not.toHaveBeenCalled();
    expect(aggregateSettled).toBe(false);

    controls.cancel();
  });

  it('завершает вытеснённый control при вечном host finished', async () => {
    const cancel = vi.fn();
    const element = {
      style: { setProperty: vi.fn() },
      animate: () => ({
        cancel,
        finished: new Promise<void>(() => {}),
      }),
    };
    const older = springTo(element, { x: [0, 100] });

    springTo(element, { x: [0, 200] }, { reducedMotion: true });

    const outcome = await Promise.race([
      older.finished.then(() => 'settled'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('settled');
  });

  it('сохраняет newest owner при реентрантной отмене и завершает оба control', async () => {
    const inline = new Map<string, string>();
    const cancels = [vi.fn(), vi.fn()];
    let call = 0;
    let reentered = false;
    const element = {
      style: { setProperty: (name: string, value: string) => inline.set(name, value) },
      animate: () => {
        const index = call++;
        cancels[index]!.mockImplementation(() => {
          if (!reentered) {
            reentered = true;
            springTo(element, { x: [0, 300] }, { reducedMotion: true });
          }
        });
        return {
          cancel: cancels[index],
          finished: new Promise<void>(() => {}),
        };
      },
    };
    const older = springTo(element, { x: [0, 100] });

    const middle = springTo(element, { x: [0, 200] });

    const outcome = await Promise.race([
      Promise.all([older.finished, middle.finished]).then(() => 'settled'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(inline.get('transform')).toBe('translateX(300px)');
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('settled');
  });

  it('откатывает все начатые эффекты при ошибке позднего finished getter', () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const first = {
      style: { setProperty: vi.fn() },
      animate: () => ({ cancel: firstCancel, finished: new Promise<void>(() => {}) }),
    };
    const second = {
      style: { setProperty: vi.fn() },
      animate: () => ({
        cancel: secondCancel,
        get finished(): Promise<void> { throw new Error('finished failed'); },
      }),
    };

    expect(() => springTo([first, second], { x: [0, 100] }))
      .toThrow('finished failed');
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondCancel).toHaveBeenCalledTimes(1);
  });

  it('fail-fast откатывает вечный sibling после host rejection', async () => {
    const pending = deferredElement();
    const failed = deferredElement();
    const controls = springTo([pending.element, failed.element], { opacity: [0, 1] });

    failed.reject(new Error('host failed'));
    await controls.finished;

    expect(pending.cancel).toHaveBeenCalledTimes(1);
    expect(failed.cancel).toHaveBeenCalledTimes(1);
    expect(pending.inline.size).toBe(0);
    expect(failed.inline.size).toBe(0);
  });

  it('читает stateful finished.then ровно один раз и сохраняет pending', async () => {
    let reads = 0;
    const cancel = vi.fn();
    const write = vi.fn();
    const completion = {
      get then() {
        reads++;
        return reads === 1 ? () => {} : undefined;
      },
    };
    const controls = springTo({
      style: { setProperty: write },
      animate: () => ({ cancel, finished: completion }),
    }, { opacity: [0, 1] });
    let settled = false;
    void controls.finished.then(() => { settled = true; });

    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(1);
    expect(settled).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    controls.cancel();
    await controls.finished;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('нормализует receiver и принимает только первый terminal thenable', async () => {
    const cancel = vi.fn();
    const write = vi.fn();
    let receiver: unknown;
    const completion = {
      then(
        this: unknown,
        resolve: () => void,
        reject: (reason?: unknown) => void,
      ) {
        receiver = this;
        resolve();
        reject(new Error('late rejection'));
        resolve();
        throw new Error('late throw');
      },
    };

    await springTo({
      style: { setProperty: write },
      animate: () => ({ cancel, finished: completion }),
    }, { opacity: [0, 1] }).finished;

    expect(receiver).toBe(completion);
    expect(write).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('вызывает захваченный then, не подменённый function.call', async () => {
    const decoy = vi.fn();
    let receiver: unknown;
    let resolveHost!: () => void;
    const then = function (this: unknown, resolve: () => void): void {
      receiver = this;
      resolveHost = resolve;
    };
    Object.defineProperty(then, 'call', { value: decoy });
    const completion = { then };
    const controls = springTo({
      style: { setProperty: vi.fn() },
      animate: () => ({ cancel: vi.fn(), finished: completion }),
    }, { opacity: [0, 1] });

    expect(receiver).toBe(completion);
    expect(decoy).not.toHaveBeenCalled();

    resolveHost();
    await controls.finished;
  });

  it('читает cancel один раз и вызывает его с host-receiver мимо own call', async () => {
    let reads = 0;
    let rawCalls = 0;
    let receiver: unknown;
    const decoy = vi.fn();
    const rawCancel = function (this: unknown): void {
      rawCalls++;
      receiver = this;
    };
    Object.defineProperty(rawCancel, 'call', { value: decoy });
    const animation = {
      finished: new Promise<void>(() => {}),
      get cancel() {
        reads++;
        return reads === 1 ? rawCancel : decoy;
      },
    };
    const controls = springTo({
      style: { setProperty: vi.fn() },
      animate: () => animation,
    }, { opacity: [0, 1] });

    controls.cancel();
    await controls.finished;

    expect(reads).toBe(1);
    expect(rawCalls).toBe(1);
    expect(receiver).toBe(animation);
    expect(decoy).not.toHaveBeenCalled();
  });

  it('синхронный throw thenable откатывает effect через library terminal', async () => {
    const cancel = vi.fn();
    const write = vi.fn();
    const controls = springTo({
      style: { setProperty: write },
      animate: () => ({
        cancel,
        finished: { then: () => { throw new Error('then failed'); } },
      }),
    }, { opacity: [0, 1] });

    await controls.finished;
    controls.cancel();

    expect(write).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('синхронный thenable завершается без global queueMicrotask', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'queueMicrotask');
    const cancel = vi.fn();
    const write = vi.fn();
    let controls: ReturnType<typeof springTo> | undefined;
    try {
      Reflect.deleteProperty(globalThis, 'queueMicrotask');
      controls = springTo({
        style: { setProperty: write },
        animate: () => ({
          cancel,
          finished: { then: (resolve: () => void) => resolve() },
        }),
      }, { opacity: [0, 1] });
      let settled = false;
      void controls.finished.then(() => { settled = true; });

      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'queueMicrotask', descriptor);
      controls?.cancel();
    }
  });

  it('синхронный thenable reentry сохраняет owner нового поколения', async () => {
    const inline = new Map<string, string>();
    const cancel = vi.fn();
    let reentered = false;
    const element = {
      style: { setProperty: (name: string, value: string) => inline.set(name, value) },
      animate: () => ({
        cancel,
        finished: {
          then(resolve: () => void) {
            if (!reentered) {
              reentered = true;
              springTo(element, { opacity: [0, 0.5] }, { reducedMotion: true });
            }
            resolve();
          },
        },
      }),
    };

    await springTo(element, { opacity: [0, 1] }).finished;

    expect(inline.get('opacity')).toBe('0.5');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reduced reentry чинит внешний commit устаревшего значения', () => {
    let inline = '';
    let reentered = false;
    const element = {
      style: {
        setProperty(_name: string, value: string) {
          if (!reentered) {
            reentered = true;
            springTo(element, { x: [0, 200] }, { reducedMotion: true });
          }
          inline = value;
        },
      },
      animate: vi.fn(),
    };

    springTo(element, { x: [0, 100] }, { reducedMotion: true });

    expect(inline).toBe('translateX(200px)');
    expect(element.animate).not.toHaveBeenCalled();
  });

  it('natural finish чинит внешний commit после reduced takeover', async () => {
    let inline = '';
    let reentered = false;
    let resolve!: () => void;
    const cancel = vi.fn();
    const element = {
      style: {
        setProperty(_name: string, value: string) {
          if (!reentered) {
            reentered = true;
            springTo(element, { x: [0, 200] }, { reducedMotion: true });
          }
          inline = value;
        },
      },
      animate: () => ({
        cancel,
        finished: new Promise<void>((done) => { resolve = done; }),
      }),
    };
    const older = springTo(element, { x: [0, 100] });

    resolve();
    await older.finished;

    expect(inline).toBe('translateX(200px)');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('takeover живого owner чинит stale commit его начальным, не финальным кадром', async () => {
    let inline = '';
    let reentered = false;
    let newer!: ReturnType<typeof springTo>;
    const effects: Array<{
      resolve(): void;
      cancel: ReturnType<typeof vi.fn>;
    }> = [];
    const element = {
      style: {
        setProperty(_name: string, value: string) {
          if (!reentered) {
            reentered = true;
            newer = springTo(element, { x: [200, 300] });
          }
          inline = value;
        },
      },
      animate: () => {
        let resolve!: () => void;
        const effect = { resolve: () => resolve(), cancel: vi.fn() };
        effects.push(effect);
        return {
          cancel: effect.cancel,
          finished: new Promise<void>((done) => { resolve = done; }),
        };
      },
    };
    const older = springTo(element, { x: [0, 100] });

    effects[0]!.resolve();
    await older.finished;
    let newerSettled = false;
    void newer.finished.then(() => { newerSettled = true; });
    await Promise.resolve();

    expect(inline).toBe('translateX(200px)');
    expect(newerSettled).toBe(false);
    expect(effects[1]!.cancel).not.toHaveBeenCalled();

    newer.cancel();
  });

  it('reentrant cancel чинит поздний commit начальным кадром', async () => {
    let inline = '';
    let reentered = false;
    let resolve!: () => void;
    let controls!: ReturnType<typeof springTo>;
    const cancel = vi.fn();
    const element = {
      style: {
        setProperty(_name: string, value: string) {
          if (!reentered) {
            reentered = true;
            controls.cancel();
          }
          inline = value;
        },
      },
      animate: () => ({
        cancel,
        finished: new Promise<void>((done) => { resolve = done; }),
      }),
    };
    controls = springTo(element, { x: [0, 100] });

    resolve();
    await controls.finished;

    expect(inline).toBe('translateX(0px)');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('repair отклоняет вторую смену owner и после неё канал восстановим', () => {
    let inline = '';
    let inside = false;
    let transitions = 0;
    let writes = 0;
    const element = {
      style: {
        setProperty(_name: string, value: string) {
          writes++;
          if (!inside && transitions < 5) {
            inside = true;
            transitions++;
            try {
              springTo(
                element,
                { opacity: [0, transitions / 10] },
                { reducedMotion: true },
              );
            } finally {
              inside = false;
            }
          }
          inline = value;
        },
      },
      animate: vi.fn(),
    };

    let failure: unknown;
    try {
      springTo(element, { opacity: [0, 1] }, { reducedMotion: true });
    } catch (error) {
      failure = error;
    }

    expect((failure as { code?: unknown } | undefined)?.code).toBe('LM157');
    expect(transitions).toBe(2);
    expect(writes).toBe(3);

    transitions = 5;
    springTo(element, { opacity: [0, 0.75] }, { reducedMotion: true });
    expect(inline).toBe('0.75');
  });

  it('не возвращает ложный успех на границе 100000 reentrant-owner', () => {
    const hostileTransitions = 100_000;
    let inside = false;
    let transitions = 0;
    const element = {
      style: {
        setProperty(_name: string, value: string) {
          if (!inside && transitions < hostileTransitions) {
            inside = true;
            transitions++;
            try {
              springTo(
                element,
                { opacity: [0, transitions / hostileTransitions] },
                { reducedMotion: true },
              );
            } finally {
              inside = false;
            }
          }
          void value;
        },
      },
      animate: vi.fn(),
    };

    let failure: unknown;
    try {
      springTo(element, { opacity: [0, 1] }, { reducedMotion: true });
    } catch (error) {
      failure = error;
    }

    // Repair-запись с новой сменой owner — уже не сходящаяся
    // host-транзакция: она обязана падать раньше числового cap.
    expect((failure as { code?: unknown } | undefined)?.code).toBe('LM157');
    expect(transitions).toBeLessThan(hostileTransitions);
  });

  it('отклоняет цикл repair A→B→A до седьмой host-записи', () => {
    let writes = 0;
    const writesByElement = new Map<string, number>();
    let elementA!: NativeSpringElement;
    let elementB!: NativeSpringElement;
    const createElement = (name: string): NativeSpringElement => ({
      style: {
        setProperty() {
          writes++;
          writesByElement.set(name, (writesByElement.get(name) ?? 0) + 1);
          const self = name === 'A' ? elementA : elementB;
          if (writes % 3 === 1) {
            springTo(self, { opacity: [0, 0.5] }, { reducedMotion: true });
          } else if (writes % 3 === 0) {
            springTo(
              name === 'A' ? elementB : elementA,
              { opacity: [0, 0.5] },
              { reducedMotion: true },
            );
          }
        },
      },
    });
    elementA = createElement('A');
    elementB = createElement('B');

    let failure: unknown;
    try {
      springTo(elementA, { opacity: [0, 1] }, { reducedMotion: true });
    } catch (error) {
      failure = error;
    }

    // Точная граница доказывает проверку всей цепочки, а не поздний
    // stack overflow, замаскированный под LM157.
    expect((failure as { code?: unknown } | undefined)?.code).toBe('LM157');
    expect(writes).toBe(6);
    expect(Object.fromEntries(writesByElement)).toEqual({ A: 3, B: 3 });
  });

  it('цепочка repair не блокирует другой канал того же element', () => {
    const inline = new Map<string, string>();
    let writes = 0;
    const element: NativeSpringElement = {
      style: {
        setProperty(name: string, value: string) {
          writes++;
          if (writes === 1) {
            springTo(element, { opacity: [0, 0.5] }, { reducedMotion: true });
          } else if (writes === 3) {
            springTo(element, { x: [0, 20] }, { reducedMotion: true });
          }
          inline.set(name, value);
        },
      },
    };

    expect(() => {
      springTo(element, { opacity: [0, 1] }, { reducedMotion: true });
    }).not.toThrow();
    expect(writes).toBe(4);
    expect(inline.get('opacity')).toBe('0.5');
    expect(inline.get('transform')).toBe('translateX(20px)');
  });

  it('natural terminal отклоняет non-quiescent repair и оставляет канал восстановимым', async () => {
    const inline = new Map<string, string>();
    let inside = false;
    let transitions = 0;
    const effects: Array<{
      resolve(): void;
      cancel: ReturnType<typeof vi.fn>;
    }> = [];
    const element = {
      style: {
        setProperty(name: string, value: string) {
          if (!inside && transitions < 2) {
            inside = true;
            transitions++;
            try {
              springTo(
                element,
                name === 'transform'
                  ? { x: [0, transitions * 25] }
                  : { opacity: [0, transitions / 4] },
                { reducedMotion: true },
              );
            } finally {
              inside = false;
            }
          }
          inline.set(name, value);
        },
      },
      animate: () => {
        let resolve!: () => void;
        const effect = { resolve: () => resolve(), cancel: vi.fn() };
        effects.push(effect);
        return {
          cancel: effect.cancel,
          finished: new Promise<void>((done) => { resolve = done; }),
        };
      },
    };
    const controls = springTo(element, { x: [0, 100], opacity: [0, 1] });

    effects[0]!.resolve();

    await expect(controls.finished).rejects.toMatchObject({ code: 'LM157' });
    expect(transitions).toBe(2);
    expect(effects).toHaveLength(2);
    expect(effects[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(effects[1]!.cancel).toHaveBeenCalledTimes(1);

    springTo(element, { x: [0, 75], opacity: [0, 0.75] }, { reducedMotion: true });
    expect(inline.get('transform')).toBe('translateX(75px)');
    expect(inline.get('opacity')).toBe('0.75');
  });
});
