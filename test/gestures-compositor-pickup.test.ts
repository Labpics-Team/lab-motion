/**
 * test/gestures-compositor-pickup.test.ts
 * Классы: Б (characterization) + А (contract/bite, вертикаль) + В (fuzz, seeded LCG).
 * Issue: #93 «единый C¹-контракт value+velocity», срез 5, строка матрицы
 * «compositor → gesture: захват пальцем в полёте».
 *
 * Зачем: элемент летит compositor-анимацией (WAAPI + linear(), ./compositor),
 * пользователь ловит его пальцем (drag pickup). Контракт: жест обязан подхватить
 * элемент с ЖИВОЙ скоростью compositor-рана, а не с нуля. Архитектура kernel'а:
 * субпути независимы — ./gestures НЕ импортирует ./compositor. Шов двумя
 * половинами:
 *   — чтение: readCompositorSpring (O(1) замкнутая форма, без DOM) отдаёт
 *     (value, velocity) рана в момент касания — эта половина существовала;
 *   — впрыск: createDrag(...).pointerDown(p, pickup) принимает внешний прайор
 *     скорости {vx, vy} и засевает его той же sliding-window механикой, что
 *     внутренний glide pickup (срез 2) — эта половина добавлена срезом 5.
 *
 * Рецепт потребителя (вертикаль ниже воспроизводит его один-в-один):
 *   pointerdown на летящем элементе →
 *     const read = readCompositorSpring(spring, { from, to, t: elapsedSec });
 *     controller.stop();                       // владение переходит жесту
 *     drag.pointerDown(point, { vx: read.velocity });
 *
 * ── RED PROOF (вневременно — факты падений на базе среза 4, 4 RED / 4 green) ─
 * pointerDown имел арность 1 и игнорировал второй аргумент: внешний прайор не
 * существовал, немедленный release после захвата давал скорость трекера {0,0}
 * и нулевой глайд. Фактические падения:
 *   - «вертикаль: …наследует живую скорость» — expected NaN to be greater
 *     than 0 (нулевой глайд осел первым кадром, glide[1] не существовал);
 *   - «C⁰+C¹: позиция продолжает ехать…» — expected 112.538577… to be
 *     greater than 132.538577… (d.x осел в точке захвата read.value);
 *   - «pickup по обеим осям» — expected 0 to be greater than 10;
 *   - «явный pickup {0,0} побеждает внутренний glide-прайор» — expected
 *     389.760113… to be less than 171.515688… (второй аргумент игнорировался,
 *     внутренний прайор глайда продолжал движение).
 * RED по правильной причине: отсутствие шва впрыска, не поломка трекера/декея.
 *
 * ── MUTATION PROOF (мутанты руками, каждый кусался, откачены) ────────────────
 *   [seed-loss]  pickup игнорируется (только внутренний глайд) → вертикаль RED
 *                (v_after = 0, глайд не стартует).
 *   [sign]       синтетический сэмпл вдоль +v (x + vx·Δt вместо x − vx·Δt) →
 *                «знак тот же» RED (унаследованная скорость зеркалится).
 *   [precedence] внутренний глайд-прайор побеждает явный pickup → тест
 *                «явный pickup {0,0} побеждает…» RED (объект продолжает ехать).
 *   [degenerate] снять Number.isFinite-гард у pickupV (NaN/∞ проходят в сид) →
 *                «вырожденный pickup → ровно 0» и fuzz-финитность RED.
 */

import { describe, expect, it } from 'vitest';
import { createDrag } from '../src/gestures/index.js';
import { CompositorSpring, readCompositorSpring } from '../src/compositor/index.js';
import type { SpringParams } from '../src/spring.js';

const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const FRAME_S = 0.016;

// ─── Виртуальный клок (конвенция repo: ts в мс, handle > 0) ────────────────────

function virtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return ++handle;
  };
  const pump = (ts: number): void => {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(ts);
  };
  return { requestFrame, pump, queue };
}

