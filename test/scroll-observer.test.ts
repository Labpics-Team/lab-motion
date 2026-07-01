/**
 * test/scroll-observer.test.ts — in-view машина, оркестратор, scrub-клей, пин.
 * Классы: А + Б (пин) + Д (mutation-proof).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации. Mutation-proof: убрать порог amount в createInView →
 * тест «amount:'all'» RED; сломать once-семантику enter/leave → «повторный
 * enter без leave» RED; убрать clamp у scrubBinding → NaN-progress тест RED.
 */

import { describe, expect, it } from 'vitest';
import * as scroll from '../src/scroll/index.js';
import {
  createInView,
  createScrollObserver,
  createScrollVelocity,
  resolveTargetProgress,
  scrollProgress,
  scrubBinding,
} from '../src/scroll/index.js';

// ─── createInView ─────────────────────────────────────────────────────────────

function ivLog() {
  const log: string[] = [];
  return {
    log,
    opts: { onEnter: () => log.push('enter'), onLeave: () => log.push('leave') },
  };
}

describe('scroll/inView: пороги видимости', () => {
  // Viewport 500. target size 300.
  it("amount:'some' (дефолт): виден любой пиксель → enter; полностью скрыт → leave", () => {
    const { log, opts } = ivLog();
    const iv = createInView(opts);
    iv.update({ targetStart: 600, targetSize: 300, viewportLength: 500 }); // ниже вьюпорта
    expect(log).toEqual([]);
    iv.update({ targetStart: 400, targetSize: 300, viewportLength: 500 }); // частично виден
    expect(log).toEqual(['enter']);
    expect(iv.inView).toBe(true);
    iv.update({ targetStart: -350, targetSize: 300, viewportLength: 500 }); // полностью выше
    expect(log).toEqual(['enter', 'leave']);
    expect(iv.inView).toBe(false);
  });

  it("amount:'all': enter только когда target виден ЦЕЛИКОМ", () => {
    const { log, opts } = ivLog();
    const iv = createInView({ ...opts, amount: 'all' });
    iv.update({ targetStart: 400, targetSize: 300, viewportLength: 500 }); // частично
    expect(log).toEqual([]);
    iv.update({ targetStart: 100, targetSize: 300, viewportLength: 500 }); // целиком
    expect(log).toEqual(['enter']);
  });

  it('amount:0.5: enter когда видна половина площади', () => {
    const { log, opts } = ivLog();
    const iv = createInView({ ...opts, amount: 0.5 });
    iv.update({ targetStart: 400, targetSize: 300, viewportLength: 500 }); // видно 100/300
    expect(log).toEqual([]);
    iv.update({ targetStart: 300, targetSize: 300, viewportLength: 500 }); // видно 200/300 ≥ 0.5? нет (0.66… да)
    expect(log).toEqual(['enter']);
  });

  it('margin расширяет вьюпорт (отрицательный — сужает)', () => {
    const { log, opts } = ivLog();
    const iv = createInView({ ...opts, margin: 100 });
    iv.update({ targetStart: 550, targetSize: 300, viewportLength: 500 }); // в 100px-зоне предзагрузки
    expect(log).toEqual(['enter']);
  });

  it('повторные update в том же состоянии не дублируют события', () => {
    const { log, opts } = ivLog();
    const iv = createInView(opts);
    iv.update({ targetStart: 100, targetSize: 300, viewportLength: 500 });
    iv.update({ targetStart: 120, targetSize: 300, viewportLength: 500 });
    iv.update({ targetStart: 140, targetSize: 300, viewportLength: 500 });
    expect(log).toEqual(['enter']);
  });

  it('fuzz: злые входы не бросают и держат inView булевым', () => {
    let s = 31337;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE];
    const pick = (): number => (rnd() < 0.4 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e4);
    const iv = createInView({ amount: 0.3 });
    for (let i = 0; i < 2000; i++) {
      iv.update({ targetStart: pick(), targetSize: pick(), viewportLength: pick() });
      expect(typeof iv.inView).toBe('boolean');
    }
  });
});

// ─── createScrollObserver ─────────────────────────────────────────────────────

