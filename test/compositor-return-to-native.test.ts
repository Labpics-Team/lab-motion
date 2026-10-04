import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositorSpring } from '../src/compositor/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { MotionParamError } from '../src/errors.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function scene(extra: Record<string, unknown> = {}) {
  const queue: Array<(time?: number) => void> = [];
  const effects: Array<{ currentTime: number | null; cancelled: boolean }> = [];
  const calls: Array<{ frames: Record<string, string | number>[]; timing: Record<string, unknown> }> = [];
  const seen: Array<string | number> = [];
  let time = 0;
  let requests = 0;
  const controller = new CompositorSpring({
    spring: SPRING, property: 'opacity', from: 0, to: 100,
    target: { animate(frames, timing) {
      calls.push({ frames: frames as Record<string, string | number>[], timing: timing as Record<string, unknown> });
      const effect = { currentTime: null as number | null, cancelled: false, cancel() { this.cancelled = true; } };
      effects.push(effect);
      return effect;
    } },
    now: () => time,
    requestFrame(callback) { requests++; queue.push(callback); return requests; },
    apply(value) { seen.push(value); },
    ...extra,
  });
  function step() {
    time += 1000 / 60;
    for (const callback of queue.splice(0)) callback(time);
  }
  return { controller, queue, effects, calls, seen, step, requests: () => requests };
}