/** Фейк-Element (duck-typed, без jsdom): журнал .animate + spy-cancel. */
function fakeElement() {
  const animations: { cancelled: boolean; cancel(): void }[] = [];
  return {
    animations,
    el: {
      animate(_k: Record<string, string | number>[], _t: Record<string, unknown>) {
        const anim = {
          cancelled: false,
          cancel(): void {
            this.cancelled = true;
          },
        };
        animations.push(anim);
        return anim;
      },
    },
  };
}

// ─── Вертикаль: compositor-ран → аналитическое чтение → drag pickup → C¹ ──────

describe('gestures×compositor: захват пальцем в полёте (вертикаль #93, срез 5)', () => {
  /** Полная вертикаль рецепта; возвращает всё для ассертов. */
  function pickupVertical() {
    // 1. Compositor-ран 0 → 300 по фейк-элементу, часы инжектированы.
    let nowMs = 0;
    const fake = fakeElement();
    const cs = new CompositorSpring({
      spring: SPRING,
      property: 'transform',
      from: 0,
      to: 300,
      target: fake.el,
      now: () => nowMs,
      format: (v) => `translateX(${v}px)`,
    });
    cs.start();
    expect(cs.tier).toBe('compositor'); // ран действительно off-main-thread путь

    // 2. Палец касается на t* = 0.1s: аналитическое чтение (БЕЗ DOM).
    nowMs = 100;
    const read = readCompositorSpring(SPRING, { from: 0, to: 300, t: 0.1 });
    expect(read.velocity).toBeGreaterThan(100); // ран действительно живой

    // 3. Владение переходит жесту: compositor-Animation отменяется…
    cs.stop();
    expect(fake.animations[0]!.cancelled).toBe(true);

    // 4. …и drag подхватывает элемент с (value, velocity) рана.
    const clock = virtualClock();
    const glide: number[] = [];
    let inGlide = false;
    const d = createDrag({
      from: { x: read.value },
      requestFrame: clock.requestFrame,
      onStep: (x) => {
        if (inGlide) glide.push(x);
      },
    });
    d.pointerDown({ x: read.value, y: 0, t: 0.1 }, { vx: read.velocity });
    return { d, read, glide, clock, beginGlide: () => (inGlide = true) };
  }

  it('вертикаль: немедленный release после захвата наследует живую скорость рана (0.65–1.05·v̂, тот же знак)', () => {
    const { d, read, glide, clock, beginGlide } = pickupVertical();
    expect(d.x).toBe(read.value); // C⁰: позиция жеста = аналитическая позиция рана
    d.pointerUp({ x: read.value, y: 0, t: 0.101 });
    expect(d.gliding).toBe(true); // движение продолжилось, а не умерло

    beginGlide();
    clock.pump(0);
    clock.pump(16);
    const vAfter = (glide[1]! - glide[0]!) / FRAME_S;
    expect(vAfter).toBeGreaterThan(0); // тот же знак, что у рана
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(read.velocity)); // bite: наследование
    expect(Math.abs(vAfter)).toBeLessThan(1.05 * Math.abs(read.velocity)); // и не завышение
  });

  it('C⁰+C¹: позиция продолжает ехать вперёд от точки захвата (раньше замирала)', () => {
    const { d, read, clock } = pickupVertical();
    d.pointerUp({ x: read.value, y: 0, t: 0.101 });
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.gliding).toBe(false);
    expect(d.x).toBeGreaterThan(read.value + 20); // импульс пронёс дальше точки касания
    expect(Number.isFinite(d.x)).toBe(true);
  });

  it('удержание дольше окна трекера (0.1s) гасит прайор: объект остаётся в точке захвата', () => {
    const { d, read, clock } = pickupVertical();
    d.pointerUp({ x: read.value, y: 0, t: 0.5 }); // 400мс > окна 100мс
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBe(read.value); // прайор вытеснен из окна — скорость ровно 0
  });

  it('pickup по обеим осям: {vx, vy} наследуются покомпонентно', () => {
    const clock = virtualClock();
    const d = createDrag({ requestFrame: clock.requestFrame });
    d.pointerDown({ x: 0, y: 0, t: 0 }, { vx: 800, vy: -400 });
    d.pointerUp({ x: 0, y: 0, t: 0.001 });
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBeGreaterThan(10); // +vx унаследован
    expect(d.y).toBeLessThan(-5); // −vy унаследован
  });
});

