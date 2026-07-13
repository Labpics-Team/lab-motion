/**
 * test/compositor-retarget.test.ts — контроллер CompositorSpring: ретаргет с
 * сохранением скорости (compositor-путь) + байт-паритетный fallback.
 * Классы: А (маппинг в Element.animate), В (байт-паритет fallback против компилятора),
 * Д (mutation-хуки ретаргета и выбора пути).
 *
 * ── RED PROOF (мутации) ───────────────────────────────────────────────────────
 * - Не отменять старую Animation при ретаргете → «cancel вызван» RED.
 * - Стартовать новый прогон с 0, а не с прочитанной позиции → «C⁰: from=read.value» RED.
 * - Не засеивать v0 (компилировать с v0=0) → «easing после ретаргета ≠ v0=0» RED.
 * - Fallback пишет clamp:true вместо честной пружины → байт-паритет RED (overshoot расходится).
 * - Выбор пути инвертирован → «нет .animate → fallback / есть → compositor» RED.
 *
 * SSR/детерминизм: конструктор не трогает DOM/часы; часы и фрейм-петля инжектируются.
 */

import { describe, expect, it } from 'vitest';
import {
  CompositorSpring,
  compileSpringLinear,
  readCompositorSpring,
  supportsCompositor,
} from '../src/compositor/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { sampleSerializedSpring } from '../src/compositor/sample.js';
import { FIXED_DT_S } from '../src/internal/constants.js';
import { MotionParamError } from '../src/index.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';

const STIFF: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const BOUNCY: SpringParams = { mass: 1, stiffness: 180, damping: 8 };

function executionSnapshot(
  physics: SpringParams,
  from: number,
  to: number,
  tMs: number,
): { value: number; velocity: number } {
  const artifact = compileSpringExecutionArtifactUnchecked(
    physics,
    0,
    DEFAULT_TOLERANCE,
  );
  const sample = sampleSerializedSpring(
    artifact.samples,
    settleTimeUpperBound(physics, 0) * 1000,
    tMs,
  );
  return {
    value: (1 - sample.value) * from + sample.value * to,
    velocity: sample.velocity * to - sample.velocity * from,
  };
}

// ─── Фейки (без DOM) ─────────────────────────────────────────────────────────

/** Фейк-Element: пишет вызовы .animate и раздаёт Animation со spy-cancel. */
function fakeElement() {
  const calls: { keyframes: Record<string, string | number>[]; timing: Record<string, unknown> }[] = [];
  const animations: { cancelled: boolean }[] = [];
  return {
    calls,
    animations,
    el: {
      animate(keyframes: Record<string, string | number>[], timing: Record<string, unknown>) {
        calls.push({ keyframes, timing });
        const anim = {
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
        };
        animations.push(anim);
        return anim;
      },
    },
  };
}

/** Синхронные дренируемые часы (как в scripts/bench.mjs): handle ненулевой →
 *  MotionValue не ставит setTimeout, прогон синхронен. */
function makeClock() {
  const queue: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length; // ненулевой handle
  };
  const drain = (cap = 100000): number => {
    let n = 0;
    while (queue.length > 0 && n < cap) {
      const cb = queue.shift()!;
      cb();
      n++;
    }
    return n;
  };
  return { requestFrame, drain };
}

// ─── Capability detection (SSR-safe) ─────────────────────────────────────────

describe('compositor: supportsCompositor', () => {
  it('node без цели → false (Element.prototype.animate нет)', () => {
    expect(supportsCompositor()).toBe(false);
  });

  it('цель с .animate → true; без — false', () => {
    expect(supportsCompositor({ animate: () => ({}) })).toBe(true);
    expect(supportsCompositor({})).toBe(false);
    expect(supportsCompositor(null)).toBe(false);
  });
});

// ─── Compositor-путь: выбор пути и коммит в animate ───────────────────────────