describe('scroll/observer: оркестратор', () => {
  it('страничный режим: onProgress получает прогресс и скорость', () => {
    const got: Array<{ p: number; v: number }> = [];
    const o = createScrollObserver({ onProgress: (p, info) => got.push({ p, v: info.velocity }) });
    o.update({ pos: 0, contentLength: 2000, viewportLength: 500, t: 0 });
    o.update({ pos: 750, contentLength: 2000, viewportLength: 500, t: 0.5 });
    expect(got[0].p).toBe(0);
    expect(got[1].p).toBeCloseTo(0.5);
    expect(got[1].v).toBeCloseTo(1500, 0); // 750px за 0.5s
  });

  it('target-режим: прогресс по офсетам + enter/leave', () => {
    const events: string[] = [];
    const ps: number[] = [];
    const o = createScrollObserver({
      offset: [
        { target: 'start', viewport: 'end' },
        { target: 'end', viewport: 'start' },
      ],
      onProgress: (p) => ps.push(p),
      onEnter: () => events.push('enter'),
      onLeave: () => events.push('leave'),
    });
    const upd = (pos: number, t: number) =>
      o.update({ pos, contentLength: 3000, viewportLength: 500, t, targetStart: 1000 - pos, targetSize: 300 });
    // targetStart передаётся в координатах ВЬЮПОРТА (как getBoundingClientRect().top)
    upd(0, 0);    // target на 1000 ниже верха вьюпорта → вне
    upd(900, 1);  // target на 100 → виден, прогресс (900-500)/(1300-500)=0.5
    expect(events).toEqual(['enter']);
    expect(ps[ps.length - 1]).toBeCloseTo(0.5);
    upd(1400, 2); // target на -400, size 300 → полностью выше → leave, прогресс 1
    expect(events).toEqual(['enter', 'leave']);
    expect(ps[ps.length - 1]).toBe(1);
  });

  it('axis — метрики любой оси приходят снаружи, наблюдателю всё равно (контракт)', () => {
    // Ось выбирает потребитель тем, ЧТО он передаёт в update — пин самого принципа.
    const ps: number[] = [];
    const o = createScrollObserver({ onProgress: (p) => ps.push(p) });
    o.update({ pos: 300, contentLength: 1100, viewportLength: 500, t: 0 }); // "горизонтальные" метрики
    expect(ps[0]).toBeCloseTo(0.5);
  });
});

// ─── scrubBinding ─────────────────────────────────────────────────────────────

describe('scroll/scrub: клей прогресс → seek', () => {
  function fakeTimeline() {
    const seeks: number[] = [];
    return { seeks, controls: { totalDuration: 4, seek: (t: number) => seeks.push(t) } };
  }

  it('маппит прогресс [0,1] в seek(t) по totalDuration', () => {
    const { seeks, controls } = fakeTimeline();
    const bind = scrubBinding(controls);
    bind(0);
    bind(0.5);
    bind(1);
    expect(seeks).toEqual([0, 2, 4]);
  });

  it('NaN/∞/за-пределами прогресс — клампится, seek всегда конечен', () => {
    const { seeks, controls } = fakeTimeline();
    const bind = scrubBinding(controls);
    bind(NaN);
    bind(Infinity);
    bind(-5);
    for (const t of seeks) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(4);
    }
  });
});

// ─── API surface pin (исчерпывающий, в обе стороны) ───────────────────────────

describe('scroll-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(scroll).sort()).toEqual([
      'createInView',
      'createScrollObserver',
      'createScrollVelocity',
      'resolveTargetProgress',
      'scrollProgress',
      'scrubBinding',
    ]);
  });

  it('формы контроллеров (исчерпывающе)', () => {
    expect(Object.keys(createInView()).sort()).toEqual(['inView', 'update']);
    expect(Object.keys(createScrollObserver()).sort()).toEqual(['update']);
    expect(Object.keys(createScrollVelocity()).sort()).toEqual(['push', 'reset', 'velocity']);
  });

  it('SSR: создание в node env не бросает (модуль без DOM)', () => {
    expect(() => {
      createInView();
      createScrollObserver();
      createScrollVelocity();
      scrollProgress(0, 100, 50);
      scrubBinding({ totalDuration: 1, seek: () => {} });
    }).not.toThrow();
  });
});
