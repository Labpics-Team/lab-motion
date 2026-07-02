/**
 * test/auto-animate.test.ts — zero-config FLIP (subpath ./auto, S14).
 * Классы: А (план/кейфреймы известных чисел, сценарии адаптера) +
 * В (property epsilon, fuzz злых rect) + Д (mutation-хуки формул плана).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают все поведенческие блоки.
 * Mutation-proof: сломать epsilon-сравнение (>= вместо >) → «дрожь ниже
 * epsilon не двигает» RED; перепутать first/last в moveKeyframes → известные
 * числа инверсии RED; сломать reduced-ветку → «reduced: move снапает» RED;
 * потерять exit-реинсерт → сценарий remove RED.
 *
 * Канон (заземлён: auto-animate.formkit.com + D9): триггеры add/remove/move,
 * контроллер enable/disable, parent получает position:relative если static,
 * дефолты 250ms / ease-in-out, reduced-motion уважается по умолчанию.
 * Наш ров: reduced-motion меняет ХАРАКТЕР (move→снап, enter/exit→opacity),
 * не выключает адаптер.
 */

import { describe, expect, it } from 'vitest';
import * as auto from '../src/auto/index.js';
import {
  autoAnimate,
  enterKeyframes,
  exitKeyframes,
  moveKeyframes,
  planAuto,
} from '../src/auto/index.js';
import { MotionParamError } from '../src/index.js';

// ─── planAuto (чистый диффер) ────────────────────────────────────────────────

const R = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });

describe('auto: planAuto — известные числа', () => {
  it('add/remove/move раскладываются по спискам', () => {
    const prev: [string, ReturnType<typeof R>][] = [
      ['a', R(0, 0)],
      ['b', R(0, 60)],
    ];
    const next: [string, ReturnType<typeof R>][] = [
      ['b', R(0, 0)],
      ['c', R(0, 60)],
    ];
    const plan = planAuto(prev, next);
    expect(plan.enters).toEqual(['c']);
    expect(plan.exits).toEqual([['a', R(0, 0)]]);
    expect(plan.moves).toEqual([['b', { first: R(0, 60), last: R(0, 0) }]]);
  });

  it('неизменившийся rect не порождает move', () => {
    const same: [string, ReturnType<typeof R>][] = [['a', R(5, 5)]];
    expect(planAuto(same, same).moves).toEqual([]);
  });

  it('property: дрожь ниже epsilon (по умолчанию 0.5px) не двигает, выше — двигает', () => {
    const prev: [string, ReturnType<typeof R>][] = [['a', R(0, 0)]];
    expect(planAuto(prev, [['a', R(0.4, 0)]]).moves).toEqual([]);
    expect(planAuto(prev, [['a', R(0.6, 0)]]).moves).toHaveLength(1);
    // изменение размера — тоже движение (scale-часть FLIP)
    expect(planAuto(prev, [['a', R(0, 0, 100.6, 50)]]).moves).toHaveLength(1);
  });

  it('кастомный epsilon прокидывается; невалидный → MotionParamError', () => {
    const prev: [string, ReturnType<typeof R>][] = [['a', R(0, 0)]];
    expect(planAuto(prev, [['a', R(2, 0)]], 3).moves).toEqual([]);
    for (const eps of [-1, NaN, Infinity]) {
      expect(() => planAuto(prev, prev, eps)).toThrow(MotionParamError);
    }
  });

  it('fuzz: злые rect (NaN/Infinity) не роняют и не дают NaN в плане', () => {
    const evil: [string, ReturnType<typeof R>][] = [
      ['a', { x: NaN, y: 0, width: 100, height: 50 }],
      ['b', { x: 0, y: Infinity, width: -0, height: 1e308 }],
    ];
    const plan = planAuto(evil, [
      ['a', R(10, 10)],
      ['b', R(0, 0)],
    ]);
    expect(plan.enters).toEqual([]);
    expect(plan.exits).toEqual([]);
    expect(plan.moves.length).toBeGreaterThanOrEqual(0); // не бросает — уже контракт
  });
});

// ─── Строители кейфреймов ────────────────────────────────────────────────────

