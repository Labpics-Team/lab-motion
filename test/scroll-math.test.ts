/**
 * test/scroll-math.test.ts — чистая математика ./scroll.
 * Классы: А (unit по границам) + В (fuzz finiteness) + Д (mutation-proof в комментариях).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
 * Mutation-proof: убрать guard нулевого диапазона в scrollProgress → тест
 * «нескроллируемый контент» ловит -0 (Object.is(-0,0)=false у toBe);
 * поменять анкер 'center' на 'start' в resolveAnchor → незажатый
 * center-прогресс (0.625) в тесте ниже расходится → RED.
 */

import { describe, expect, it } from 'vitest';
import { scrollProgress, resolveTargetProgress, createScrollVelocity } from '../src/scroll/index.js';

// ─── scrollProgress ───────────────────────────────────────────────────────────

describe('scroll/math: scrollProgress (страница/контейнер)', () => {
  it('pos=0 → 0; середина → 0.5; конец → 1', () => {
    // content 2000, viewport 500 → скроллируемый диапазон 1500
    expect(scrollProgress(0, 2000, 500)).toBe(0);
    expect(scrollProgress(750, 2000, 500)).toBeCloseTo(0.5);
    expect(scrollProgress(1500, 2000, 500)).toBe(1);
  });

  it('за пределами диапазона — clamp в [0,1] (overscroll/bounce)', () => {
    expect(scrollProgress(-50, 2000, 500)).toBe(0);
    expect(scrollProgress(99999, 2000, 500)).toBe(1);
  });

  it('нескроллируемый контент (content <= viewport) → 0 (паритет Motion)', () => {
    expect(scrollProgress(0, 400, 500)).toBe(0);
    expect(scrollProgress(0, 500, 500)).toBe(0);
  });

  it('fuzz: злые входы → всегда конечный [0,1]', () => {
    let s = 999;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 0, -0];
    const pick = (): number => (rnd() < 0.4 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e6);
    for (let i = 0; i < 3000; i++) {
      const p = scrollProgress(pick(), pick(), pick());
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

// ─── resolveTargetProgress (offset-пересечения, паритет Motion) ───────────────

describe('scroll/math: resolveTargetProgress — офсеты target/viewport', () => {
  // Сцена: viewport 500px; target: start=1000, size=300 (внутри контента 3000).
  const metrics = (pos: number) => ({ pos, contentLength: 3000, viewportLength: 500 });
  const target = { start: 1000, size: 300 };

  it("['start','end']→['end','start']: 0 когда target входит снизу, 1 когда вышел сверху", () => {
    // 'start end': верх target у нижнего края viewport → pos = 1000 - 500 = 500
    // 'end start': низ target у верхнего края viewport → pos = 1300
    const offsets = [
      { target: 'start', viewport: 'end' },
      { target: 'end', viewport: 'start' },
    ] as const;
    expect(resolveTargetProgress(metrics(500), target, offsets)).toBe(0);
    expect(resolveTargetProgress(metrics(900), target, offsets)).toBeCloseTo(0.5);
    expect(resolveTargetProgress(metrics(1300), target, offsets)).toBe(1);
  });

  it("['center','center']: 0.5-прогресс когда центры совпали… это единственная точка → прогресс 0/1 вокруг неё", () => {
    // центр target (1150) у центра viewport (pos+250): pos = 900.
    const offsets = [
      { target: 'center', viewport: 'center' },
      { target: 'end', viewport: 'start' },
    ] as const;
    expect(resolveTargetProgress(metrics(900), target, offsets)).toBe(0);
    expect(resolveTargetProgress(metrics(1300), target, offsets)).toBe(1);
  });

  it("'center' даёт НЕзажатый прогресс между краями (пин против мутации center→start)", () => {
    // Диапазон ['start end','end start'] = [500,1300]. Центр target (1150)
    // у центра viewport (pos+250) → pos=900... нам нужна точка ВНУТРИ (0,1):
    // прогресс при pos=1000 = (1000-500)/800 = 0.625 — а вот сам center-анкер
    // пиним диапазоном ['center center','end start'] = [900,1300]:
    const offsets = [
      { target: 'center', viewport: 'center' },
      { target: 'end', viewport: 'start' },
    ] as const;
    // При pos=1000: (1000-900)/400 = 0.25 — незажатое значение, чувствительное
    // к формуле center (мутация center→start сдвинула бы обе границы и итог).
    expect(resolveTargetProgress(metrics(1000), target, offsets)).toBeCloseTo(0.25);
  });

  it('числовые анкеры: доля 0..1 и px', () => {
    // target 0.5 (середина=1150) у viewport '100px' (pos+100): pos = 1050
    const offsets = [
      { target: 0.5, viewport: '100px' },
      { target: 'end', viewport: 'start' },
    ] as const;
    expect(resolveTargetProgress(metrics(1050), target, offsets)).toBe(0);
  });

  it('вырожденный диапазон (обе пары дают одну позицию) → 0 до, 1 после (без NaN)', () => {
    const offsets = [
      { target: 'start', viewport: 'start' },
      { target: 'start', viewport: 'start' },
    ] as const;
    const before = resolveTargetProgress(metrics(999), target, offsets);
    const after = resolveTargetProgress(metrics(1001), target, offsets);
    expect(before).toBe(0);
    expect(after).toBe(1);
  });

  it('fuzz: злые target/offsets → всегда конечный [0,1]', () => {
    let s = 4242;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE];
    const pick = (): number => (rnd() < 0.35 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e5);
    const anchors = ['start', 'center', 'end', 0.25, '50px', pick()] as const;
    for (let i = 0; i < 2000; i++) {
      const p = resolveTargetProgress(
        { pos: pick(), contentLength: pick(), viewportLength: pick() },
        { start: pick(), size: pick() },
        [
          { target: anchors[Math.floor(rnd() * 6)], viewport: anchors[Math.floor(rnd() * 6)] },
          { target: anchors[Math.floor(rnd() * 6)], viewport: anchors[Math.floor(rnd() * 6)] },
        ],
      );
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

// ─── createScrollVelocity ─────────────────────────────────────────────────────

describe('scroll/math: createScrollVelocity (1D)', () => {
  it('равномерный скролл 1000px/s', () => {
    const v = createScrollVelocity();
    for (let i = 0; i <= 10; i++) v.push({ pos: i * 10, t: i * 0.01 });
    expect(v.velocity()).toBeCloseTo(1000, 0);
  });

  it('идентичные timestamps → 0, не NaN; reset обнуляет', () => {
    const v = createScrollVelocity();
    v.push({ pos: 0, t: 1 });
    v.push({ pos: 500, t: 1 });
    expect(Number.isFinite(v.velocity())).toBe(true);
    v.reset();
    expect(v.velocity()).toBe(0);
  });
});
