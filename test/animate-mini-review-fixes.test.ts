/**
 * test/animate-mini-review-fixes.test.ts — регресс-пины находок ревью PR #134
 * (CodeRabbit + adversarial) для среза 1 ./animate/mini (#103).
 *
 * Каждый describe пинует ОДИН фикс; в докблоке — RED-факт (что краснеет на
 * до-фиксном коде). RED collective-proof: `git stash` src → эти пины краснеют
 * (кроме H, где до-фикса частичная запись под reduced) → `git stash pop`.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import { runAnimate } from '../src/animate/mini/engine.js';
import { animate } from '../src/animate/mini/index.js';
import { cssVarCodec, numberCodec } from '../src/animate/mini-codecs.js';
import { isTransformKey as isTransformKeyMini } from '../src/animate/mini-codecs.js';
import { isTransformKey as isTransformKeyFacade } from '../src/animate/channels.js';
import { createFullRegistry } from '../src/animate/full-codecs.js';
import { fakeEl, makeClock, type StyleWrite } from './animate-facade-helpers.js';

const RF = (clock: ReturnType<typeof makeClock>): { requestFrame: (cb: (ts?: number) => void) => number } => ({
  requestFrame: clock.requestFrame,
});

const lastVal = (writes: readonly StyleWrite[], prop: string): string | undefined =>
  writes.filter((w) => w.prop === prop).at(-1)?.value;

// ─── A. Явно-безюнитная цель CSS-переменной ──────────────────────────────────
// RED: `unit: to.unit || from.unit` оседает на '20px' (юнит источника побеждает).

describe('A — unit-интерполяция: явно-безюнитная цель побеждает', () => {
  it("'10px' → 20 заканчивается РОВНО числом 20 (не '20px')", () => {
    const from = cssVarCodec.parse('10px', '--v');
    const to = cssVarCodec.parse(20, '--v');
    const end = cssVarCodec.interpolate(from, to)(1);
    expect(end.unit).toBe(''); // юнит цели — пустой, не 'px'
    expect(cssVarCodec.serialize(end)).toBe(20); // число, а не строка '20px'
  });
});

// ─── B. Строгая числовая валидация numberCodec ───────────────────────────────
// RED: parseFloat('1rad')=1 тихо проходит → rotate(1deg).

describe('B — numberCodec: строгая полно-строчная числовая валидация', () => {
  it("'1rad' → бросок MotionParamError (не тихий обрез до 1)", () => {
    expect(() => numberCodec.parse('1rad', 'rotate')).toThrow(MotionParamError);
  });
  it("'12oops' → бросок MotionParamError", () => {
    expect(() => numberCodec.parse('12oops', 'x')).toThrow(MotionParamError);
  });
  it('валидные числовые строки по-прежнему проходят', () => {
    expect(numberCodec.parse('12', 'x')).toBe(12);
    expect(numberCodec.parse('-3.5', 'x')).toBe(-3.5);
    expect(numberCodec.parse('1e3', 'x')).toBe(1000);
    expect(numberCodec.parse(42, 'x')).toBe(42);
  });
  it('движок бросает fail-fast на rotate: "1rad" ДО записи', () => {
    const f = fakeEl();
    expect(() => animate(f.el, { rotate: '1rad' } as never)).toThrow(MotionParamError);
    expect(f.writes.length).toBe(0);
  });
});

// ─── C. isTransformKey — только собственные ключи ────────────────────────────
// RED: `key in TRANSFORM_IDENTITY` принимает унаследованные constructor/toString.

describe('C — isTransformKey не классифицирует унаследованные ключи', () => {
  for (const isTransformKey of [isTransformKeyMini, isTransformKeyFacade]) {
    it('constructor/toString/__proto__ — НЕ transform-каналы; x/scale — да', () => {
      expect(isTransformKey('constructor')).toBe(false);
      expect(isTransformKey('toString')).toBe(false);
      expect(isTransformKey('__proto__')).toBe(false);
      expect(isTransformKey('hasOwnProperty')).toBe(false);
      expect(isTransformKey('x')).toBe(true);
      expect(isTransformKey('scaleX')).toBe(true);
    });
  }
});

// ─── D. seek(Infinity) не бросает ────────────────────────────────────────────
// RED: `Number.isNaN(tMs)` пропускает Infinity → _compute(tMs/1000=∞) бросает.

describe('D — seek нефинитного времени — no-op, не бросок', () => {
  it('seek(Infinity)/(-Infinity)/(NaN) на SPRING-пути не бросают изнутри', () => {
    // Spring-режим (без duration): _compute зовёт readCompositorSpring(t=tMs/1000).
    // До-фикса `Number.isNaN` пропускал Infinity → readCompositorSpring(∞) бросает
    // «t должен быть конечным». Гард `!Number.isFinite` отсекает Infinity, как NaN.
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 100 }, RF(clock));
    expect(() => c.seek(Infinity)).not.toThrow();
    expect(() => c.seek(-Infinity)).not.toThrow();
    expect(() => c.seek(NaN)).not.toThrow();
    c.cancel();
  });
});

// ─── E. style-цель с полем length:0 — одна цель, не пустой список ─────────────
// RED: `_isArrayLike` трактует {length:0} как пустой список → тихий no-op.

describe('E — прямая adapter-цель с полем length:0 анимируется как ОДНА цель', () => {
  it('{ length: 0, style } не пропускается — реально анимируется', async () => {
    const inline = new Map<string, string>();
    const writes: StyleWrite[] = [];
    const target = {
      length: 0, // ловушка: выглядит как пустой array-like
      style: {
        setProperty(name: string, value: string): void {
          writes.push({ prop: name, value });
          inline.set(name, value);
        },
        getPropertyValue: (name: string): string => inline.get(name) ?? '',
      },
    };
    const clock = makeClock();
    const c = animate(target, { x: 100 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c.finished;
    expect(writes.length).toBeGreaterThan(0); // НЕ тихий no-op
    expect(lastVal(writes, 'transform')).toBe('translateX(100px)');
  });
});

// ─── F. scaleX поверх остаточного scale реально меняет рендер ─────────────────
// RED: residual `scale` выигрывает в _buildTransform → scaleX не виден.

describe('F — анимация scaleX поверх residual scale меняет рендер', () => {
  it('после scale:2 анимация scaleX:3 даёт scaleX(3) в строке (не scale(2))', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c1 = animate(f.el, { scale: 2 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c1.finished;
    expect(lastVal(f.writes, 'transform')).toBe('scale(2)');
    const c2 = animate(f.el, { scaleX: 3 }, { ...RF(clock), duration: 50 });
    clock.drain(16);
    await c2.finished;
    const last = lastVal(f.writes, 'transform')!;
    expect(last).toContain('scaleX(3)'); // осевой канал реально рендерится
    expect(last).not.toBe('scale(2)'); // старый uniform-scale не «съел» новый
  });
});

// ─── G. svgAttrAdapter.surfaceOf отклоняет не-SVG имена fail-fast ─────────────
// RED: surfaceOf=(p)=>p принимает scale/--foo → пишет scale="…"/--foo="…" (no-op).

describe('G — SVG-адаптер отклоняет transform-шортхенды и CSS-vars', () => {
  const fakeSvg = (): { el: Record<string, unknown> } => ({
    el: {
      namespaceURI: 'http://www.w3.org/2000/svg',
      setAttribute: () => {},
      getAttribute: () => null,
    },
  });
  it('scale на SVG-цели → MotionParamError (fail-fast, гейт surfaceOf)', () => {
    // Явная пара [1,2] исключает read-парс from → бросок ИМЕННО из surfaceOf.
    const s = fakeSvg();
    expect(() => runAnimate(createFullRegistry(), s.el, { scale: [1, 2] })).toThrow(MotionParamError);
  });
  it('--foo на SVG-цели → MotionParamError (fail-fast)', () => {
    const s = fakeSvg();
    expect(() => runAnimate(createFullRegistry(), s.el, { '--foo': [0, 1] })).toThrow(MotionParamError);
  });
  it('легитимный SVG-атрибут cx — проходит (не отклонён)', () => {
    const s = fakeSvg();
    expect(() => runAnimate(createFullRegistry(), s.el, { cx: [0, 10] })).not.toThrow();
  });
});

// ─── H. Preflight-план: бросок ПОЗЖЕ цели не оставляет частичную анимацию ─────
// RED: до-фикса ранняя reduced-цель уже записала финал ДО броска на bad-цели.

describe('H — [good, bad] бросает и НЕ оставляет частичную анимацию', () => {
  const reduce = (q: string): { matches: boolean } => ({ matches: q.includes('reduce') });
  it('под reduced good-цель НЕ тронута, если bad-цель невалидна', () => {
    const good = fakeEl();
    const bad = {}; // mini не знает адаптера для plain-object → resolveAdapter бросит
    expect(() =>
      animate([good.el, bad], { x: 100 }, { matchMedia: reduce }),
    ).toThrow(MotionParamError);
    // Preflight провалидировал ВЕСЬ план ДО инстанцирования: под reduced не было
    // ни одного синхронного финального write в good-цель.
    expect(good.writes.length).toBe(0);
  });
});
