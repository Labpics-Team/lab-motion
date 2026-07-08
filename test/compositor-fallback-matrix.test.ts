/**
 * test/compositor-fallback-matrix.test.ts — матрица деградации compositor-пути (M4).
 *
 * Классы: А (маршрутизация тира → движок: WAAPI/linear/matchMedia моки),
 * Д (mutation/RED + негативные контроли), contract (диагностический `tier`).
 *
 * Каждый РЯД матрицы проверяется отдельным моком отсутствия возможности:
 *   compositor      — WAAPI + CSS.supports(linear)=true  → Element.animate вызван.
 *   waapi-no-linear — WAAPI, CSS.supports(linear)=false   → animate НЕ вызван, живой rAF.
 *   raf             — нет WAAPI, requestFrame инжектирован → живой rAF сходится.
 *   reduced         — matchMedia reduce=true               → снап к цели, animate НЕ вызван.
 *   ssr             — нет WAAPI, нет DOM, нет requestFrame  → тир 'ssr' (движок = живой rAF-шим).
 *
 * ── RED PROOF (мутанты, которые ловит файл) ────────────────────────────────────
 * - Снять reduce-проверку в resolveCompositorTier → reduced-ряд получит 'compositor'
 *   (есть target+CSS) → animate вызван → «reduced: animate НЕ вызван» RED.
 * - Снять linear()-проверку (всегда true) → waapi-no-linear-ряд станет 'compositor'
 *   → animate вызван → «waapi-no-linear: живой путь» RED.
 * - Инвертировать precedence (WAAPI раньше reduce) → «reduced перекрывает WAAPI» RED.
 * - Убрать мемо supportsLinearEasing → «CSS.supports вызван один раз» RED (2 вызова).
 *
 * Герметичность: globalThis.CSS/Element мокаются и восстанавливаются в afterEach;
 * __resetDetectionCache() сбрасывает мемо linear() между рядами (иначе первый ряд
 * отравил бы последующие). matchMedia инжектируется пер-контроллер (не глобаль).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositorSpring, resolveCompositorTier, supportsLinearEasing } from '../src/compositor/index.js';
import { MotionValue } from '../src/index.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import type { SpringParams } from '../src/spring.js';

const STIFF: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

/** matchMedia-стаб с фиксированным matches для семейства prefers-reduced-motion. */
function stubMatchMedia(matches: boolean): (q: string) => { matches: boolean } {
  return (_q: string) => ({ matches });
}

/** Фейк-Element: пишет вызовы .animate, раздаёт Animation со spy-cancel. */
function fakeElement() {
  const calls: { keyframes: unknown; timing: unknown }[] = [];
  return {
    calls,
    el: {
      animate(keyframes: Record<string, string | number>[], timing: object) {
        calls.push({ keyframes, timing });
        return { cancel: () => {} };
      },
    },
  };
}

/** Синхронные дренируемые часы (handle ≠ 0 → без setTimeout-шима). */
function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length;
  };
  const drain = (cap = 100000): number => {
    let n = 0;
    while (queue.length > 0 && n < cap) {
      queue.shift()!();
      n++;
    }
    return n;
  };
  return { requestFrame, drain };
}

/** Ставит globalThis.CSS.supports = () => value и сбрасывает мемо. Вернёт restore. */
function mockLinearSupport(value: boolean): () => void {
  const prev = (globalThis as { CSS?: unknown }).CSS;
  (globalThis as { CSS?: unknown }).CSS = { supports: () => value };
  __resetDetectionCache();
  return () => {
    if (prev === undefined) delete (globalThis as { CSS?: unknown }).CSS;
    else (globalThis as { CSS?: unknown }).CSS = prev;
    __resetDetectionCache();
  };
}

