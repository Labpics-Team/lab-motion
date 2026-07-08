/**
 * test/compositor-stagger.test.ts — composited stagger (M3): каскад на компоьзиторе.
 * Классы: А (известные расписания/числа), contract (детерминизм плана, общая
 * кривая), В (финитность/негативные контроли), Д (mutation-хуки в delay-aware
 * снимке и per-group/per-element границе).
 *
 * ── RED PROOF ──
 * - Убрать вычитание _startDelay в _snapshot → «retarget в delay-окне стартует с from» RED.
 * - Не прокидывать delays[i] в CompositorSpring → «per-element delay» RED.
 * - Скомпилировать пружину на элемент (не общий кэш) → «общая кривая» остаётся зелёной
 *   (значения равны), но детерминизм-пин ловит любой сдвиг linear().
 * - Пере-stagger'ить retargetAll → «retargetAll одновременный (delay не переигран)» RED.
 * - Снять валидацию count/index → негативные контроли RED.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  compileStaggerPlan,
  CompositorStaggerGroup,
  compileSpringLinear,
  readCompositorSpring,
  type SetTimerFn,
} from '../src/compositor/index.js';
import { stagger } from '../src/stagger/index.js';
import { MotionParamError } from '../src/errors.js';
import { type SpringParams } from '../src/spring.js';
import { easeOut } from '../src/easing/index.js';

const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

/** Фейк-Element, ЗАПИСЫВАЮЩИЙ каждый вызов animate (keyframes + timing). */
function recordingEl(): {
  calls: { keyframes: Record<string, string | number>[]; timing: Record<string, unknown> }[];
  animate(kf: Record<string, string | number>[], t: object): { cancel(): void };
} {
  const calls: { keyframes: Record<string, string | number>[]; timing: Record<string, unknown> }[] = [];
  return {
    calls,
    animate(kf, t) {
      calls.push({ keyframes: kf, timing: t as Record<string, unknown> });
      return { cancel(): void {} };
    },
  };
}

/** Ручной таймер: захватывает (cb, ms); flush прогоняет незанятые. */
function manualTimers(): {
  setTimer: SetTimerFn;
  scheduled: { ms: number; cancelled: boolean }[];
  flush(): void;
} {
  const scheduled: { ms: number; cancelled: boolean; cb: () => void }[] = [];
  const setTimer: SetTimerFn = (cb, ms) => {
    const e = { ms, cancelled: false, cb };
    scheduled.push(e);
    return () => {
      e.cancelled = true;
    };
  };
  return {
    setTimer,
    scheduled,
    flush(): void {
      for (const e of scheduled) if (!e.cancelled) e.cb();
    },
  };
}

/** Не-копящий requestFrame (handle≠0 → без setTimeout-шима), кадры не пампим. */
const inertRF = (): number => 1;

// ─── compileStaggerPlan: чистый планировщик ──────────────────────────────────

describe('compositor stagger: compileStaggerPlan — чистый план', () => {
  it('детерминизм: две компиляции бит-в-бит равны (easing + delays)', () => {
    const a = compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 5, gap: 40 });
    const b = compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 5, gap: 40 });
    expect(a.easing).toBe(b.easing);
    expect(a.delays).toEqual(b.delays);
    expect(a.keyframes).toEqual(b.keyframes);
  });

  it('per-element задержки === headless ./stagger (тот же контракт)', () => {
    const plan = compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 5, gap: 40 });
    expect(plan.delays).toEqual(stagger(5, { gap: 40 }));
    expect(plan.delays).toEqual([0, 40, 80, 120, 160]);
    expect(plan.count).toBe(5);
  });

  it('общая кривая = compileSpringLinear (одна компиляция на группу)', () => {
    const plan = compileStaggerPlan({ spring: SPRING, property: 'transform', from: 0, to: 100, count: 8 });
    expect(plan.easing).toBe(compileSpringLinear(SPRING));
    expect(plan.easing.startsWith('linear(')).toBe(true);
    // Кейфреймы — два узла [from,to], вся кривая в easing.
    expect(plan.keyframes).toHaveLength(2);
  });

  it('распределение staggerFrom/easing/grid проксируется в ./stagger', () => {
    const plan = compileStaggerPlan({
      spring: SPRING, property: 'opacity', from: 0, to: 1, count: 5,
      gap: 40, staggerFrom: 'center', staggerEasing: easeOut,
    });
    expect(plan.delays).toEqual(stagger(5, { gap: 40, from: 'center', easing: easeOut }));
  });

  it('reduced-motion CHARACTER-switch: все задержки → 0 (элементы всё равно анимируются)', () => {
    const plan = compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 5, gap: 40, reducedMotion: true });
    expect(plan.delays).toEqual([0, 0, 0, 0, 0]);
    // Кривая пружины ЕСТЬ — анимация не отменена, только каскад схлопнут.
    expect(plan.easing.startsWith('linear(')).toBe(true);
  });

  it('count=0 → пустые задержки; count=1 → [0]', () => {
    expect(compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 0 }).delays).toEqual([]);
    expect(compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 1 }).delays).toEqual([0]);
  });

  it('негативные контроли: count не целое/отрицательное, невалидная пружина → MotionParamError', () => {
    expect(() => compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: -1 })).toThrow(MotionParamError);
    expect(() => compileStaggerPlan({ spring: SPRING, property: 'opacity', from: 0, to: 1, count: 2.5 })).toThrow(MotionParamError);
    expect(() => compileStaggerPlan({ spring: { mass: -1, stiffness: 1, damping: 1 }, property: 'opacity', from: 0, to: 1, count: 3 })).toThrow(MotionParamError);
    expect(() => compileStaggerPlan({ spring: SPRING, property: '', from: 0, to: 1, count: 3 })).toThrow(MotionParamError);
  });
});