describe('compositor: CompositorSpring — compositor-путь', () => {
  it('цель с .animate → mode compositor; start() коммитит план в animate', () => {
    const f = fakeElement();
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.el,
      now: () => 1000,
    });
    expect(cs.mode).toBe('compositor');
    cs.start();
    expect(f.calls).toHaveLength(1);
    const { keyframes, timing } = f.calls[0]!;
    expect(keyframes).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 1, opacity: 1 },
    ]);
    expect(String(timing['easing']).startsWith('linear(')).toBe(true);
    expect(timing['fill']).toBe('both');
    expect(timing['composite']).toBe('replace');
    expect(timing['iterations']).toBe(1);
  });

  it('ретаргет в полёте: отменяет старую Animation и эмитит новую с прочитанной позиции (C⁰)', () => {
    const f = fakeElement();
    let nowMs = 1000;
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.el,
      now: () => nowMs,
    });
    cs.start();
    nowMs = 1100; // прошло 100 мс = 0.1 с
    cs.retarget(0.5);

    // Старая Animation отменена.
    expect(f.animations[0]!.cancelled).toBe(true);
    // Новая animate вызвана (всего 2).
    expect(f.calls).toHaveLength(2);
    const expected = executionSnapshot(STIFF, 0, 1, 100);
    // C⁰: новый прогон стартует с фактически видимой serialized-позиции.
    expect(f.calls[1]!.keyframes[0]!['opacity']).toBe(expected.value);
    expect(f.calls[1]!.keyframes[1]!['opacity']).toBe(0.5);
  });

  it('ретаргет засеивает скорость: easing НЕ равен кривой из покоя (C¹ инъекция)', () => {
    const f = fakeElement();
    let nowMs = 1000;
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      now: () => nowMs,
    });
    cs.start();
    nowMs = 1080; // 0.08 с — пружина ещё движется, скорость ≠ 0
    cs.retarget(200);
    const restEasing = compileSpringLinear(STIFF); // v0 = 0
    // Если бы скорость не засеивалась (v0=0), easing совпал бы с покоем.
    expect(f.calls[1]!.timing['easing']).not.toBe(restEasing);
  });

  it('скорость вне конечного grid-бюджета переходит в live без разрыва C1', () => {
    const f = fakeElement();
    const clock = makeClock();
    const values: number[] = [];
    let nowMs = 0;
    const cs = new CompositorSpring({
      spring: BOUNCY,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      apply: (value) => values.push(value as number),
      requestFrame: clock.requestFrame,
      now: () => nowMs,
    });
    cs.start();
    nowMs = 100;
    const snapshot = executionSnapshot(BOUNCY, 0, 100, 100);
    const target = snapshot.value + 1.01e-10;

    cs.retarget(target);

    expect(f.animations[0]!.cancelled).toBe(true);
    expect(f.calls).toHaveLength(1); // чрезмерная вторая WAAPI-кривая не строилась
    expect(cs.tier).toBe('compositor'); // capability среды не изменилась
    expect(cs.mode).toBe('fallback'); // текущий owner теперь live
    expect(values[0]).toBe(snapshot.value); // C0; MotionValue засеян тем же снимком
    clock.drain();
    expect(values.at(-1)).toBe(target);
  });

  it('ретаргет ровно в текущую позицию не теряет ненулевой импульс', () => {
    const f = fakeElement();
    const clock = makeClock();
    const values: number[] = [];
    let nowMs = 0;
    const cs = new CompositorSpring({
      spring: BOUNCY,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      apply: (value) => values.push(value as number),
      requestFrame: clock.requestFrame,
      now: () => nowMs,
    });
    cs.start();
    nowMs = 100;
    const snapshot = executionSnapshot(BOUNCY, 0, 100, 100);

    cs.retarget(snapshot.value);

    expect(f.calls).toHaveLength(1);
    expect(f.animations[0]!.cancelled).toBe(true);
    expect(values[0]).toBe(snapshot.value);
    clock.drain(1);
    const firstDelta = values.at(-1)! - snapshot.value;
    expect(Math.abs(firstDelta)).toBeGreaterThan(0);
    expect(Math.sign(firstDelta)).toBe(Math.sign(snapshot.velocity));
    clock.drain();
    expect(values.at(-1)).toBe(snapshot.value);
  });

  it('без apply чрезмерный ретаргет бросает ДО cancel и сохраняет старый прогон', () => {
    const f = fakeElement();
    let nowMs = 0;
    const cs = new CompositorSpring({
      spring: BOUNCY,
      property: 'x',
      from: 0,
      to: 100,
      target: f.el,
      now: () => nowMs,
    });
    cs.start();
    nowMs = 100;
    const snapshot = executionSnapshot(BOUNCY, 0, 100, 100);

    expect(() => cs.retarget(snapshot.value + 1.01e-10)).toThrow(MotionParamError);
    expect(f.animations[0]!.cancelled).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(cs.mode).toBe('compositor');
  });

  it('ретаргет ДО старта → просто задаёт цель и стартует (один animate)', () => {
    const f = fakeElement();
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'opacity',
      from: 0,
      to: 1,
      target: f.el,
      now: () => 0,
    });
    cs.retarget(0.7);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.keyframes[1]!['opacity']).toBe(0.7);
  });

  it('stop() отменяет активную Animation', () => {
    const f = fakeElement();
    const cs = new CompositorSpring({ spring: STIFF, property: 'o', from: 0, to: 1, target: f.el, now: () => 0 });
    cs.start();
    cs.stop();
    expect(f.animations[0]!.cancelled).toBe(true);
  });

  it('hostile cancel-getter не роняет stop и старый owner очищается', () => {
    let reads = 0;
    const target = {
      animate() {
        return Object.defineProperty({}, 'cancel', {
          get() {
            reads++;
            throw new Error('hostile cancel getter');
          },
        });
      },
    };
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'opacity',
      from: 0,
      to: 1,
      target,
    });
    cs.start();

    expect(() => cs.stop()).not.toThrow();
    expect(reads).toBe(1);
    // Повторный stop не должен снова читать getter уже снятого owner.
    expect(() => cs.stop()).not.toThrow();
    expect(reads).toBe(1);
  });

  it('hostile cancel-call не роняет stop и старый owner очищается', () => {
    let calls = 0;
    const target = {
      animate() {
        return {
          cancel() {
            calls++;
            throw new Error('hostile cancel call');
          },
        };
      },
    };
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'opacity',
      from: 0,
      to: 1,
      target,
    });
    cs.start();

    expect(() => cs.stop()).not.toThrow();
    expect(calls).toBe(1);
    expect(() => cs.stop()).not.toThrow();
    expect(calls).toBe(1);
  });

  it('format прокидывается в кейфреймы', () => {
    const f = fakeElement();
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'transform',
      from: 0,
      to: 240,
      target: f.el,
      format: (v) => `translateX(${v}px)`,
      now: () => 0,
    });
    cs.start();
    expect(f.calls[0]!.keyframes[0]!['transform']).toBe('translateX(0px)');
    expect(f.calls[0]!.keyframes[1]!['transform']).toBe('translateX(240px)');
  });
});

