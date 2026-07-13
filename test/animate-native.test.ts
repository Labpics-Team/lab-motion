/**
 * Контракт узкого `./animate/native`: WAAPI, custom linear() только вне WebKit,
 * независимые нативные CSS-lane и никакого скрытого rAF-пути.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { springTo } from '../src/animate/native/index.js';
import {
  compileRestingSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { __resetSpringExecutionCache } from '../src/compositor/execution.js';
import { MotionParamError } from '../src/errors.js';

interface RecordingElement {
  readonly calls: Array<{
    keyframes: Record<string, string | number>[];
    timing: Record<string, unknown>;
  }>;
  readonly writes: Array<[string, string]>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
  readonly style: { setProperty(name: string, value: string): void };
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): { cancel(): void; finished: Promise<void> };
}

function element(): RecordingElement {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const finished = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const calls: RecordingElement['calls'] = [];
  const writes: Array<[string, string]> = [];
  const cancel = vi.fn(() => reject(new Error('AbortError')));
  return {
    calls,
    writes,
    cancel,
    resolve,
    reject,
    style: { setProperty: (name, value) => writes.push([name, value]) },
    animate(keyframes, timing) {
      calls.push({ keyframes, timing });
      return { cancel, finished };
    },
  };
}

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

describe('animate/native: springTo', () => {
  it('запускает независимые transform и opacity эффекты', async () => {
    const el = element();
    const controls = springTo(el, {
      x: [0, 240],
      y: [10, 20],
      scale: [1, 1.2],
      rotate: [0, 45],
      opacity: [0, 1],
    });

    expect(el.calls).toHaveLength(2);
    expect(el.calls[0]!.keyframes).toEqual([
      {
        transform: 'translateX(0px) translateY(10px) scale(1) rotate(0deg)',
      },
      {
        transform: 'translateX(240px) translateY(20px) scale(1.2) rotate(45deg)',
      },
    ]);
    expect(el.calls[1]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    for (const call of el.calls) {
      expect(call.timing['easing']).toMatch(/^linear\(/);
      expect(call.timing).toMatchObject({
        fill: 'both',
        composite: 'replace',
        iterations: 1,
      });
      expect(call.timing['duration']).toBeGreaterThan(0);
    }

    el.resolve();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('hostile первая цель не меняет WAAPI-план последующей цели', async () => {
    const hostile = {
      style: { setProperty() {} },
      animate(
        keyframes: Record<string, string | number>[],
        timing: Record<string, unknown>,
      ) {
        const attempts = [
          () => { keyframes[0]!['transform'] = 'poison'; },
          () => { keyframes.push({ transform: 'poison' }); },
          () => { timing['duration'] = 0; },
          () => { timing['easing'] = 'poison'; },
        ];
        for (const mutate of attempts) {
          try { mutate(); } catch { /* frozen canonical plan */ }
        }
        return { cancel() {}, finished: Promise.resolve() };
      },
    };
    const clean = element();

    const controls = springTo([hostile, clean], { x: [0, 100] });

    expect(clean.calls[0]!.keyframes).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(100px)' },
    ]);
    expect(clean.calls[0]!.timing).toMatchObject({
      fill: 'both',
      composite: 'replace',
      iterations: 1,
    });
    expect(clean.calls[0]!.timing['duration']).toBeGreaterThan(0);
    expect(clean.calls[0]!.timing['easing']).toMatch(/^linear\(/);
    clean.resolve();
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it.each(['empty', 'reduced'] as const)(
    '%s no-op нельзя отравить для следующего вызова',
    async (kind) => {
      const make = () => kind === 'empty'
        ? springTo([], { x: [0, 100] })
        : springTo(element(), { x: [0, 100] }, { reducedMotion: true });
      const first = make();
      const originalFinished = first.finished;
      const poison = vi.fn();
      const attempts = [
        () => { (first as { cancel(): void }).cancel = poison; },
        () => { (first as { finished: Promise<void> }).finished = Promise.resolve(); },
        () => { (originalFinished as Promise<void> & { poison?: boolean }).poison = true; },
      ];
      for (const mutate of attempts) {
        try { mutate(); } catch { /* immutable shared no-op */ }
      }

      const second = make();
      second.cancel();

      expect(poison).not.toHaveBeenCalled();
      expect(second.finished).toBe(originalFinished);
      expect((second.finished as Promise<void> & { poison?: boolean }).poison).toBeUndefined();
      expect(Object.isFrozen(second)).toBe(true);
      expect(Object.isFrozen(second.finished)).toBe(true);
      await expect(second.finished).resolves.toBeUndefined();
    },
  );

  it('общий no-op cancel нельзя отравить как function-object', () => {
    const first = springTo([], { x: [0, 100] });
    const cancel = first.cancel as (() => void) & { poison?: boolean };
    let leaked = false;
    try {
      try { cancel.poison = true; } catch { /* immutable shared function */ }
      leaked = (springTo([], { x: [0, 100] }).cancel as typeof cancel).poison === true;
    } finally {
      try { delete cancel.poison; } catch { /* frozen function */ }
    }

    expect(leaked).toBe(false);
    expect(Object.isFrozen(cancel)).toBe(true);
  });

  it('в WebKit строит отдельные adaptive keyframes с общим linear timing', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    });
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
    __resetDetectionCache();
    const el = element();

    const controls = springTo(el, { x: [0, 240], opacity: [0, 1] });

    expect(el.calls).toHaveLength(2);
    for (const call of el.calls) {
      expect(call.timing['easing']).toBe('linear');
      expect(call.keyframes.length).toBeGreaterThan(2);
      for (const frame of call.keyframes) expect(frame).toHaveProperty('offset');
    }
    expect(el.calls[0]!.keyframes[0]).toEqual({
      transform: 'translateX(0px)',
      offset: 0,
    });
    expect(el.calls[0]!.keyframes.at(-1)).toEqual({
      transform: 'translateX(240px)',
      offset: 1,
    });
    expect(el.calls[1]!.keyframes[0]).toEqual({ opacity: 0, offset: 0 });
    expect(el.calls[1]!.keyframes.at(-1)).toEqual({ opacity: 1, offset: 1 });
    const samples = compileRestingSpringExecutionArtifactUnchecked(
      { mass: 1, stiffness: 170, damping: 26 },
      DEFAULT_TOLERANCE,
    ).samples;
    for (let i = 0; i < samples.length / 2; i++) {
      for (const call of el.calls) {
        expect(call.keyframes[i]!['offset']).toBe(samples[i * 2]! / 100);
        if (i > 0) {
          expect(Number(call.keyframes[i]!['offset']))
            .toBeGreaterThan(Number(call.keyframes[i - 1]!['offset']));
        }
      }
    }
    controls.cancel();
  });

  it('не отдаёт WebKit nodes в timing и не позволяет polyfill отравить cache', async () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    });
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
    __resetDetectionCache();
    const seenTiming: Record<string, unknown>[] = [];
    const hostile = {
      style: { setProperty: vi.fn() },
      animate(_keyframes: Record<string, string | number>[], timing: Record<string, unknown>) {
        seenTiming.push(timing);
        const nodes = timing['nodes'] as Array<{ progress: number }> | undefined;
        if (nodes) {
          for (let i = 1; i < nodes.length - 1; i++) nodes[i]!.progress = 999;
        }
        return { cancel() {}, finished: Promise.resolve() };
      },
    };

    await springTo(hostile, { x: [0, 240] }).finished;
    const next = element();
    const controls = springTo(next, { x: [0, 240] });

    expect(Object.keys(seenTiming[0]!).sort()).toEqual([
      'composite',
      'duration',
      'easing',
      'fill',
      'iterations',
    ]);
    expect(next.calls[0]!.keyframes.every((frame) =>
      !String(frame['transform']).includes('239760'),
    )).toBe(true);
    controls.cancel();
  });

  it('резолвит selector/list и запускает ровно один прогон на каждую цель', () => {
    const first = element();
    const second = element();
    const doc = {
      querySelectorAll: vi.fn(function (this: unknown) {
        if (this !== doc) throw new TypeError('Illegal invocation');
        return [first, second];
      }),
    };
    vi.stubGlobal('document', doc);

    const selected = springTo('.item', { x: [0, 100] });
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    selected.cancel();

    const listed = springTo([first, second], { opacity: [0, 1] });
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(2);
    listed.cancel();
  });

  it('сохраняет IEEE-754 края без интерполяции', () => {
    const el = element();
    const controls = springTo(el, { opacity: [-0, Number.MIN_VALUE] });
    const frames = el.calls[0]!.keyframes;

    expect(Object.is(frames[0]!['opacity'], -0)).toBe(true);
    expect(Object.is(frames[1]!['opacity'], Number.MIN_VALUE)).toBe(true);
    controls.cancel();
  });

  it('отклоняет неразумный arraylike до чтения элементов', () => {
    let itemReads = 0;
    const hostile = {
      length: 100_001,
      get 0(): RecordingElement {
        itemReads++;
        return element();
      },
    };

    expect(() => springTo(hostile as never, { x: [0, 1] }))
      .toThrow(MotionParamError);
    expect(itemReads).toBe(0);
  });

  it('снимает arraylike length и каждую цель ровно один раз', () => {
    const el = element();
    let lengthReads = 0;
    let itemReads = 0;
    const stateful = {
      get length(): number {
        lengthReads++;
        return lengthReads === 1 ? 1 : 100_001;
      },
      get 0(): RecordingElement {
        itemReads++;
        return el;
      },
    };

    const controls = springTo(stateful, { opacity: [0, 1] });

    expect(lengthReads).toBe(1);
    expect(itemReads).toBe(1);
    expect(el.calls).toHaveLength(1);
    controls.cancel();
  });

  it('отбрасывает неизвестные/неявные/нефинитные props до первого animate', () => {
    const invalid: unknown[] = [
      {},
      { z: [0, 1] },
      { x: 240 },
      { x: [0] },
      { x: [0, 1, 2] },
      { x: Array(2) },
      { x: [0, NaN] },
      { opacity: [0, Infinity] },
    ];
    for (const props of invalid) {
      const el = element();
      expect(() => springTo(el, props as never)).toThrow(MotionParamError);
      expect(el.calls).toHaveLength(0);
    }

    const el = element();
    expect(() =>
      springTo(el, { x: [0, 1] }, {
        spring: { mass: -1, stiffness: 170, damping: 26 },
      }),
    ).toThrow(MotionParamError);
    expect(el.calls).toHaveLength(0);
  });

  it('снимает pair однократно на валидирующей границе', () => {
    let fromReads = 0;
    let toReads = 0;
    const pair = [0, 240];
    Object.defineProperties(pair, {
      0: {
        get: () => fromReads++ === 0 ? 0 : NaN,
      },
      1: {
        get: () => toReads++ === 0 ? 240 : Infinity,
      },
    });
    const el = element();

    const controls = springTo(el, { x: pair as unknown as readonly [number, number] });

    expect(fromReads).toBe(1);
    expect(toReads).toBe(1);
    expect(el.calls[0]!.keyframes).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(240px)' },
    ]);
    controls.cancel();
  });

  it('снимает snapshot spring до host-вызовов и не видит последующую мутацию caller', () => {
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    vi.stubGlobal('matchMedia', function () {
      spring.mass = -1;
      return { matches: false };
    });
    const el = element();

    const controls = springTo(el, { x: [0, 1] }, { spring });

    expect(el.calls).toHaveLength(1);
    expect(el.calls[0]!.timing['duration']).toBeGreaterThan(0);
    controls.cancel();
  });

  it('без WAAPI или CSS linear() падает рано и не включает rAF fallback', () => {
    const noWaapi = {
      style: { setProperty: vi.fn() },
    };
    expect(() => springTo(noWaapi as never, { x: [0, 1] })).toThrow(MotionParamError);

    vi.stubGlobal('CSS', undefined);
    __resetDetectionCache();
    const noCssApi = element();
    expect(() => springTo(noCssApi, { x: [0, 1] })).toThrow(MotionParamError);
    expect(noCssApi.calls).toHaveLength(0);

    vi.stubGlobal('CSS', { supports: vi.fn(() => false) });
    __resetDetectionCache();
    const noLinear = element();
    expect(() => springTo(noLinear, { x: [0, 1] })).toThrow(MotionParamError);
    expect(noLinear.calls).toHaveLength(0);
  });

  it('парсит CSS linear() один раз на неизменный CSS realm', () => {
    const supports = vi.fn(() => true);
    vi.stubGlobal('CSS', { supports });
    const first = springTo(element(), { x: [0, 1] });
    const second = springTo(element(), { opacity: [0, 1] });

    expect(supports).toHaveBeenCalledTimes(1);
    first.cancel();
    second.cancel();
  });

  it('reduced-motion снапает финальный кадр без требования WAAPI/linear()', async () => {
    vi.stubGlobal('CSS', undefined);
    const matchMedia = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return { matches: true };
    });
    vi.stubGlobal('matchMedia', matchMedia);
    const writes: Array<[string, string]> = [];
    const reduced = {
      style: { setProperty: (name: string, value: string) => writes.push([name, value]) },
    };

    const controls = springTo(
      reduced as never,
      { x: [0, 240], opacity: [0, 1] },
    );
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(writes).toEqual([
      ['transform', 'translateX(240px)'],
      ['opacity', '1'],
    ]);
    await expect(controls.finished).resolves.toBeUndefined();
    expect(() => controls.cancel()).not.toThrow();
  });

  it('reduced-motion не пишет enumerable-свойства из Object.prototype', () => {
    Object.defineProperty(Object.prototype, 'pollutedMotionProperty', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 'poison',
    });
    try {
      const reduced = element();
      springTo(reduced, { x: [0, 240] }, { reducedMotion: true });
      expect(reduced.writes).toEqual([['transform', 'translateX(240px)']]);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['pollutedMotionProperty'];
    }
  });

  it('cancel идемпотентен и finished резолвится после native AbortError', async () => {
    const first = element();
    const second = element();
    const controls = springTo([first, second], { x: [0, 100] });

    controls.cancel();
    controls.cancel();
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    await expect(controls.finished).resolves.toBeUndefined();
  });

  it('после естественного finished фиксирует цель и снимает host-effect', async () => {
    const el = element();
    const controls = springTo(el, { x: [0, 1] });

    el.resolve();
    await controls.finished;
    controls.cancel();

    expect(el.cancel).toHaveBeenCalledTimes(1);
  });

  it('освобождает cancel-ссылку даже если host cancel бросает', () => {
    const cancel = vi.fn(() => {
      throw new Error('host cancel failed');
    });
    const hostile = {
      style: { setProperty: vi.fn() },
      animate: vi.fn(() => ({ cancel, finished: Promise.resolve() })),
    };
    const controls = springTo(hostile, { x: [0, 1] });

    expect(() => controls.cancel()).not.toThrow();
    expect(() => controls.cancel()).not.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('снимает cancel-ссылку до реентрантного host-вызова', () => {
    let controls!: ReturnType<typeof springTo>;
    const cancel = vi.fn(() => controls.cancel());
    const hostile = {
      style: { setProperty: vi.fn() },
      animate: vi.fn(() => ({ cancel, finished: Promise.resolve() })),
    };
    controls = springTo(hostile, { opacity: [0, 1] });

    controls.cancel();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('при неполном Animation отменяет уже запущенные цели и падает fail-closed', () => {
    const first = element();
    const broken = {
      style: { setProperty: vi.fn() },
      animate: vi.fn(() => ({ finished: Promise.resolve() })),
    };

    expect(() => springTo([first, broken] as never, { x: [0, 1] }))
      .toThrow(MotionParamError);
    expect(first.cancel).toHaveBeenCalledTimes(1);
  });

  it('отменяет и саму цель, если host-getter finished бросает при setup', () => {
    const first = element();
    const brokenCancel = vi.fn();
    const broken = {
      style: { setProperty: vi.fn() },
      animate: vi.fn(() => ({
        cancel: brokenCancel,
        get finished(): Promise<void> {
          throw new Error('broken finished getter');
        },
      })),
    };

    expect(() => springTo([first, broken] as never, { x: [0, 1] }))
      .toThrow('broken finished getter');
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(brokenCancel).toHaveBeenCalledTimes(1);
  });

  it('читает stateful finished ровно один раз до построения aggregate', async () => {
    let reads = 0;
    const cancel = vi.fn();
    const stateful = {
      style: { setProperty: vi.fn() },
      animate: vi.fn(() => ({
        cancel,
        get finished(): Promise<void> {
          reads++;
          if (reads > 1) throw new Error('finished прочитан повторно');
          return Promise.resolve();
        },
      })),
    };

    const controls = springTo(stateful as never, { opacity: [0, 1] });

    await expect(controls.finished).resolves.toBeUndefined();
    expect(reads).toBe(1);
    controls.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('селектор в SSR падает синхронно, импорт модуля остаётся безопасным', () => {
    vi.stubGlobal('document', undefined);
    expect(() => springTo('.missing', { x: [0, 1] })).toThrow(MotionParamError);
  });
});