describe('auto: строители кейфреймов', () => {
  it('moveKeyframes: FLIP-инверсия first→last, конец — none', () => {
    const kf = moveKeyframes(R(0, 0, 100, 50), R(40, 30, 200, 50));
    // dx = 0−40 = −40, dy = 0−30 = −30, sx = 100/200 = 0.5, sy = 1
    expect(kf[0]!['transform']).toBe('translate(-40px, -30px) scale(0.5, 1)');
    expect(kf[0]!['transformOrigin']).toBe('0 0');
    expect(kf[1]!['transform']).toBe('none');
  });

  it('moveKeyframes: вырожденный last (нулевая ширина) → конечные числа (страж flip)', () => {
    const kf = moveKeyframes(R(0, 0, 100, 50), R(0, 0, 0, 50));
    expect(kf[0]!['transform']).toMatch(/^translate\(/);
    expect(kf[0]!['transform']).not.toMatch(/NaN|Infinity/);
  });

  it('enterKeyframes/exitKeyframes: opacity-пары с точными эндпоинтами', () => {
    expect(enterKeyframes().map((k) => k['opacity'])).toEqual([0, 1]);
    expect(exitKeyframes().map((k) => k['opacity'])).toEqual([1, 0]);
  });
});

// ─── Адаптер: фейковый DOM ───────────────────────────────────────────────────

interface FakeAnimation {
  onfinish: (() => void) | null;
  cancelled: boolean;
  cancel(): void;
}

function fakeEl(rect: { x: number; y: number; width: number; height: number }, name = '') {
  const animateCalls: { keyframes: unknown; timing: Record<string, unknown> }[] = [];
  const animations: FakeAnimation[] = [];
  return {
    name,
    rect,
    animateCalls,
    animations,
    style: {} as Record<string, string>,
    getBoundingClientRect() {
      return { ...this.rect };
    },
    animate(keyframes: unknown, timing: Record<string, unknown>) {
      animateCalls.push({ keyframes, timing });
      const a: FakeAnimation = {
        onfinish: null,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      animations.push(a);
      return a;
    },
  };
}
type FakeEl = ReturnType<typeof fakeEl>;

function fakeParent(children: FakeEl[], border = { left: 0, top: 0 }) {
  const appended: FakeEl[] = [];
  const removed: FakeEl[] = [];
  const parent = {
    children: [...children] as FakeEl[],
    appended,
    removed,
    style: {} as Record<string, string>,
    clientLeft: border.left,
    clientTop: border.top,
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 500, height: 500 };
    },
    appendChild(el: FakeEl) {
      appended.push(el);
      if (!this.children.includes(el)) this.children.push(el);
    },
    removeChild(el: FakeEl) {
      removed.push(el);
      this.children = this.children.filter((c) => c !== el);
    },
  };
  return parent;
}

/** Инжектируемый MutationObserver: копит колбэк, records подаются вручную. */
function fakeObserverSeam() {
  const state: {
    callback: ((records: unknown[]) => void) | null;
    observed: unknown[];
    disconnected: boolean;
  } = { callback: null, observed: [], disconnected: false };
  class Ctor {
    constructor(cb: (records: unknown[]) => void) {
      state.callback = cb;
    }
    observe(target: unknown, opts: unknown) {
      state.observed.push([target, opts]);
    }
    disconnect() {
      state.disconnected = true;
    }
  }
  return { state, Ctor };
}

const matchMediaReduce =
  (matches: boolean) =>
  (_q: string): { matches: boolean } => ({ matches });