// ─── Fallback-путь: байт-паритет с компилятором ──────────────────────────────

describe('compositor: CompositorSpring — fallback (WAAPI недоступен)', () => {
  it('нет цели → mode fallback', () => {
    const cs = new CompositorSpring({ spring: STIFF, property: 'o', from: 0, to: 1 });
    expect(cs.mode).toBe('fallback');
  });

  it('цель без .animate → fallback', () => {
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'o',
      from: 0,
      to: 1,
      target: {} as never,
    });
    expect(cs.mode).toBe('fallback');
  });

  for (const [name, params] of [
    ['stiff', STIFF],
    ['bouncy', BOUNCY],
  ] as const) {
    it(`байт-паритет (${name}): значения fallback ≡ семплы компилятора в узлах времени`, () => {
      const clock = makeClock();
      const collected: number[] = [];
      const from = 0;
      const to = 100;
      const cs = new CompositorSpring({
        spring: params,
        property: 'x',
        from,
        to,
        apply: (v) => collected.push(v as number),
        requestFrame: clock.requestFrame,
      });
      expect(cs.mode).toBe('fallback');
      cs.start();
      clock.drain();

      // Эмит k соответствует НАКОПЛЕННОМУ времени (MotionValue делает _elapsed +=
      // FIXED_DT_S на кадр — накопление, НЕ умножение k·dt, которое разошлось бы на
      // ULP при больших k). Реплицируем накопление тем же порядком → fallback и
      // компилятор читают ОДИН solveSpring в ТОТ ЖЕ момент → бит-в-бит (толеранс 0).
      expect(collected.length).toBeGreaterThan(3);
      let elapsed = 0;
      for (let k = 0; k < collected.length - 1; k++) {
        const truth = readCompositorSpring(params, { from, to, v0: 0, t: elapsed }).value;
        expect(collected[k]).toBe(truth); // толеранс 0 (общая закрытая форма, тот же t)
        elapsed += FIXED_DT_S;
      }
      // Терминальный снап — ровно цель.
      expect(collected[collected.length - 1]).toBe(to);
    });
  }

  it('fallback-ретаргет (smooth pickup) сходится к новой цели без NaN', () => {
    const clock = makeClock();
    const collected: number[] = [];
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 100,
      apply: (v) => collected.push(v as number),
      requestFrame: clock.requestFrame,
    });
    cs.start();
    clock.drain(10); // несколько кадров в полёте
    cs.retarget(300);
    clock.drain();
    for (const v of collected) expect(Number.isFinite(v)).toBe(true);
    expect(collected[collected.length - 1]).toBe(300); // сошлась к новой цели
  });

  it('destroy() безопасен на обоих путях', () => {
    const clock = makeClock();
    const cs = new CompositorSpring({
      spring: STIFF,
      property: 'x',
      from: 0,
      to: 1,
      apply: () => {},
      requestFrame: clock.requestFrame,
    });
    cs.start();
    expect(() => cs.destroy()).not.toThrow();
    // После destroy повторные вызовы — no-op, не бросают.
    expect(() => cs.retarget(0.5)).not.toThrow();
    expect(() => cs.start()).not.toThrow();
  });
});

// ─── Валидация конструктора ──────────────────────────────────────────────────

describe('compositor: CompositorSpring — валидация', () => {
  it('невалидные параметры → MotionParamError рано', () => {
    expect(() => new CompositorSpring({ spring: { mass: -1, stiffness: 1, damping: 1 }, property: 'o', from: 0, to: 1 })).toThrow(MotionParamError);
    expect(() => new CompositorSpring({ spring: STIFF, property: '', from: 0, to: 1 })).toThrow(MotionParamError);
    expect(() => new CompositorSpring({ spring: STIFF, property: 'o', from: NaN, to: 1 })).toThrow(MotionParamError);
    expect(() => new CompositorSpring({ spring: STIFF, property: 'o', from: 0, to: 1, tolerance: 0 })).toThrow(MotionParamError);
  });

  it('retarget с не-конечной целью → MotionParamError', () => {
    const cs = new CompositorSpring({ spring: STIFF, property: 'o', from: 0, to: 1, apply: () => {} });
    expect(() => cs.retarget(NaN)).toThrow(MotionParamError);
  });
});