// ─── Прайоритет и характеризация прежних путей ─────────────────────────────────

describe('gestures×compositor pickup: приоритет и прежние пути (класс Б)', () => {
  it('явный pickup {0,0} побеждает внутренний glide-прайор: потребитель сказал «покой» — объект стоит', () => {
    const clock = virtualClock();
    const d = createDrag({ requestFrame: clock.requestFrame });
    // Разгоняем внутренний глайд фликом.
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: 100, y: 0, t: 0.08 });
    let ts = 0;
    for (let i = 0; i < 6; i++) {
      clock.pump(ts);
      ts += 16;
    }
    expect(d.gliding).toBe(true);
    const grabX = d.x;
    // Явный прайор «покой» при живом глайде: внешний источник авторитетен.
    d.pointerDown({ x: grabX, y: 0, t: 1.0 }, { vx: 0, vy: 0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.001 });
    for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBeLessThan(grabX + 1e-9); // не продолжил движение глайда
    expect(d.x).toBe(grabX); // скорость ровно 0 → осел в точке захвата
  });

  it('без pickup поведение прежнее бит-в-бит: внутренний glide-прайор работает (пин среза 2)', () => {
    const run = (withUndefined: boolean): number => {
      const clock = virtualClock();
      const d = createDrag({ requestFrame: clock.requestFrame });
      d.pointerDown({ x: 0, y: 0, t: 0 });
      for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
      d.pointerUp({ x: 100, y: 0, t: 0.08 });
      let ts = 0;
      for (let i = 0; i < 6; i++) {
        clock.pump(ts);
        ts += 16;
      }
      if (withUndefined) d.pointerDown({ x: d.x, y: 0, t: 1.0 }, undefined);
      else d.pointerDown({ x: d.x, y: 0, t: 1.0 });
      d.pointerUp({ x: d.x, y: 0, t: 1.001 });
      for (; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
      return d.x;
    };
    const bare = run(false);
    expect(bare).toBeGreaterThan(100); // внутренний прайор жив (глайд продолжен)
    expect(run(true)).toBe(bare); // pickup: undefined ≡ отсутствию аргумента
  });

  it('вырожденный pickup (NaN/±∞/не-число) → ровно 0: нет прайора, объект стоит', () => {
    for (const evil of [NaN, Infinity, -Infinity]) {
      const clock = virtualClock();
      const d = createDrag({ requestFrame: clock.requestFrame });
      d.pointerDown({ x: 5, y: 5, t: 0 }, { vx: evil, vy: evil });
      d.pointerUp({ x: 5, y: 5, t: 0.001 });
      for (let ts = 0; ts <= 2000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false);
      expect(d.x + 0).toBe(0); // ровно 0 (from по умолчанию), не NaN/−0/∞
      expect(d.y + 0).toBe(0);
    }
  });
});

// ─── Fuzz (seeded LCG — домовой канон) ────────────────────────────────────────

describe('gestures×compositor pickup: fuzz злых прайоров (класс В)', () => {
  it('300 сценариев со злыми pickup: эмиссии конечны, глайд оседает, детерминизм', () => {
    let s = 0x5eed93aa;
    const rnd = () => {
      s = (Math.imul(1664525, s) + 1013904223) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, -0, 1e308];
    const pick = (): number => (rnd() < 0.3 ? evil[Math.floor(rnd() * evil.length)]! : (rnd() - 0.5) * 2e4);

    for (let run = 0; run < 300; run++) {
      const clock = virtualClock();
      const d = createDrag({
        requestFrame: clock.requestFrame,
        onStep: (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`non-finite эмиссия: (${x}, ${y}) на прогоне ${run}`);
          }
        },
      });
      d.pointerDown({ x: pick(), y: pick(), t: 0 }, { vx: pick(), vy: pick() });
      const moves = Math.floor(rnd() * 4);
      for (let i = 1; i <= moves; i++) d.pointerMove({ x: pick(), y: pick(), t: i * 0.016 });
      d.pointerUp({ x: pick(), y: pick(), t: 0.02 + rnd() * 0.3 });
      let ts = 0;
      for (; ts <= 40_000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false);
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
    }
  });
});
