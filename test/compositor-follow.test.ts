import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompositorFollow, compileSpringPlan } from '../src/compositor/follow/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { MotionParamError } from '../src/errors.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function fixture(withWriter = true, reduced = false) {
  const hooks: {
    format?: (value: number) => string | number;
    write?: (value: string | number) => void;
    cancel?: () => void;
    animate?: () => void;
  } = {};
  const frames: Array<(timestamp?: number) => void> = [];
  const writes: Array<string | number> = [];
  const animations: Array<{
    currentTime: number;
    cancel: ReturnType<typeof vi.fn>;
    timing: { easing: string; duration: number };
  }> = [];
  const target = {
    animate(_keyframes: unknown, timing: object) {
      const animation = {
        currentTime: 16,
        cancel: vi.fn(() => hooks.cancel?.()),
        timing: timing as { easing: string; duration: number },
      };
      animations.push(animation);
      hooks.animate?.();
      return animation;
    },
  };
  const owner = createCompositorFollow({
    spring: SPRING, property: 'opacity', from: 0, to: 100, target,
    apply: withWriter ? (value) => { writes.push(value); hooks.write?.(value); } : undefined,
    format: (value) => hooks.format?.(value) ?? value,
    now: () => 0,
    requestFrame(callback) { frames.push(callback); return frames.length; },
    matchMedia: () => ({ matches: reduced }),
  });
  return { owner, frames, writes, animations, hooks };
}

function plan(from: number, to: number, velocity: number) {
  return compileSpringPlan({
    spring: SPRING, property: 'opacity', from, to,
    v0: velocity / (to - from),
  });
}

beforeEach(() => {
  vi.stubGlobal('CSS', { supports: () => true });
  vi.stubGlobal('navigator', { vendor: '', userAgent: 'Chromium' });
  __resetDetectionCache();
});
afterEach(() => { vi.unstubAllGlobals(); __resetDetectionCache(); });

