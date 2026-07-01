/**
 * test/gestures-hover-pan.test.ts
 * Классы: А (state machine) + В (fuzz finiteness).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падает каждый поведенческий блок.
 * Mutation-proof: убрать touch-фильтр hover → тест «touch игнорируется» RED;
 * убрать axis-lock в pan → тест «axis='x' обнуляет dy» RED.
 */

import { describe, expect, it } from 'vitest';
import { createHover, createPan } from '../src/gestures/index.js';

// ─── createHover ──────────────────────────────────────────────────────────────

describe('gestures/hover', () => {
  it('enter → onHoverStart; leave → onHoverEnd', () => {
    const log: string[] = [];
    const h = createHover({
      onHoverStart: () => log.push('start'),
      onHoverEnd: () => log.push('end'),
    });
    h.enter('mouse');
    h.leave();
    expect(log).toEqual(['start', 'end']);
  });

  it('эмулированный touch-hover игнорируется (паритет Motion)', () => {
    const log: string[] = [];
    const h = createHover({ onHoverStart: () => log.push('start') });
    h.enter('touch');
    expect(log).toEqual([]);
    expect(h.hovering).toBe(false);
  });

  it('leave без enter — no-op; повторный enter не дублирует start', () => {
    const log: string[] = [];
    const h = createHover({
      onHoverStart: () => log.push('start'),
      onHoverEnd: () => log.push('end'),
    });
    h.leave();
    h.enter('mouse');
    h.enter('mouse');
    expect(log).toEqual(['start']);
  });

  it('pointerType по умолчанию (undefined) считается mouse-подобным', () => {
    const h = createHover();
    h.enter();
    expect(h.hovering).toBe(true);
  });
});

// ─── createPan ────────────────────────────────────────────────────────────────

interface PanEvt { dx: number; dy: number; vx: number; vy: number }

function panLog() {
  const events: { kind: string; e?: PanEvt }[] = [];
  return {
    events,
    opts: {
      onPanStart: () => events.push({ kind: 'start' }),
      onPan: (e: PanEvt) => events.push({ kind: 'pan', e }),
      onPanEnd: (e: PanEvt) => events.push({ kind: 'end', e }),
    },
  };
}

describe('gestures/pan: порог и события', () => {
  it('движение меньше порога (3px) не начинает pan', () => {
    const { events, opts } = panLog();
    const p = createPan(opts);
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 2, y: 0, t: 0.01 });
    p.pointerUp({ x: 2, y: 0, t: 0.02 });
    expect(events).toEqual([]);
    expect(p.panning).toBe(false);
  });

  it('пересечение порога → panStart + pan; смещения от ТОЧКИ DOWN', () => {
    const { events, opts } = panLog();
    const p = createPan(opts);
    p.pointerDown({ x: 100, y: 100, t: 0 });
    p.pointerMove({ x: 110, y: 100, t: 0.05 });
    expect(events[0]).toEqual({ kind: 'start' });
    expect(events[1].kind).toBe('pan');
    expect(events[1].e!.dx).toBeCloseTo(10);
    expect(events[1].e!.dy).toBeCloseTo(0);
  });

  it('panEnd несёт скорость отпускания', () => {
    const { events, opts } = panLog();
    const p = createPan(opts);
    p.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 10; i++) p.pointerMove({ x: i * 10, y: 0, t: i * 0.01 });
    p.pointerUp({ x: 100, y: 0, t: 0.1 });
    const end = events[events.length - 1];
    expect(end.kind).toBe('end');
    expect(end.e!.vx).toBeGreaterThan(500); // ~1000 px/s
    expect(Number.isFinite(end.e!.vy)).toBe(true);
  });

  it('pointerCancel во время pan → panEnd с нулевой скоростью', () => {
    const { events, opts } = panLog();
    const p = createPan(opts);
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 50, y: 0, t: 0.05 });
    p.pointerCancel();
    const end = events[events.length - 1];
    expect(end.kind).toBe('end');
    expect(end.e!.vx).toBe(0);
    expect(p.panning).toBe(false);
  });

  it('axis="x" → dy в событиях всегда 0, порог меряется по |dx|', () => {
    const { events, opts } = panLog();
    const p = createPan({ ...opts, axis: 'x' });
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 0, y: 50, t: 0.01 }); // большой dy — porог по оси x НЕ пересечён
    expect(events).toEqual([]);
    p.pointerMove({ x: 10, y: 60, t: 0.02 });
    const pan = events.find((e) => e.kind === 'pan');
    expect(pan!.e!.dx).toBeCloseTo(10);
    expect(pan!.e!.dy).toBe(0);
  });

  it('axis="y" симметрично', () => {
    const { events, opts } = panLog();
    const p = createPan({ ...opts, axis: 'y' });
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 50, y: 10, t: 0.02 });
    const pan = events.find((e) => e.kind === 'pan');
    expect(pan!.e!.dy).toBeCloseTo(10);
    expect(pan!.e!.dx).toBe(0);
  });

  // Класс В: злые координаты не рождают NaN/∞ в событиях.
  it('fuzz: overflow-края координат → все поля событий конечны', () => {
    let s = 777;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE];
    for (let run = 0; run < 500; run++) {
      const fields: number[] = [];
      const p = createPan({
        onPan: (e) => fields.push(e.dx, e.dy, e.vx, e.vy),
        onPanEnd: (e) => fields.push(e.dx, e.dy, e.vx, e.vy),
      });
      const pick = (): number => (rnd() < 0.35 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e6);
      p.pointerDown({ x: pick(), y: pick(), t: 0 });
      for (let i = 1; i <= 3; i++) p.pointerMove({ x: pick(), y: pick(), t: i * 0.01 });
      p.pointerUp({ x: pick(), y: pick(), t: 0.05 });
      for (const f of fields) expect(Number.isFinite(f)).toBe(true);
    }
  });
});