// ─── CompositorStaggerGroup: compositor-путь (каскад на компоьзиторе) ─────────

describe('compositor stagger: группа compositor-путь', () => {
  it('start() планирует N нативных Element.animate; delay нативен per-element', () => {
    const els = [recordingEl(), recordingEl(), recordingEl(), recordingEl(), recordingEl()];
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'opacity', from: 0, to: 1, targets: els, gap: 40 });
    expect(g.mode).toBe('compositor');
    expect(g.count).toBe(5);
    expect(g.delays).toEqual([0, 40, 80, 120, 160]);
    g.start();
    for (let i = 0; i < els.length; i++) {
      expect(els[i]!.calls).toHaveLength(1);
      const timing = els[i]!.calls[0]!.timing;
      if (g.delays[i]! > 0) {
        expect(timing['delay']).toBe(g.delays[i]);
      } else {
        // delay=0 → ключ delay НЕ добавляется (нативный дефолт WAAPI = 0).
        expect(timing['delay']).toBeUndefined();
      }
    }
  });

  it('ВСЕ элементы делят ОДНУ linear()-кривую (общий кэш)', () => {
    const els = [recordingEl(), recordingEl(), recordingEl()];
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'transform', from: 0, to: 240, targets: els });
    g.start();
    const easings = els.map((e) => e.calls[0]!.timing['easing']);
    expect(new Set(easings).size).toBe(1); // одна строка на всех
    expect(easings[0]).toBe(compileSpringLinear(SPRING));
  });

  it('per-group каскад vs per-element retarget: retarget(i) пере-эмитит ТОЛЬКО элемент i', () => {
    let now = 1000;
    const els = [recordingEl(), recordingEl(), recordingEl()];
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'x', from: 0, to: 100, targets: els, gap: 40, now: () => now,
    });
    g.start();
    now += 200; // после delay всех
    g.retarget(1, 300);
    expect(els[0]!.calls).toHaveLength(1); // не тронут
    expect(els[1]!.calls).toHaveLength(2); // пере-эмитирован
    expect(els[2]!.calls).toHaveLength(1); // не тронут
  });

  it('delay-aware C⁰: retarget В ОКНЕ задержки стартует с from (снимок учитывает _startDelay)', () => {
    let now = 1000;
    const el = recordingEl();
    // Один элемент с задержкой 100 мс (staggerFrom='last' → элемент 0 из 2 получит max delay).
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'x', from: 0, to: 100, targets: [el, recordingEl()],
      gap: 100, staggerFrom: 'last', now: () => now,
    });
    // Элемент 0 стартует последним: delay = 100.
    expect(g.delays[0]).toBe(100);
    g.start();
    now += 50; // 50 мс — ВНУТРИ окна задержки 100 мс: пружина ещё не тронулась.
    g.retarget(0, 300);
    // Пере-эмиссия: первый кейфрейм = from (0), т.к. в delay-окне value=from (C⁰).
    // Без учёта _startDelay снимок прочитал бы пружину на t=50мс>0 → значение ≠ 0.
    expect(el.calls[1]!.keyframes[0]!['x']).toBe(0);
  });

  it('delay-aware ПОСЛЕ окна: снимок читает пружину в правильный физический t (числовой пин)', () => {
    let now = 1000;
    const el = recordingEl();
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'x', from: 0, to: 100, targets: [el, recordingEl()],
      gap: 100, staggerFrom: 'last', now: () => now,
    });
    expect(g.delays[0]).toBe(100); // элемент 0 стартует последним (delay=100)
    g.start();
    const elapsedPastDelay = 0.05; // 50 мс ПОСЛЕ окна задержки 100 мс
    now += 100 + elapsedPastDelay * 1000; // wall = delay + физическое время пружины
    g.retarget(0, 300);
    // Ожидаемое from пере-эмиссии = пружина в t=0.05с (физическое время ПОСЛЕ делея,
    // НЕ wall-время 0.15с). Числовой пин против ошибки вычитания/знака _startDelay.
    const expected = readCompositorSpring(SPRING, { from: 0, to: 100, v0: 0, t: elapsedPastDelay }).value;
    expect(el.calls[1]!.keyframes[0]!['x']).toBeCloseTo(expected, 9);
    expect(expected).toBeGreaterThan(0); // реально уехала (граница не вырождена)
  });

  it('retargetAll: fan-out во ВСЕ элементы, одновременно (каскад НЕ переигран)', () => {
    let now = 1000;
    const els = [recordingEl(), recordingEl(), recordingEl()];
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'x', from: 0, to: 100, targets: els, gap: 40, now: () => now,
    });
    g.start();
    now += 300;
    g.retargetAll(500);
    // Каждый пере-эмитирован ровно раз (2 вызова), БЕЗ нового delay (одновременно).
    for (const el of els) {
      expect(el.calls).toHaveLength(2);
      expect(el.calls[1]!.timing['delay']).toBeUndefined(); // ретаргет = «сейчас», не каскад
    }
  });

  it('handoffToLive(i): per-element хендофф в живую MotionValue', () => {
    let now = 1000;
    const els = [recordingEl(), recordingEl()];
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'x', from: 0, to: 100, targets: els,
      now: () => now, requestFrame: inertRF,
    });
    g.start();
    now += 100;
    const mv = g.handoffToLive(0);
    expect(typeof mv.setTarget).toBe('function'); // живой контроллер
    expect(Number.isFinite(mv.value)).toBe(true);
    mv.destroy();
  });

  it('negative controls: retarget/handoff вне диапазона индекса → MotionParamError', () => {
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'x', from: 0, to: 100, targets: [recordingEl()] });
    expect(() => g.retarget(5, 10)).toThrow(MotionParamError);
    expect(() => g.retarget(-1, 10)).toThrow(MotionParamError);
    expect(() => g.handoffToLive(5)).toThrow(MotionParamError);
  });

  it('valueAt: конечное значение живого индекса; NaN за диапазоном', () => {
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'x', from: 7, to: 100, targets: [recordingEl()] });
    expect(g.valueAt(0)).toBe(7); // до старта = from
    expect(Number.isNaN(g.valueAt(9))).toBe(true);
  });

  it('stop()/destroy() чистят: повторный вызов идемпотентен, не бросает', () => {
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'x', from: 0, to: 100, targets: [recordingEl(), recordingEl()] });
    g.start();
    expect(() => { g.stop(); g.stop(); g.destroy(); g.destroy(); }).not.toThrow();
    // После destroy start()/retarget — no-op (не бросают).
    expect(() => { g.start(); g.retargetAll(1); }).not.toThrow();
  });

  it('handoffToLive после destroy() → ИНЕРТНАЯ MotionValue (нет зомби rAF-петли)', () => {
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'x', from: 5, to: 100, targets: [recordingEl()], requestFrame: inertRF });
    g.start();
    g.destroy();
    const mv = g.handoffToLive(0); // не должен поднять новую live-петлю на мёртвом элементе
    expect(typeof mv.setTarget).toBe('function');
    const before = mv.value;
    mv.setTarget(999); // на уничтоженной MotionValue — no-op
    expect(mv.value).toBe(before); // значение НЕ поехало → петля не стартовала (инертна)
  });

  it('handoffToLive после destroy(): _destroyed-гард согласован с соседями (requestFrame НЕ зван; out-of-range — no-op, не throw)', () => {
    // Регресс #70: handoffToLive был ЕДИНСТВЕННЫМ публичным мутатором без
    // `if (this._destroyed) return` — соседи (start/retarget/retargetAll) после
    // destroy рано выходят, а он валидировал индекс (бросал на out-of-range
    // мёртвой группы) и для in-range тянулся к мёртвому ребёнку. Гард строит
    // ИНЕРТНЫЙ MotionValue на СВОИХ _spring/_from → петля не стартует.
    const rf = vi.fn((): number => 1); // шпион: инертное значение не должно его звать
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'x', from: 5, to: 100, targets: [recordingEl()], requestFrame: rf,
    });
    g.start();
    g.destroy();

    // (1) in-range: инертный MotionValue, инъектированный requestFrame НЕ зван.
    const mv = g.handoffToLive(0);
    expect(typeof mv.setTarget).toBe('function'); // контракт: всегда MotionValue
    expect(rf).not.toHaveBeenCalled();            // инертность → нет rAF-петли

    // (2) СОГЛАСОВАНО с guard-соседями: out-of-range на мёртвой группе — тихий
    //     no-op (как start/retarget после destroy), а НЕ MotionParamError. Без
    //     гарда этот путь бросает → рассогласование post-destroy контракта (RED).
    expect(() => g.handoffToLive(5)).not.toThrow();
    expect(() => g.retarget(5, 10)).not.toThrow(); // сосед-эталон: молча no-op после destroy
    const oob = g.handoffToLive(99);
    expect(typeof oob.setTarget).toBe('function'); // и он вернул MotionValue (контракт)
    expect(rf).not.toHaveBeenCalled();             // по-прежнему инертно на всех путях
  });
});