describe('compositor: fallback-матрица', () => {
  beforeEach(() => {
    __resetDetectionCache();
  });
  afterEach(() => {
    __resetDetectionCache();
    vi.restoreAllMocks();
  });

  // ─── Ряд: compositor ────────────────────────────────────────────────────────
  describe("тир 'compositor' (WAAPI + linear())", () => {
    it('WAAPI + linear() → tier=compositor, mode=compositor, Element.animate вызван', () => {
      const restore = mockLinearSupport(true);
      try {
        const f = fakeElement();
        const cs = new CompositorSpring({ spring: STIFF, property: 'x', from: 0, to: 1, target: f.el });
        expect(cs.tier).toBe('compositor');
        expect(cs.mode).toBe('compositor');
        cs.start();
        expect(f.calls.length).toBe(1);
      } finally {
        restore();
      }
    });
  });

  // ─── Ряд: waapi-no-linear ─────────────────────────────────────────────────────
  describe("тир 'waapi-no-linear' (WAAPI есть, linear() нет)", () => {
    it('WAAPI, но linear() не поддержан → tier=waapi-no-linear, animate НЕ вызван, живой rAF сходится', () => {
      const restore = mockLinearSupport(false);
      try {
        const f = fakeElement();
        const clock = makeClock();
        const seen: number[] = [];
        const cs = new CompositorSpring({
          spring: STIFF,
          property: 'x',
          from: 0,
          to: 100,
          target: f.el,
          apply: (v) => seen.push(v as number),
          requestFrame: clock.requestFrame,
        });
        expect(cs.tier).toBe('waapi-no-linear');
        expect(cs.mode).toBe('fallback');
        cs.start();
        clock.drain();
        // Compositor-путь НЕ использован (linear() не донёс бы кривую).
        expect(f.calls.length).toBe(0);
        // Живой rAF довёл значение до цели.
        expect(seen.length).toBeGreaterThan(3);
        expect(seen[seen.length - 1]).toBe(100);
        for (const v of seen) expect(Number.isFinite(v)).toBe(true);
      } finally {
        restore();
      }
    });
  });

  // ─── Ряд: raf ─────────────────────────────────────────────────────────────────
  describe("тир 'raf' (нет WAAPI, живой rAF)", () => {
    it('нет цели + requestFrame инжектирован → tier=raf, живой rAF сходится', () => {
      const clock = makeClock();
      const seen: number[] = [];
      const cs = new CompositorSpring({
        spring: STIFF,
        property: 'x',
        from: 0,
        to: 50,
        apply: (v) => seen.push(v as number),
        requestFrame: clock.requestFrame,
      });
      expect(cs.tier).toBe('raf');
      expect(cs.mode).toBe('fallback');
      cs.start();
      clock.drain();
      expect(seen[seen.length - 1]).toBe(50);
    });

    it('цель без .animate + requestFrame → tier=raf', () => {
      const clock = makeClock();
      const cs = new CompositorSpring({
        spring: STIFF,
        property: 'x',
        from: 0,
        to: 1,
        target: {} as never,
        requestFrame: clock.requestFrame,
      });
      expect(cs.tier).toBe('raf');
    });

    it('raf handoffToLive → отдаёт живой MotionValue, сходится к цели (fallback-ветка хендоффа)', () => {
      const clock = makeClock();
      const seen: number[] = [];
      const cs = new CompositorSpring({
        spring: STIFF,
        property: 'x',
        from: 0,
        to: 100,
        apply: (v) => seen.push(v as number),
        requestFrame: clock.requestFrame,
      });
      expect(cs.tier).toBe('raf');
      cs.start();
      clock.drain(5); // несколько кадров в полёте
      const mv = cs.handoffToLive(250);
      expect(mv).toBeInstanceOf(MotionValue);
      clock.drain();
      expect(mv.value).toBe(250); // живой путь ретаргетнул к новой цели
      cs.destroy();
    });
  });

  // ─── Ряд: reduced ─────────────────────────────────────────────────────────────
  describe("тир 'reduced' (prefers-reduced-motion: reduce → снап)", () => {
    it('reduce=true перекрывает WAAPI → tier=reduced, снап к цели, animate НЕ вызван', () => {
      const restore = mockLinearSupport(true);
      try {
        const f = fakeElement();
        const seen: number[] = [];
        const cs = new CompositorSpring({
          spring: STIFF,
          property: 'x',
          from: 0,
          to: 100,
          target: f.el,
          apply: (v) => seen.push(v as number),
          matchMedia: stubMatchMedia(true),
        });
        expect(cs.tier).toBe('reduced');
        expect(cs.mode).toBe('fallback');
        cs.start();
        // Снап: ровно один эмит финального значения, никакой анимации.
        expect(f.calls.length).toBe(0);
        expect(seen).toEqual([100]);
        expect(cs.value).toBe(100);
      } finally {
        restore();
      }
    });

    it('reduced retarget → мгновенный снап к новой цели', () => {
      const seen: number[] = [];
      const cs = new CompositorSpring({
        spring: STIFF,
        property: 'x',
        from: 0,
        to: 10,
        apply: (v) => seen.push(v as number),
        matchMedia: stubMatchMedia(true),
      });
      cs.start();
      cs.retarget(42);
      expect(cs.value).toBe(42);
      expect(seen).toEqual([10, 42]);
    });

    it('reduced с WAAPI-целью НЕ анимирует даже через retarget (снап при живой цели)', () => {
      const restore = mockLinearSupport(true);
      try {
        const f = fakeElement();
        const seen: number[] = [];
        const cs = new CompositorSpring({
          spring: STIFF,
          property: 'x',
          from: 0,
          to: 10,
          target: f.el, // цель поддержала бы compositor — но reduce её перекрывает
          apply: (v) => seen.push(v as number),
          matchMedia: stubMatchMedia(true),
        });
        expect(cs.tier).toBe('reduced');
        cs.start();
        cs.retarget(50);
        // Ни start, ни retarget не тронули Element.animate — только снапы.
        expect(f.calls.length).toBe(0);
        expect(seen).toEqual([10, 50]);
        expect(cs.value).toBe(50);
      } finally {
        restore();
      }
    });

    it('reduced handoffToLive → MotionValue уже на цели (без движения)', () => {
      const cs = new CompositorSpring({
        spring: STIFF,
        property: 'x',
        from: 0,
        to: 7,
        matchMedia: stubMatchMedia(true),
      });
      cs.start();
      const mv = cs.handoffToLive(9);
      expect(mv.value).toBe(9);
      expect(cs.value).toBe(9);
      cs.destroy();
    });

    it('НЕГ. КОНТРОЛЬ: reduce=false + WAAPI + linear() → tier=compositor (снапа НЕТ, animate вызван)', () => {
      const restore = mockLinearSupport(true);
      try {
        const f = fakeElement();
        const cs = new CompositorSpring({
          spring: STIFF,
          property: 'x',
          from: 0,
          to: 100,
          target: f.el,
          matchMedia: stubMatchMedia(false),
        });
        expect(cs.tier).toBe('compositor');
        cs.start();
        expect(f.calls.length).toBe(1);
      } finally {
        restore();
      }
    });
  });

  // ─── Ряд: ssr ─────────────────────────────────────────────────────────────────
  describe("тир 'ssr' (нет DOM, нет планировщика)", () => {
    it('нет цели, нет requestFrame, node (нет DOM) → tier=ssr, mode=fallback, конструкция не бросает', () => {
      expect(typeof document).toBe('undefined');
      const cs = new CompositorSpring({ spring: STIFF, property: 'x', from: 0, to: 1 });
      expect(cs.tier).toBe('ssr');
      expect(cs.mode).toBe('fallback');
      // SSR-safe: старт и уборка не бросают (движок = живой rAF под node-шимом).
      expect(() => {
        cs.start();
        cs.stop();
        cs.destroy();
      }).not.toThrow();
    });

    it('ssr handoffToLive → отдаёт живой MotionValue под node-шимом (fallback-ветка), destroy чист', () => {
      const cs = new CompositorSpring({ spring: STIFF, property: 'x', from: 0, to: 1 });
      expect(cs.tier).toBe('ssr');
      // Ветка живого хендоффа (не reduced, не compositor) отрабатывает и в ssr:
      // MotionValue строится на node-шиме (setTimeout), значение НЕ трогает DOM.
      const mv = cs.handoffToLive(0.7);
      expect(mv).toBeInstanceOf(MotionValue);
      expect(() => {
        mv.destroy();
        cs.destroy();
      }).not.toThrow();
    });
  });

  // ─── Прямой резолвер (телеметрия) ─────────────────────────────────────────────
  describe('resolveCompositorTier (прямой резолвер для телеметрии)', () => {
    it('reduce перекрывает всё (precedence)', () => {
      const restore = mockLinearSupport(true);
      try {
        const f = fakeElement();
        expect(
          resolveCompositorTier({ target: f.el, matchMedia: stubMatchMedia(true) }),
        ).toBe('reduced');
      } finally {
        restore();
      }
    });

    it('WAAPI + linear() → compositor; linear() нет → waapi-no-linear', () => {
      const f = fakeElement();
      let restore = mockLinearSupport(true);
      try {
        expect(resolveCompositorTier({ target: f.el })).toBe('compositor');
      } finally {
        restore();
      }
      restore = mockLinearSupport(false);
      try {
        expect(resolveCompositorTier({ target: f.el })).toBe('waapi-no-linear');
      } finally {
        restore();
      }
    });

    it('нет WAAPI: requestFrame → raf; ничего → ssr', () => {
      expect(resolveCompositorTier({ requestFrame: () => 0 })).toBe('raf');
      expect(resolveCompositorTier({})).toBe('ssr');
    });

    it('matchMedia БРОСАЕТ → guard ловит, reduce НЕ активен (падаем в WAAPI-ветку)', () => {
      const restore = mockLinearSupport(true);
      try {
        const f = fakeElement();
        const throwing = () => {
          throw new Error('matchMedia недоступен');
        };
        // Резолвер не роняется, reduce не активируется → compositor (есть target+linear).
        expect(resolveCompositorTier({ target: f.el, matchMedia: throwing })).toBe('compositor');
        // Тот же guard в конструкторе контроллера.
        const cs = new CompositorSpring({
          spring: STIFF,
          property: 'x',
          from: 0,
          to: 1,
          target: f.el,
          matchMedia: throwing,
        });
        expect(cs.tier).toBe('compositor');
      } finally {
        restore();
      }
    });
  });

  // ─── Кэш детекции (детекция один раз, дёшево) ─────────────────────────────────
  describe('кэш supportsLinearEasing (мемо на реалм)', () => {
    it('CSS.supports вызывается ОДИН раз при повторных запросах (мемоизация)', () => {
      const prev = (globalThis as { CSS?: unknown }).CSS;
      const spy = vi.fn(() => true);
      (globalThis as { CSS?: unknown }).CSS = { supports: spy };
      __resetDetectionCache();
      try {
        expect(supportsLinearEasing()).toBe(true);
        expect(supportsLinearEasing()).toBe(true);
        expect(supportsLinearEasing()).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        if (prev === undefined) delete (globalThis as { CSS?: unknown }).CSS;
        else (globalThis as { CSS?: unknown }).CSS = prev;
        __resetDetectionCache();
      }
    });

    it('__resetDetectionCache сбрасывает мемо (повторная детекция видит новое значение)', () => {
      let r = mockLinearSupport(true);
      expect(supportsLinearEasing()).toBe(true);
      r();
      r = mockLinearSupport(false);
      try {
        expect(supportsLinearEasing()).toBe(false);
      } finally {
        r();
      }
    });

    it('сто контроллеров делят одну пробу: CSS.supports вызван один раз на N инстансов', () => {
      const prev = (globalThis as { CSS?: unknown }).CSS;
      const spy = vi.fn(() => true);
      (globalThis as { CSS?: unknown }).CSS = { supports: spy };
      __resetDetectionCache();
      try {
        const f = fakeElement();
        for (let i = 0; i < 25; i++) {
          const cs = new CompositorSpring({ spring: STIFF, property: 'x', from: 0, to: 1, target: f.el });
          expect(cs.tier).toBe('compositor');
        }
        // Заявленный инвариант: парс CSS-строки амортизирован по всем контроллерам.
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        if (prev === undefined) delete (globalThis as { CSS?: unknown }).CSS;
        else (globalThis as { CSS?: unknown }).CSS = prev;
        __resetDetectionCache();
      }
    });

    it('нет CSS-API (SSR) → linear() считается поддержанным (Baseline default)', () => {
      const prev = (globalThis as { CSS?: unknown }).CSS;
      delete (globalThis as { CSS?: unknown }).CSS;
      __resetDetectionCache();
      try {
        expect(supportsLinearEasing()).toBe(true);
      } finally {
        if (prev !== undefined) (globalThis as { CSS?: unknown }).CSS = prev;
        __resetDetectionCache();
      }
    });
  });
});
