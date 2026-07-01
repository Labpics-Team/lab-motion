/**
 * test/a11y.test.ts — политика reduced-motion (subpath ./a11y).
 * Классы: А (политика/подписки) + Б (пин) + Д (mutation-proof).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают поведенческие блоки.
 * Mutation-proof: сломать приоритет override над системой → «always при
 * system=false» RED; сломать синтезированный matchMedia → интеграционный
 * тест с drive RED.
 */

import { describe, expect, it } from 'vitest';
import * as a11y from '../src/a11y/index.js';
import { createMotionConfig } from '../src/a11y/index.js';

/** Управляемый системный matchMedia-стаб. */
function systemMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mm = (query: string): MediaQueryList =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: (cb: (e: { matches: boolean }) => void) => listeners.add(cb),
      removeListener: (cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  return {
    mm,
    set(v: boolean) {
      matches = v;
      for (const cb of [...listeners]) cb({ matches: v });
    },
  };
}

// ─── Политика ─────────────────────────────────────────────────────────────────

describe('a11y/policy: режимы', () => {
  it("'system' (дефолт): читает системное предпочтение", () => {
    const sys = systemMedia(true);
    const cfg = createMotionConfig({ matchMedia: sys.mm });
    expect(cfg.prefersReduced()).toBe(true);
    const cfg2 = createMotionConfig({ matchMedia: systemMedia(false).mm });
    expect(cfg2.prefersReduced()).toBe(false);
  });

  it("'always': редьюс всегда, даже когда система против", () => {
    const cfg = createMotionConfig({ reducedMotion: 'always', matchMedia: systemMedia(false).mm });
    expect(cfg.prefersReduced()).toBe(true);
  });

  it("'never': никогда, даже когда система просит (осознанный оверрайд приложения)", () => {
    const cfg = createMotionConfig({ reducedMotion: 'never', matchMedia: systemMedia(true).mm });
    expect(cfg.prefersReduced()).toBe(false);
  });

  it('set() меняет режим на лету', () => {
    const cfg = createMotionConfig({ matchMedia: systemMedia(false).mm });
    expect(cfg.prefersReduced()).toBe(false);
    cfg.set('always');
    expect(cfg.prefersReduced()).toBe(true);
    cfg.set('system');
    expect(cfg.prefersReduced()).toBe(false);
  });

  it('без matchMedia (SSR): system → false; always → true', () => {
    expect(createMotionConfig().prefersReduced()).toBe(false);
    expect(createMotionConfig({ reducedMotion: 'always' }).prefersReduced()).toBe(true);
  });
});

// ─── Подписка ─────────────────────────────────────────────────────────────────

describe('a11y/policy: onChange', () => {
  it('уведомляет при set() и при смене системного предпочтения (в режиме system)', () => {
    const sys = systemMedia(false);
    const cfg = createMotionConfig({ matchMedia: sys.mm });
    const seen: boolean[] = [];
    const unsub = cfg.onChange((v) => seen.push(v));
    sys.set(true); // системное изменение
    cfg.set('never'); // оверрайд: true → false
    unsub();
    cfg.set('always'); // после отписки — тишина
    expect(seen).toEqual([true, false]);
  });

  it('не уведомляет, если эффективное значение не поменялось', () => {
    const sys = systemMedia(true);
    const cfg = createMotionConfig({ matchMedia: sys.mm });
    const seen: boolean[] = [];
    cfg.onChange((v) => seen.push(v));
    cfg.set('always'); // было true (system) → осталось true
    expect(seen).toEqual([]);
  });
});

// ─── Синтезированный matchMedia: интеграция со ВСЕМИ subpath ─────────────────

describe('a11y/policy: matchMedia-шов для остальных субпутей', () => {
  it('cfg.matchMedia отражает ПОЛИТИКУ, а не систему', () => {
    const cfg = createMotionConfig({ reducedMotion: 'always', matchMedia: systemMedia(false).mm });
    expect(cfg.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    const cfg2 = createMotionConfig({ reducedMotion: 'never', matchMedia: systemMedia(true).mm });
    expect(cfg2.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
  });

  it('drive() с cfg.matchMedia уважает политику always (интеграция без правки ядра)', async () => {
    const { drive } = await import('../src/index.js');
    const cfg = createMotionConfig({ reducedMotion: 'always', matchMedia: systemMedia(false).mm });
    const steps: number[] = [];
    await drive({
      from: 0,
      to: 100,
      spring: { mass: 1, stiffness: 200, damping: 20 },
      onStep: (v) => steps.push(v),
      matchMedia: cfg.matchMedia,
      requestFrame: () => 1,
    });
    // Политика always → CHARACTER-switch ядра: мгновенный снап в target.
    expect(steps).toEqual([100]);
  });

  it('не-reduce запросы прозрачно проксируются в систему', () => {
    const sys = systemMedia(false);
    const cfg = createMotionConfig({ matchMedia: sys.mm });
    const q = '(min-width: 600px)';
    expect(cfg.matchMedia(q).media).toBe(q);
  });
});

// ─── API surface pin ──────────────────────────────────────────────────────────

describe('a11y-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(a11y).sort()).toEqual(['createMotionConfig']);
  });

  it('форма конфига (исчерпывающе)', () => {
    const cfg = createMotionConfig();
    expect(Object.keys(cfg).sort()).toEqual(['matchMedia', 'mode', 'onChange', 'prefersReduced', 'set']);
  });

  it('SSR: node env — не бросает', () => {
    expect(() => {
      const c = createMotionConfig();
      c.prefersReduced();
      c.matchMedia('(prefers-reduced-motion: reduce)');
    }).not.toThrow();
  });
});
