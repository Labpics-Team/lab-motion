/**
 * test/lite.test.ts — контракт WAAPI-first фасада ./lite.
 *
 * Классы: API-surface pin, построение кадра/тайминга, fail-fast валидация,
 * агрегированные контролы (finished/play/pause/seek/cancel/stop/onComplete),
 * SSR-резолв селектора, reduced-motion. Исполнение проверяется на записывающем
 * WAAPI-моке (как nano.test.ts): пин эмитируемых keyframes/timing и вызовов
 * контролов, не браузерная интерполяция (это browser-conformance).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as liteModule from '../src/lite/index.js';
import { animate } from '../src/lite/index.js';
import { MotionParamError } from '../src/errors.js';
import { springLinear } from '../src/nano/spring-linear.js';

type Timing = KeyframeAnimationOptions & { easing?: string };

function recordingElement() {
  const calls: Array<{ keyframes: PropertyIndexedKeyframes; timing: Timing }> = [];
  const animations: Array<{
    finished: Promise<unknown>;
    currentTime: number | null;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    commitStyles: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    finish(): void;
  }> = [];
  return {
    calls,
    animations,
    animate(keyframes: PropertyIndexedKeyframes, timing: Timing) {
      let resolve!: (v: unknown) => void;
      let reject!: (r: unknown) => void;
      const finishListeners: Array<() => void> = [];
      const animation = {
        finished: new Promise((res, rej) => { resolve = res; reject = rej; }),
        currentTime: 0 as number | null,
        play: vi.fn(),
        pause: vi.fn(),
        cancel: vi.fn(() => reject(new DOMException('cancelled', 'AbortError'))),
        commitStyles: vi.fn(),
        addEventListener: vi.fn((type: string, listener: () => void) => {
          if (type === 'finish') finishListeners.push(listener);
        }),
        finish() {
          resolve(animation);
          for (const listener of finishListeners) listener();
        },
      };
      calls.push({ keyframes, timing });
      animations.push(animation);
      return animation as unknown as Animation;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── API-surface pin ─────────────────────────────────────────────────────────

describe('./lite — пин публичной поверхности', () => {
  it('экспортирует ровно animate (типы стираются)', () => {
    expect(new Set(Object.keys(liteModule))).toEqual(new Set(['animate']));
  });
  it('animate — функция сигнатуры (target, props, options?)', () => {
    expect(typeof animate).toBe('function');
    expect(animate.length).toBe(2);
  });
});

// ─── Построение кадра ─────────────────────────────────────────────────────────

describe('./lite — кадр WAAPI', () => {
  it('компонует независимые transform-оси в один transform (to-only → WAAPI берёт from)', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { x: 240, y: 12, scale: 1.2, rotate: 8, opacity: 1 });
    expect(el.calls[0]!.keyframes).toEqual({
      opacity: [1],
      transform: ['translate(240px, 12px) scale(1.2) rotate(8deg)'],
    });
  });

  it('пара [from, to] на transform-оси даёт явный from-кадр', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { x: [50, 100] });
    expect(el.calls[0]!.keyframes).toEqual({ transform: ['translateX(50px)', 'translateX(100px)'] });
  });

  it('identity-from сворачивается в WAAPI-совместимый "none" (spec-identity)', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { x: [0, 100] });
    // buildTransform(x:0) = "none" — Web Animations трактует none как identity
    // той же примитивы, поэтому none → translateX(100px) интерполируется корректно.
    expect(el.calls[0]!.keyframes).toEqual({ transform: ['none', 'translateX(100px)'] });
  });

  it('пара и to-only на opacity/CSS: [from, to] против [to]', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { opacity: [0, 1], backgroundColor: 'rgb(255, 0, 0)' });
    expect(el.calls[0]!.keyframes).toEqual({ opacity: [0, 1], backgroundColor: ['rgb(255, 0, 0)'] });
  });

  it('произвольные CSS-свойства проходят как есть (to-only)', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { filter: 'blur(4px)' }, { duration: 100 });
    expect(el.calls[0]!.keyframes).toEqual({ filter: ['blur(4px)'] });
  });
});

// ─── Тайминг ──────────────────────────────────────────────────────────────────

describe('./lite — тайминг', () => {
  it('пружина по умолчанию — тот же linear() SSOT, что ./nano', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { opacity: 1 });
    const [duration, easing] = springLinear();
    expect(el.calls[0]!.timing).toMatchObject({ duration, easing, fill: 'both', delay: 0 });
  });

  it('tween: строковый ease отдаётся платформе как есть', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { opacity: 1 }, { duration: 180, ease: 'cubic-bezier(.2,.8,.2,1)' });
    expect(el.calls[0]!.timing).toMatchObject({ duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });

  it('tween: JS-easing семплируется в linear() (равномерная сетка, границы 0 и 1)', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { opacity: 1 }, { duration: 200, ease: (t) => t * t });
    const easing = String(el.calls[0]!.timing.easing);
    expect(easing).toMatch(/^linear\(0,/);
    expect(easing.endsWith('1)')).toBe(true);
    // t² в середине → 0.25
    expect(easing).toContain('0.25');
  });

  it('tween без ease — нативный "ease"; duration по умолчанию 200', () => {
    const el = recordingElement();
    animate(el as unknown as Element, { opacity: 1 }, { duration: 300 });
    expect(el.calls[0]!.timing).toMatchObject({ duration: 300, easing: 'ease' });
  });
});

// ─── Каскад и reduced-motion ────────────────────────────────────────────────────

describe('./lite — каскад и reduced-motion', () => {
  it('stagger числом даёт шаг задержки между целями', () => {
    const first = recordingElement();
    const second = recordingElement();
    animate([first, second] as unknown as Element[], { opacity: 1 }, { delay: 20, stagger: 15 });
    expect(first.calls[0]!.timing.delay).toBe(20);
    expect(second.calls[0]!.timing.delay).toBe(35);
  });

  it('reduced-motion схлопывает длительность и каскад', () => {
    const first = recordingElement();
    const second = recordingElement();
    animate([first, second] as unknown as Element[], { x: 100 }, {
      duration: 200, delay: 30, stagger: 40, reducedMotion: true,
    });
    for (const el of [first, second]) {
      expect(el.calls[0]!.timing).toMatchObject({ duration: 0, delay: 0, easing: 'linear' });
    }
  });

  it('reducedMotion читается из matchMedia в момент вызова', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const el = recordingElement();
    animate(el as unknown as Element, { opacity: 1 });
    expect(el.calls[0]!.timing.duration).toBe(0);
  });
});

// ─── Цели ────────────────────────────────────────────────────────────────────

describe('./lite — резолв целей', () => {
  it('резолвит селектор только в момент вызова', () => {
    const el = recordingElement();
    const querySelectorAll = vi.fn(() => [el]);
    vi.stubGlobal('document', { querySelectorAll });
    animate('.hero', { opacity: 1 });
    expect(querySelectorAll).toHaveBeenCalledWith('.hero');
    expect(el.calls).toHaveLength(1);
  });

  it('пустой список целей — finished сразу резолвится', async () => {
    const controls = animate([] as unknown as Element[], { opacity: 1 });
    expect(controls.animations).toHaveLength(0);
    await expect(controls.finished).resolves.toBeUndefined();
  });
});

// ─── Fail-fast валидация ────────────────────────────────────────────────────────

describe('./lite — fail-fast (ноль запущенных при броске, каталогизированные коды)', () => {
  const throwsCode = (code: string, fn: () => unknown): void => {
    let caught: unknown;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe(code);
  };

  it('spring и duration одновременно — LM136', () => {
    const el = recordingElement();
    throwsCode('LM136', () => animate(el as unknown as Element, { opacity: 1 }, {
      spring: { mass: 1, stiffness: 170, damping: 26 }, duration: 100,
    }));
    expect(el.calls).toEqual([]);
  });

  it('некорректная duration — LM137', () => {
    const el = recordingElement();
    throwsCode('LM137', () => animate(el as unknown as Element, { opacity: 1 }, { duration: -5 }));
    expect(el.calls).toEqual([]);
  });

  it('ease не строка и не функция — LM138', () => {
    const el = recordingElement();
    throwsCode('LM138', () => animate(el as unknown as Element, { opacity: 1 }, {
      duration: 100, ease: 42 as never,
    }));
    expect(el.calls).toEqual([]);
  });

  it('whole transform-ключ — LM140 (использовать шортхенды)', () => {
    const el = recordingElement();
    throwsCode('LM140', () => animate(el as unknown as Element, { transform: 'rotate(45deg)' } as never));
    expect(el.calls).toEqual([]);
  });

  it('пара неверной длины — LM141', () => {
    const el = recordingElement();
    throwsCode('LM141', () => animate(el as unknown as Element, { opacity: [0, 0.5, 1] as never }));
    expect(el.calls).toEqual([]);
  });

  it('нечисловая transform-ось — LM142', () => {
    const el = recordingElement();
    throwsCode('LM142', () => animate(el as unknown as Element, { x: Number.NaN }));
    expect(el.calls).toEqual([]);
  });

  it('отрицательная delay — LM139', () => {
    const el = recordingElement();
    throwsCode('LM139', () => animate(el as unknown as Element, { opacity: 1 }, { delay: -10 }));
    expect(el.calls).toEqual([]);
  });

  it('селектор без document — LM149', () => {
    throwsCode('LM149', () => animate('.hero', { opacity: 1 }));
  });

  it('не-контейнер целью — LM146 (не голый TypeError)', () => {
    throwsCode('LM146', () => animate(null as never, { opacity: 1 }));
  });

  it('props не объект — LM151', () => {
    const el = recordingElement();
    throwsCode('LM151', () => animate(el as unknown as Element, 42 as never));
    expect(el.calls).toEqual([]);
  });

  it('onComplete не функция — LM156', () => {
    const el = recordingElement();
    throwsCode('LM156', () => animate(el as unknown as Element, { opacity: 1 }, { onComplete: 42 as never }));
    expect(el.calls).toEqual([]);
  });
});

// ─── Агрегированные контролы ────────────────────────────────────────────────────

describe('./lite — контролы группы', () => {
  it('play/pause/seek проксируются каждой цели', () => {
    const first = recordingElement();
    const second = recordingElement();
    const c = animate([first, second] as unknown as Element[], { opacity: 1 });
    c.play(); c.pause(); c.seek(120);
    for (const el of [first, second]) {
      expect(el.animations[0]!.play).toHaveBeenCalledOnce();
      expect(el.animations[0]!.pause).toHaveBeenCalledOnce();
      expect(el.animations[0]!.currentTime).toBe(120);
    }
  });

  it('seek(NaN) и seek(-∞) — no-op', () => {
    const el = recordingElement();
    const c = animate(el as unknown as Element, { opacity: 1 });
    el.animations[0]!.currentTime = 7;
    c.seek(Number.NaN);
    c.seek(Number.NEGATIVE_INFINITY);
    expect(el.animations[0]!.currentTime).toBe(7);
  });

  it('finished резолвится, когда все цели естественно завершились; onComplete один раз', async () => {
    const first = recordingElement();
    const second = recordingElement();
    const onComplete = vi.fn();
    const c = animate([first, second] as unknown as Element[], { opacity: 1 }, { onComplete });
    first.animations[0]!.finish();
    expect(onComplete).not.toHaveBeenCalled();
    second.animations[0]!.finish();
    await c.finished;
    expect(onComplete).toHaveBeenCalledOnce();
    // каждая цель зафиксировала позу и очистилась
    for (const el of [first, second]) {
      expect(el.animations[0]!.commitStyles).toHaveBeenCalledOnce();
      expect(el.animations[0]!.cancel).toHaveBeenCalledOnce();
    }
  });

  it('cancel сохраняет позу (commitStyles+cancel) и НЕ вызывает onComplete', async () => {
    const el = recordingElement();
    const onComplete = vi.fn();
    const c = animate(el as unknown as Element, { opacity: 1 }, { onComplete });
    c.cancel();
    await c.finished;
    expect(el.animations[0]!.commitStyles).toHaveBeenCalledOnce();
    expect(el.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('естественный finish, затем stop() одной цели — счётчик не удваивается', async () => {
    const el = recordingElement();
    const onComplete = vi.fn();
    const c = animate(el as unknown as Element, { opacity: 1 }, { onComplete });
    el.animations[0]!.finish();
    c.stop(); // не должен «доотчитаться» повторно
    await c.finished;
    expect(onComplete).toHaveBeenCalledOnce();
    expect(el.animations[0]!.commitStyles).toHaveBeenCalledOnce();
  });
});