// ─── CompositorStaggerGroup: fallback-путь (SSR / нет WAAPI) ──────────────────

describe('compositor stagger: группа fallback-путь (нет WAAPI)', () => {
  it('targets=undefined → mode fallback; каскад сохраняется отложенным setTimer(ms=delay)', () => {
    const timers = manualTimers();
    const applied: [number, string | number][] = [];
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'opacity', from: 0, to: 1,
      targets: [undefined, undefined, undefined],
      gap: 40,
      apply: (i, v) => applied.push([i, v]),
      setTimer: timers.setTimer,
      requestFrame: inertRF,
    });
    expect(g.mode).toBe('fallback');
    expect(g.delays).toEqual([0, 40, 80]);
    g.start();
    // Элемент 0 (delay 0) стартует немедленно → таймер НЕ ставится.
    // Элементы 1,2 → таймеры с ms = их задержки (каскад на main-thread сохранён).
    expect(timers.scheduled.map((s) => s.ms)).toEqual([40, 80]);
    // apply получил начальное значение (onChange эмитит текущее) для каждого элемента.
    expect(applied.filter(([, v]) => v === 0).length).toBeGreaterThanOrEqual(3);
    // flush не должен бросать (setTarget отложенных элементов).
    expect(() => timers.flush()).not.toThrow();
    g.destroy();
  });

  it('fallback: destroy ДО срабатывания таймера отменяет его → setTarget НЕ зван (нет утечки)', () => {
    const timers = manualTimers();
    const applied: [number, number | string][] = [];
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'opacity', from: 0, to: 1,
      targets: [undefined, undefined], gap: 100, staggerFrom: 'last', // элемент 0 → delay 100
      apply: (i, v) => applied.push([i, v]),
      setTimer: timers.setTimer, requestFrame: inertRF,
    });
    g.start();
    expect(timers.scheduled).toHaveLength(1); // элемент 0 (delay 100) поставил таймер
    g.destroy();
    expect(timers.scheduled[0]!.cancelled).toBe(true); // destroy → _clearTimer отменил (первичная защита)
    const beforeCount = applied.length;
    timers.flush(); // cancelled → колбэк не зван; плюс guard _destroyed внутри — двойная защита
    expect(applied.length).toBe(beforeCount); // никаких новых драйв-эмиссий после destroy
  });

  it('fallback retarget в окне задержки: снимает отложенный таймер (старт «сейчас»)', () => {
    const timers = manualTimers();
    const g = new CompositorStaggerGroup({
      spring: SPRING, property: 'opacity', from: 0, to: 1,
      targets: [undefined, undefined],
      gap: 100,
      staggerFrom: 'last', // элемент 0 получает delay=100
      setTimer: timers.setTimer,
      requestFrame: inertRF,
    });
    g.start();
    expect(timers.scheduled).toHaveLength(1); // элемент 0 (delay 100) поставил таймер
    g.retarget(0, 0.5); // ретаргет = «сейчас» → таймер отменён
    expect(timers.scheduled[0]!.cancelled).toBe(true);
    g.destroy();
  });
});

// ─── Дифференциал: план из группы ≡ прямой compileStaggerPlan ─────────────────

describe('compositor stagger: план группы ≡ чистый планировщик', () => {
  it('group.plan.delays/easing совпадают с compileStaggerPlan для того же входа', () => {
    const els = [recordingEl(), recordingEl(), recordingEl(), recordingEl()];
    const g = new CompositorStaggerGroup({ spring: SPRING, property: 'y', from: 0, to: 50, targets: els, gap: 30, staggerFrom: 'edges' });
    const direct = compileStaggerPlan({ spring: SPRING, property: 'y', from: 0, to: 50, count: 4, gap: 30, staggerFrom: 'edges' });
    expect(g.plan.delays).toEqual(direct.delays);
    expect(g.plan.easing).toBe(direct.easing);
  });
});