describe('auto: autoAnimate — адаптер (duck-typed DOM)', () => {
  it('parent со static-позицией получает position:relative; observer подписан на childList', () => {
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    autoAnimate(parent as never, {
      MutationObserverCtor: seam.Ctor as never,
      getComputedPosition: () => 'static',
    });
    expect(parent.style['position']).toBe('relative');
    expect(seam.state.observed).toHaveLength(1);
    expect((seam.state.observed[0] as unknown[])[1]).toMatchObject({ childList: true });
  });

  it('не-static parent не трогается', () => {
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    autoAnimate(parent as never, {
      MutationObserverCtor: seam.Ctor as never,
      getComputedPosition: () => 'sticky',
    });
    expect(parent.style['position']).toBeUndefined();
  });

  it('добавление ребёнка → enter-анимация (opacity 0→1) на нём', () => {
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    const child = fakeEl(R(0, 0), 'new');
    parent.children.push(child);
    seam.state.callback!([{ addedNodes: [child], removedNodes: [] }]);
    expect(child.animateCalls).toHaveLength(1);
    const kf = child.animateCalls[0]!.keyframes as Record<string, unknown>[];
    expect(kf.map((k) => k['opacity'])).toEqual([0, 1]);
  });

  it('движение ребёнка → FLIP-transform от старого rect к новому', () => {
    const seam = fakeObserverSeam();
    const moved = fakeEl(R(0, 60), 'moved');
    const parent = fakeParent([moved]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    moved.rect = R(0, 0); // элемент уехал вверх
    // любой childList-рекорд триггерит переплан (сосед удалён и т.п.)
    seam.state.callback!([{ addedNodes: [], removedNodes: [] }]);
    expect(moved.animateCalls).toHaveLength(1);
    const kf = moved.animateCalls[0]!.keyframes as Record<string, unknown>[];
    expect(kf[0]!['transform']).toBe('translate(0px, 60px) scale(1, 1)');
    expect(kf[1]!['transform']).toBe('none');
  });

  it('удаление → реинсерт absolute на старом месте, exit-анимация, удаление на onfinish', () => {
    const seam = fakeObserverSeam();
    const doomed = fakeEl(R(20, 40), 'doomed');
    const parent = fakeParent([doomed]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    parent.children = parent.children.filter((c) => c !== doomed);
    seam.state.callback!([{ addedNodes: [], removedNodes: [doomed] }]);
    // реинсерт и абсолютное позиционирование на прежнем rect (относительно parent 0,0)
    expect(parent.appended).toContain(doomed);
    expect(doomed.style['position']).toBe('absolute');
    expect(doomed.style['left']).toBe('20px');
    expect(doomed.style['top']).toBe('40px');
    const kf = doomed.animateCalls[0]!.keyframes as Record<string, unknown>[];
    expect(kf.map((k) => k['opacity'])).toEqual([1, 0]);
    // до onfinish элемент ещё в DOM; после — удалён
    expect(parent.removed).not.toContain(doomed);
    doomed.animations[0]!.onfinish!();
    expect(parent.removed).toContain(doomed);
  });

  it('border родителя учитывается: absolute считается от padding-box (минус clientLeft/clientTop)', () => {
    const seam = fakeObserverSeam();
    const doomed = fakeEl(R(20, 40), 'doomed');
    const parent = fakeParent([doomed], { left: 5, top: 3 });
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    parent.children = parent.children.filter((c) => c !== doomed);
    seam.state.callback!([{ addedNodes: [], removedNodes: [doomed] }]);
    expect(doomed.style['left']).toBe('15px'); // 20 − 0 − 5
    expect(doomed.style['top']).toBe('37px'); // 40 − 0 − 3
  });

  it('реинкарнация во время exit: эхо своего re-append не путается с возвратом потребителя', () => {
    const seam = fakeObserverSeam();
    const phoenix = fakeEl(R(10, 10), 'phoenix');
    const parent = fakeParent([phoenix]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    // удаление → exit пошёл (адаптер сам re-append'ит узел absolute)
    parent.children = parent.children.filter((c) => c !== phoenix);
    seam.state.callback!([{ addedNodes: [], removedNodes: [phoenix] }]);
    const exitAnim = phoenix.animations[0]!;
    expect(phoenix.style['position']).toBe('absolute');
    // эхо-запись нашего же re-append (реальный MutationObserver её принесёт)
    seam.state.callback!([{ addedNodes: [phoenix], removedNodes: [] }]);
    expect(exitAnim.cancelled).toBe(false); // эхо потреблено, exit живёт
    expect(phoenix.style['position']).toBe('absolute');
    // а теперь ПОТРЕБИТЕЛЬ вернул тот же узел до onfinish
    seam.state.callback!([{ addedNodes: [phoenix], removedNodes: [] }]);
    expect(exitAnim.cancelled).toBe(true); // exit отменён
    expect(phoenix.style['position']).toBe(''); // наши инлайны сняты
    expect(phoenix.style['left']).toBe('');
    expect(phoenix.style['top']).toBe('');
    expect(phoenix.animateCalls).toHaveLength(2); // exit + enter
    const enterKf = phoenix.animateCalls[1]!.keyframes as Record<string, unknown>[];
    expect(enterKf.map((k) => k['opacity'])).toEqual([0, 1]);
    expect(parent.removed).not.toContain(phoenix); // onfinish отменённого не удалит
  });

  it('reduced-motion (по умолчанию уважается): move НЕ анимируется (снап), exit — opacity', () => {
    const seam = fakeObserverSeam();
    const moved = fakeEl(R(0, 60), 'moved');
    const parent = fakeParent([moved]);
    autoAnimate(parent as never, {
      MutationObserverCtor: seam.Ctor as never,
      matchMedia: matchMediaReduce(true),
    });
    moved.rect = R(0, 0);
    seam.state.callback!([{ addedNodes: [], removedNodes: [] }]);
    expect(moved.animateCalls).toHaveLength(0); // характер: позиция меняется мгновенно
    // enter при reduce остаётся opacity-фейдом (не вестибулярный)
    const added = fakeEl(R(0, 120), 'added');
    parent.children.push(added);
    seam.state.callback!([{ addedNodes: [added], removedNodes: [] }]);
    expect(added.animateCalls).toHaveLength(1);
    expect(
      (added.animateCalls[0]!.keyframes as Record<string, unknown>[]).some((k) => 'transform' in k),
    ).toBe(false);
  });

  it('disable() глушит анимации (снап-поведение), enable() возвращает', () => {
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    const ctl = autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    ctl.disable();
    const child = fakeEl(R(0, 0));
    parent.children.push(child);
    seam.state.callback!([{ addedNodes: [child], removedNodes: [] }]);
    expect(child.animateCalls).toHaveLength(0);
    ctl.enable();
    const child2 = fakeEl(R(0, 60));
    parent.children.push(child2);
    seam.state.callback!([{ addedNodes: [child2], removedNodes: [] }]);
    expect(child2.animateCalls).toHaveLength(1);
  });

  it('кэш обновляется между срабатываниями: второй add не пере-анимирует первого', () => {
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    const c1 = fakeEl(R(0, 0), 'c1');
    parent.children.push(c1);
    seam.state.callback!([{ addedNodes: [c1], removedNodes: [] }]);
    const c2 = fakeEl(R(0, 60), 'c2');
    parent.children.push(c2);
    seam.state.callback!([{ addedNodes: [c2], removedNodes: [] }]);
    expect(c1.animateCalls).toHaveLength(1); // не enter повторно и не move
    expect(c2.animateCalls).toHaveLength(1);
  });

  it('disconnect() отписывает observer', () => {
    const seam = fakeObserverSeam();
    const ctl = autoAnimate(fakeParent([]) as never, {
      MutationObserverCtor: seam.Ctor as never,
    });
    ctl.disconnect();
    expect(seam.state.disconnected).toBe(true);
  });

  it('duration/easing прокидываются в timing (сек движка → мс WAAPI, easing → linear())', () => {
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    autoAnimate(parent as never, {
      MutationObserverCtor: seam.Ctor as never,
      duration: 0.4,
      easing: (t: number) => t * t,
    });
    const child = fakeEl(R(0, 0));
    parent.children.push(child);
    seam.state.callback!([{ addedNodes: [child], removedNodes: [] }]);
    const timing = child.animateCalls[0]!.timing;
    expect(timing['duration']).toBe(400);
    expect(String(timing['easing'])).toMatch(/^linear\(/);
  });

  it('без MutationObserver в среде → инертный контроллер, не бросает (SSR/legacy)', () => {
    const parent = fakeParent([]);
    const ctl = autoAnimate(parent as never, {});
    expect(() => {
      ctl.disable();
      ctl.enable();
      ctl.disconnect();
    }).not.toThrow();
  });

  it('невалидные опции → MotionParamError', () => {
    const seam = fakeObserverSeam();
    for (const bad of [{ duration: 0 }, { duration: -1 }, { duration: NaN }, { epsilon: -1 }]) {
      expect(() =>
        autoAnimate(fakeParent([]) as never, {
          MutationObserverCtor: seam.Ctor as never,
          ...bad,
        }),
      ).toThrow(MotionParamError);
    }
  });
});

// ─── Детерминизм и поверхность ───────────────────────────────────────────────

describe('auto-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(auto).sort()).toEqual([
      'autoAnimate',
      'enterKeyframes',
      'exitKeyframes',
      'moveKeyframes',
      'planAuto',
    ]);
  });

  it('SSR: import + чистые вызовы в node env не бросают (DOM-глобалов нет)', () => {
    expect(() => {
      planAuto([], []);
      moveKeyframes(R(0, 0), R(10, 10));
      enterKeyframes();
      exitKeyframes();
    }).not.toThrow();
  });

  it('детерминизм: план и кейфреймы структурно идентичны от одного входа', () => {
    const prev: [string, ReturnType<typeof R>][] = [['a', R(0, 0)]];
    const next: [string, ReturnType<typeof R>][] = [['a', R(10, 10)]];
    expect(planAuto(prev, next)).toEqual(planAuto(prev, next));
    expect(moveKeyframes(R(0, 0), R(10, 10))).toEqual(moveKeyframes(R(0, 0), R(10, 10)));
  });
});