beforeEach(() => {
  vi.stubGlobal('CSS', { supports: () => true });
  __resetDetectionCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

describe('CompositorSpring: обратная передача единственного владельца', () => {
  it('старый retarget после live остаётся живым: один и тот же endpoint не доказывает native release', () => {
    const s = scene();
    const live = s.controller.handoffToLive(80);
    s.step();
    const requests = s.requests();
    s.controller.retarget(100);
    s.step();
    expect(live.value).toBeGreaterThan(0);
    expect(s.controller.mode).toBe('fallback');
    expect(s.calls).toHaveLength(0);
    expect(s.requests()).toBeGreaterThan(requests);
    s.controller.destroy();
    s.step();
    expect(s.queue).toHaveLength(0);
  });

  it.each([
    ['sheet', 80, 300],
    ['pager', -80, -200],
  ] as const)('%s: live follow → native release → новый live ввод без второго clock', (_name, pointer, target) => {
    const s = scene();
    const live = s.controller.handoffToLive(pointer);
    for (let i = 0; i < 4; i++) s.step();
    const value = live.value;
    const velocity = live.velocity;
    expect(velocity).not.toBe(0);

    s.controller.handoffToCompositor(target);

    expect(s.controller.mode).toBe('compositor');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.frames[0]!.opacity).toBe(value);
    expect(s.calls[0]!.frames.at(-1)!.opacity).toBe(target);
    expect(s.effects.filter(effect => !effect.cancelled)).toHaveLength(1);
    const nativeRequests = s.requests();
    const writes = s.seen.length;
    live.setTarget(-1000);
    s.step();
    expect(s.requests()).toBe(nativeRequests);
    expect(s.seen).toHaveLength(writes);
    expect(s.queue).toHaveLength(0);

    // Pending native-time ещё не имеет rendered slope: это исходная пара live.
    const picked = s.controller.handoffToLive(pointer / 2);
    expect(picked.value).toBe(value);
    expect(picked.velocity).toBeCloseTo(velocity, 10);
    expect(s.effects[0]!.cancelled).toBe(true);
    s.step();
    s.controller.handoffToCompositor(target / 2);
    expect(s.calls).toHaveLength(2);
    expect(s.effects.filter(effect => !effect.cancelled)).toHaveLength(1);
    s.controller.destroy();
    s.step();
    expect(s.effects.every(effect => effect.cancelled)).toBe(true);
    expect(s.queue).toHaveLength(0);
  });

  it('host отказ до commit оставляет живого donor и не теряет новый контроль', () => {
    let reject = true;
    const s = scene({ target: { animate() {
      if (reject) throw new Error('successor rejected');
      return { currentTime: null, cancel() {} };
    } } });
    const live = s.controller.handoffToLive(80);
    s.step();
    expect(() => s.controller.handoffToCompositor(200)).toThrow('successor rejected');
    expect(s.controller.mode).toBe('fallback');
    const value = live.value;
    s.step();
    expect(live.value).toBeGreaterThan(value);
    reject = false;
    s.controller.handoffToCompositor(200);
    expect(s.controller.mode).toBe('compositor');
    s.controller.destroy();
    s.step();
    expect(s.queue).toHaveLength(0);
  });

  it('непредставимый импульс при нулевом span сохраняет того же live-owner', () => {
    const s = scene();
    const live = s.controller.handoffToLive(80);
    for (let i = 0; i < 4; i++) s.step();
    const from = live.value;
    expect(live.velocity).not.toBe(0);
    s.controller.handoffToCompositor(from);
    expect(s.controller.mode).toBe('fallback');
    expect(s.calls).toHaveLength(0);
    s.step();
    expect(live.value).not.toBe(from);
    s.controller.destroy();
    s.step();
    expect(s.queue).toHaveLength(0);
  });

  it('отказ cleanup timer-donor после native commit не оставляет живую петлю', () => {
    let cancellations = 0;
    const s = scene({ delay: 30, setTimer() { return () => {
      cancellations++;
      throw new Error('timer cleanup failed');
    }; } });
    const live = s.controller.handoffToLive(80);
    s.step();
    s.controller.start();
    expect(() => s.controller.handoffToCompositor(200)).not.toThrow();
    expect(cancellations).toBe(1);
    expect(s.controller.mode).toBe('compositor');
    expect(s.effects.filter(effect => !effect.cancelled)).toHaveLength(1);
    const requests = s.requests();
    live.setTarget(300);
    s.step();
    expect(s.requests()).toBe(requests);
    expect(s.queue).toHaveLength(0);
    s.controller.destroy();
    expect(s.effects.every(effect => effect.cancelled)).toBe(true);
  });

  it.each([false, true])('native commit отзывает live donor до callback его cleanup, throw=%s', throws => {
    let s!: ReturnType<typeof scene>;
    s = scene({ delay: 30, setTimer() { return () => {
      s.step();
      if (throws) throw new Error('cleanup after delivered frame');
    }; } });
    const live = s.controller.handoffToLive(80);
    for (let i = 0; i < 4; i++) s.step();
    s.controller.start();
    const value = live.value;
    const velocity = live.velocity;
    expect(velocity).not.toBe(0);
    s.controller.handoffToCompositor(200);
    expect(s.calls[0]!.frames[0]!.opacity).toBe(value);
    const picked = s.controller.handoffToLive();
    expect(picked.value).toBe(value);
    expect(picked.velocity).toBeCloseTo(velocity, 10);
    s.controller.destroy();
    s.step();
    expect(s.queue).toHaveLength(0);
  });

  it.each([-10, -1, null])('numeric pre-start и pending native time различаются: %s', currentTime => {
    const s = scene();
    const live = s.controller.handoffToLive(80);
    for (let i = 0; i < 4; i++) s.step();
    const value = live.value;
    const velocity = live.velocity;
    expect(velocity).not.toBe(0);
    s.controller.handoffToCompositor(200);
    let reads = 0;
    Object.defineProperty(s.effects[0], 'currentTime', { get() { reads++; return currentTime; } });
    const picked = s.controller.handoffToLive();
    expect(reads).toBe(1);
    expect(picked.value).toBe(value);
    expect(picked.velocity).toBeCloseTo(currentTime === null ? velocity : 0, 10);
    s.controller.destroy();
    s.step();
    expect(s.queue).toHaveLength(0);
  });

  it.each([
    'retarget', 'setTarget', 'snapTo', 'setTarget(value)', 'snapTo(value)', 'setTarget ABA',
  ])('%s: новый live intent отзывает возвращающийся native effect', action => {
    const cancel = vi.fn();
    let reenter = () => {};
    const s = scene({ target: { animate() {
      reenter();
      return { currentTime: null, cancel };
    } } });
    const live = s.controller.handoffToLive(80);
    for (let i = 0; i < 4; i++) s.step();
    const from = live.value;
    expect(from).not.toBe(0);
    expect(live.velocity).not.toBe(0);
    const target = action.endsWith('(value)') ? from : action === 'setTarget ABA' ? 80 : 40;
    reenter = () => {
      if (action === 'retarget') s.controller.retarget(target);
      else if (action === 'setTarget ABA') {
        live.setTarget(40);
        live.setTarget(80);
      } else if (action.startsWith('setTarget')) live.setTarget(target);
      else live.snapTo(target);
    };

    s.controller.handoffToCompositor(200);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(s.controller.mode).toBe('fallback');
    for (let i = 0; i < 200 && s.queue.length; i++) s.step();
    expect(live.value).toBe(target);
    expect(s.controller.value).toBe(target);
    expect(s.seen.at(-1)).toBe(target);

    live.setTarget(-20);
    for (let i = 0; i < 200 && s.queue.length; i++) s.step();
    expect(s.controller.value).toBe(-20);
    s.controller.destroy();
    s.step();
    expect(s.queue).toHaveLength(0);
  });

  it.each(['stop', 'destroy'] as const)('%s live donor отзывает ещё не принятый native effect', action => {
    const cancel = vi.fn();
    let reenter = () => {};
    const s = scene({ target: { animate() {
      reenter();
      return { currentTime: null, cancel };
    } } });
    const live = s.controller.handoffToLive(80);
    for (let i = 0; i < 4; i++) s.step();
    const value = live.value;
    const writes = s.seen.length;
    reenter = () => live[action]();

    s.controller.handoffToCompositor(200);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(s.controller.mode).toBe('fallback');
    s.step();
    expect(s.controller.value).toBe(value);
    expect(s.seen).toHaveLength(writes);
    expect(s.queue).toHaveLength(0);
    s.controller.destroy();
  });

  it.each([
    { method: 'setTarget', resting: false },
    { method: 'setTarget', resting: true },
    { method: 'snapTo', resting: true },
  ] as const)('$method: no-op повтор цели не отменяет native release, resting=$resting', ({ method, resting }) => {
    const cancel = vi.fn();
    let reenter = () => {};
    const s = scene({ target: { animate() {
      reenter();
      return { currentTime: null, cancel };
    } } });
    const live = s.controller.handoffToLive(80);
    for (let i = 0; i < 4; i++) s.step();
    if (resting) live.snapTo(80);
    const from = live.value;
    reenter = () => live[method](80);

    s.controller.handoffToCompositor(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(s.controller.mode).toBe('compositor');
    expect(s.controller.value).toBe(from);
    const writes = s.seen.length;
    live.setTarget(-20);
    s.step();
    expect(s.seen).toHaveLength(writes);
    expect(s.queue).toHaveLength(0);
    s.controller.destroy();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reduced и RAF сохраняют endpoint без притворного native эффекта', () => {
    for (const extra of [{ target: undefined }, { matchMedia: () => ({ matches: true }) }]) {
      const s = scene(extra);
      s.controller.handoffToLive(80);
      s.step();
      s.controller.handoffToCompositor(200);
      for (let i = 0; i < 200 && s.queue.length; i++) s.step();
      expect(s.controller.value).toBe(200);
      expect(s.controller.mode).toBe('fallback');
      expect(s.calls).toHaveLength(0);
      s.controller.destroy();
    }
  });

  it('reduced release завершает активный live follow устойчивым снапом', () => {
    const s = scene({ matchMedia: () => ({ matches: true }) });
    const live = s.controller.handoffToLive(80);
    live.setTarget(0);
    s.step(); s.step();
    expect(live.velocity).not.toBe(0);
    const requests = s.requests();
    s.controller.handoffToCompositor(200);
    const writes = s.seen.length;
    expect(live.value).toBe(200);
    expect(live.velocity).toBe(0);
    s.step();
    expect(s.controller.value).toBe(200);
    expect(s.seen).toHaveLength(writes);
    expect(s.requests()).toBe(requests);
    expect(s.queue).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
    s.controller.destroy();
  });

  it('reduced release применяет новую цель после самостоятельного destroy live loan', () => {
    const s = scene({ matchMedia: () => ({ matches: true }) });
    s.controller.handoffToLive(80).destroy();
    s.controller.handoffToCompositor(200);
    expect(s.controller.value).toBe(200);
    s.controller.handoffToCompositor(80);
    expect(s.controller.value).toBe(80);
    expect(s.requests()).toBe(0);
    s.controller.destroy();
  });

  it('новый reduced loan отзывает прежний live-owner и его поздние кадры', () => {
    const s = scene({ matchMedia: () => ({ matches: true }) });
    const old = s.controller.handoffToLive(80);
    old.setTarget(0);
    s.step(); s.step();
    const next = s.controller.handoffToLive(200);
    expect(next.value).toBe(200);
    const requests = s.requests();
    old.setTarget(-500);
    s.step();
    expect(s.controller.value).toBe(200);
    expect(s.requests()).toBe(requests);
    expect(s.queue).toHaveLength(0);
    s.controller.destroy();
  });

  it('проверяет target до effects, а terminal вызов остаётся инертным', () => {
    const s = scene();
    s.controller.handoffToLive(80);
    expect(() => s.controller.handoffToCompositor(Number.NaN)).toThrow(MotionParamError);
    expect(s.calls).toHaveLength(0);
    s.controller.destroy();
    expect(() => s.controller.handoffToCompositor(Number.NaN)).not.toThrow();
    s.step();
    expect(s.queue).toHaveLength(0);
  });
});