describe('универсальный follow → native settle → pickup', () => {
  it('повторяет цикл у одного owner без live-кадра на pickup или release', () => {
    const f = fixture();
    f.owner.start();
    const first = f.animations[0]!;
    const value = f.owner.beginFollow(10);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(100);
    expect(f.writes.at(-1)).toBe(value);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(f.frames).toHaveLength(0);

    f.owner.follow(value + 40, 10.02);
    f.owner.settle(200, 10.02);
    expect(f.animations).toHaveLength(2);
    expect(f.frames).toHaveLength(0);
    const next = f.owner.beginFollow(10.1);
    expect(f.animations[1]!.cancel).toHaveBeenCalledTimes(1);
    f.owner.follow(next + 15, 10.12);
    f.owner.settle(300, 10.12);
    expect(f.animations).toHaveLength(3);
    expect(f.frames).toHaveLength(0);
    f.owner.destroy();
    expect(f.animations[2]!.cancel).toHaveBeenCalledTimes(1);
  });

  it('обычное движение переносит скорость из input timestamps в native план', () => {
    const f = fixture();
    expect(f.owner.beginFollow(1)).toBe(0);
    f.owner.follow(20, 1.02);
    f.owner.settle(100, 1.02);
    const expected = plan(20, 100, 20 / (1.02 - 1));
    expect(f.animations[0]!.timing.easing).toBe(expected.easing);
    expect(f.animations[0]!.timing.duration).toBe(expected.duration);
    expect(f.frames).toHaveLength(0);
    f.owner.destroy();
  });

  it('различает немедленный re-release и неподвижное удержание с продвижением времени', () => {
    const instant = fixture();
    instant.owner.start();
    const first = instant.owner.beginFollow(5);
    instant.owner.settle(200, 5);
    expect(instant.animations[1]!.timing.easing).not.toBe(plan(first, 200, 0).easing);
    instant.owner.destroy();

    const held = fixture();
    held.owner.start();
    const second = held.owner.beginFollow(5);
    held.owner.settle(200, 7);
    expect(held.animations[1]!.timing.easing).toBe(plan(second, 200, 0).easing);
    expect(held.frames).toHaveLength(0);
    held.owner.destroy();
  });

  it('отвергает неверное время, значение и порядок до host effects', () => {
    const f = fixture();
    expect(() => f.owner.follow(1, 0)).toThrow();
    f.owner.start();
    const native = f.animations[0]!;
    expect(() => f.owner.beginFollow(Number.NaN)).toThrow();
    expect(native.cancel).not.toHaveBeenCalled();
    f.owner.beginFollow(5);
    const writes = f.writes.length;
    const animations = f.animations.length;
    expect(() => f.owner.follow(Number.NaN, 5.1)).toThrow();
    expect(() => f.owner.follow(1, 4.9)).toThrow();
    expect(() => f.owner.settle(100, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => f.owner.settle(100, 4.9)).toThrow();
    expect(f.writes).toHaveLength(writes);
    expect(f.animations).toHaveLength(animations);
    expect(f.frames).toHaveLength(0);
    f.owner.follow(10, 5.1);
    f.owner.settle(100, 5.1);
    expect(f.animations).toHaveLength(animations + 1);
    f.owner.destroy();
  });

  it('проверяет writer до отмены действующего native owner', () => {
    const f = fixture(false);
    f.owner.start();
    expect(() => f.owner.beginFollow(1)).toThrow(MotionParamError);
    expect(f.animations[0]!.cancel).not.toHaveBeenCalled();
    expect(f.frames).toHaveLength(0);
    f.owner.destroy();
  });

  it('сохраняет прямой ввод при reduced motion, а settle завершает без анимации', () => {
    const f = fixture(true, true);
    f.owner.beginFollow(0);
    f.owner.follow(20, 0.05);
    expect(f.writes.at(-1)).toBe(20);
    f.owner.settle(100, 0.05);
    expect(f.writes.at(-1)).toBe(100);
    expect(f.animations).toHaveLength(0);
    expect(f.frames).toHaveLength(0);
    f.owner.destroy();
  });

  it('same-time sample заменяет предыдущую точку, а последующее движение остаётся разрешено', () => {
    const f = fixture();
    f.owner.beginFollow(1);
    f.owner.follow(10, 1);
    f.owner.follow(20, 1.02);
    f.owner.settle(100, 1.02);
    expect(f.animations[0]!.timing.easing).toBe(plan(20, 100, 10 / (1.02 - 1)).easing);
    f.owner.destroy();
  });

  it('немедленный pickup сохраняет скорость при большом конечном origin input clock', () => {
    const control = fixture();
    control.owner.start();
    const live = control.owner.handoffToLive();
    const value = live.value;
    const velocity = live.velocity;
    expect(velocity).toBeGreaterThan(0);
    control.owner.destroy();

    const f = fixture();
    f.owner.start();
    expect(f.owner.beginFollow(1e16)).toBe(value);
    f.owner.settle(200, 1e16);
    expect(f.animations[1]!.timing.easing).toBe(plan(value, 200, velocity).easing);
    f.owner.destroy();
  });

  it('stop отзывает сессию, destroy остаётся terminal, последующий begin после stop разрешён', () => {
    const f = fixture();
    f.owner.beginFollow(1);
    f.owner.follow(20, 1.02);
    f.owner.stop();
    expect(() => f.owner.settle(100, 1.03)).toThrow(MotionParamError);
    expect(() => f.owner.follow(30, 1.03)).toThrow(MotionParamError);
    expect(f.owner.beginFollow(2)).toBe(20);
    f.owner.settle(100, 2);
    expect(() => f.owner.settle(200, 2)).toThrow(MotionParamError);
    f.owner.destroy();
    const writes = f.writes.length;
    f.owner.beginFollow(3);
    f.owner.follow(0, 4);
    f.owner.settle(100, 4);
    f.owner.start();
    expect(f.animations).toHaveLength(1);
    expect(f.writes).toHaveLength(writes);
  });

  it.each(['format', 'write'] as const)('ошибка pickup в %s сохраняет native donor и первичную ошибку', (hook) => {
    const f = fixture();
    f.owner.start();
    const failure = new Error('pickup failed');
    f.hooks[hook] = () => { throw failure; };
    expect(() => f.owner.beginFollow(1)).toThrow(failure);
    expect(f.animations[0]!.cancel).not.toHaveBeenCalled();
    f.hooks[hook] = undefined;
    f.owner.retarget(200);
    expect(f.animations).toHaveLength(2);
    expect(f.animations[0]!.cancel).toHaveBeenCalledTimes(1);
    f.owner.destroy();
  });

  it.each([['format', false], ['format', true], ['write', false], ['write', true]] as const)(
    'reentrant follow из %s снимает donor; ошибка outer callback: %s', (hook, throws) => {
      const f = fixture();
      f.owner.start();
      const failure = new Error('outer callback failed');
      f.hooks[hook] = (value) => {
        f.hooks[hook] = undefined;
        f.owner.follow(20, 1.01);
        if (throws) throw failure;
        return value;
      };
      if (throws) expect(() => f.owner.beginFollow(1)).toThrow(failure);
      else expect(f.owner.beginFollow(1)).toBe(20);
      expect(f.owner.value).toBe(20);
      expect(f.writes.at(-1)).toBe(20);
      expect(f.animations).toHaveLength(1);
      expect(f.animations[0]!.cancel).toHaveBeenCalledTimes(1);
      expect(f.frames).toHaveLength(0);
      f.owner.follow(30, 1.02);
      expect(f.writes.at(-1)).toBe(30);
      expect(f.animations[0]!.cancel).toHaveBeenCalledTimes(1);
      f.owner.destroy();
    },
  );

  it('reentrant settle внутри pickup write оставляет новый native owner', () => {
    const f = fixture();
    f.owner.start();
    f.hooks.write = () => {
      f.hooks.write = undefined;
      f.owner.settle(200, 1);
    };
    f.owner.beginFollow(1);
    expect(f.animations).toHaveLength(2);
    expect(f.animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(f.animations[1]!.cancel).not.toHaveBeenCalled();
    expect(f.frames).toHaveLength(0);
    f.owner.destroy();
  });

  it.each(['settle', 'retarget', 'handoff', 'stop', 'destroy'] as const)('nested follow сохраняет successor %s', (action) => {
    const f = fixture();
    f.owner.start();
    f.hooks.write = () => {
      f.hooks.write = () => {
        f.hooks.write = undefined;
        if (action === 'settle') f.owner.settle(200, 1.01);
        else if (action === 'retarget') f.owner.retarget(200);
        else if (action === 'handoff') f.owner.handoffToLive(200);
        else f.owner[action]();
      };
      f.owner.follow(20, 1.01);
    };
    f.owner.beginFollow(1);
    expect(f.animations[0]!.cancel).toHaveBeenCalledTimes(1);
    const native = action === 'settle' || action === 'retarget';
    expect(f.animations).toHaveLength(native ? 2 : 1);
    if (native) expect(f.animations[1]!.cancel).not.toHaveBeenCalled();
    expect(f.frames).toHaveLength(action === 'handoff' ? 1 : 0);
    if (action === 'stop') expect(() => f.owner.follow(30, 1.02)).toThrow(MotionParamError);
    f.owner.destroy();
    const writes = f.writes.length;
    f.owner.follow(30, 1.02);
    expect(f.writes).toHaveLength(writes);
  });

  it('destroy во время write не даёт callback восстановить direct или native owner', () => {
    const f = fixture();
    f.owner.start();
    f.hooks.write = () => f.owner.destroy();
    f.owner.beginFollow(1);
    f.owner.follow(20, 1.02);
    f.owner.settle(200, 1.02);
    expect(f.animations).toHaveLength(1);
    expect(f.animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(f.frames).toHaveLength(0);
  });

  it('native cleanup не выдаёт повторную mutation capability', () => {
    const f = fixture();
    f.owner.start();
    f.hooks.cancel = () => {
      f.owner.start();
      f.owner.follow(99, 1);
    };
    const value = f.owner.beginFollow(1);
    expect(value).not.toBe(99);
    expect(f.animations).toHaveLength(1);
    f.hooks.cancel = undefined;
    f.owner.settle(200, 1);
    expect(f.animations).toHaveLength(2);
    f.owner.destroy();
  });

  it('повторный pickup отзывает старые live callbacks и снова допускает native settle', () => {
    const f = fixture();
    f.owner.start();
    f.owner.handoffToLive(200);
    expect(f.frames).toHaveLength(1);
    const value = f.owner.beginFollow(1);
    const writes = f.writes.length;
    f.frames[0]!(16);
    expect(f.writes).toHaveLength(writes);
    expect(f.frames).toHaveLength(1);
    f.owner.settle(value + 200, 1);
    expect(f.animations).toHaveLength(2);
    expect(f.frames).toHaveLength(1);
    f.owner.destroy();
  });

  it('live callback уже отозван внутри writer нового direct owner', () => {
    const f = fixture();
    f.owner.start();
    f.owner.handoffToLive(200);
    const frames = f.frames.length;
    const writes = f.writes.length;
    f.hooks.write = () => {
      f.hooks.write = undefined;
      f.frames[0]!(16);
    };
    f.owner.beginFollow(1);
    expect(f.writes).toHaveLength(writes + 1);
    expect(f.frames).toHaveLength(frames);
    f.owner.destroy();
  });

  it('нулевой диапазон с импульсом использует canonical live fallback', () => {
    const f = fixture();
    f.owner.beginFollow(1);
    f.owner.follow(20, 1.02);
    f.owner.settle(20, 1.02);
    expect(f.animations).toHaveLength(0);
    expect(f.frames).toHaveLength(1);
    expect(f.owner.mode).toBe('fallback');
    f.owner.beginFollow(1.02);
    f.owner.settle(200, 1.02);
    expect(f.animations).toHaveLength(1);
    expect(f.owner.mode).toBe('compositor');
    f.owner.destroy();
  });
});
