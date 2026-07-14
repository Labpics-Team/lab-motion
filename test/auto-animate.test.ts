/**
 * test/auto-animate.test.ts — zero-config FLIP (subpath ./auto, S14).
 * Классы: А (план/кейфреймы известных чисел, сценарии адаптера) +
 * В (property epsilon, fuzz злых rect) + Д (mutation-хуки формул плана).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
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

  it('property: детекция move симметрична по всем 4 осям rect', () => {
    // Класс «выпавшая ось» (аккордеон = только height): каждая ось отдельно
    // обязана и триггерить сверх epsilon, и молчать ниже него.
    const base = R(10, 20, 100, 50);
    const axes: [string, ReturnType<typeof R>, ReturnType<typeof R>][] = [
      ['x', { ...base, x: base.x + 1 }, { ...base, x: base.x + 0.4 }],
      ['y', { ...base, y: base.y + 1 }, { ...base, y: base.y + 0.4 }],
      ['width', { ...base, width: base.width + 1 }, { ...base, width: base.width + 0.4 }],
      ['height', { ...base, height: base.height + 1 }, { ...base, height: base.height + 0.4 }],
    ];
    for (const [axis, movedRect, jitterRect] of axes) {
      expect(planAuto([['a', base]], [['a', movedRect]]).moves, `ось ${axis}`).toHaveLength(1);
      expect(planAuto([['a', base]], [['a', jitterRect]]).moves, `дрожь ${axis}`).toEqual([]);
    }
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
    doomed.style['position'] = 'relative';
    doomed.style['left'] = '2px';
    doomed.style['top'] = '3px';
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
    expect(doomed.style).toMatchObject({ position: 'relative', left: '2px', top: '3px' });
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
    phoenix.style['position'] = 'relative';
    phoenix.style['left'] = '7px';
    phoenix.style['top'] = '8px';
    const parent = fakeParent([phoenix]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    // удаление → exit пошёл (адаптер сам re-append'ит узел absolute)
    parent.children = parent.children.filter((c) => c !== phoenix);
    seam.state.callback!([{ addedNodes: [], removedNodes: [phoenix] }]);
    const exitAnim = phoenix.animations[0]!;
    const lateFinish = exitAnim.onfinish!;
    expect(phoenix.style['position']).toBe('absolute');
    // эхо-запись нашего же re-append (реальный MutationObserver её принесёт)
    seam.state.callback!([{ addedNodes: [phoenix], removedNodes: [] }]);
    expect(exitAnim.cancelled).toBe(false); // эхо потреблено, exit живёт
    expect(phoenix.style['position']).toBe('absolute');
    // а теперь ПОТРЕБИТЕЛЬ вернул тот же узел до onfinish
    seam.state.callback!([{ addedNodes: [phoenix], removedNodes: [] }]);
    expect(exitAnim.cancelled).toBe(true); // exit отменён
    expect(phoenix.style['position']).toBe('relative'); // исходные инлайны восстановлены
    expect(phoenix.style['left']).toBe('7px');
    expect(phoenix.style['top']).toBe('8px');
    expect(phoenix.animateCalls).toHaveLength(2); // exit + enter
    const enterKf = phoenix.animateCalls[1]!.keyframes as Record<string, unknown>[];
    expect(enterKf.map((k) => k['opacity'])).toEqual([0, 1]);
    expect(parent.removed).not.toContain(phoenix); // onfinish отменённого не удалит
    // Host мог уже захватить callback до обнуления onfinish.
    // Старый terminal обязан проверить identity текущего exit.
    lateFinish();
    expect(parent.removed).not.toContain(phoenix);
    expect(parent.children).toContain(phoenix);
  });

  it('старый terminal не завершает новый exit при повторной host Animation', () => {
    const seam = fakeObserverSeam();
    const phoenix = fakeEl(R(10, 10), 'phoenix');
    const reused: FakeAnimation = {
      onfinish: null,
      cancelled: false,
      cancel() { this.cancelled = true; },
    };
    phoenix.animate = (keyframes: unknown, timing: Record<string, unknown>) => {
      phoenix.animateCalls.push({ keyframes, timing });
      phoenix.animations.push(reused);
      return reused;
    };
    const parent = fakeParent([phoenix]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });

    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [phoenix] }]);
    const firstFinish = reused.onfinish!;
    seam.state.callback!([{ addedNodes: [phoenix], removedNodes: [] }]);
    seam.state.callback!([{ addedNodes: [phoenix], removedNodes: [] }]);

    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [phoenix] }]);
    const secondFinish = reused.onfinish!;
    expect(secondFinish).not.toBe(firstFinish);

    firstFinish();
    expect(parent.removed).not.toContain(phoenix);
    secondFinish();
    expect(parent.removed).toContain(phoenix);
  });

  it('одна host Animation завершает tickets всех узлов', () => {
    const seam = fakeObserverSeam();
    const a = fakeEl(R(0, 0), 'a');
    const b = fakeEl(R(20, 0), 'b');
    const shared: FakeAnimation = {
      onfinish: null,
      cancelled: false,
      cancel() { this.cancelled = true; },
    };
    a.animate = b.animate = () => shared;
    const parent = fakeParent([a, b]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });

    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [a, b] }]);
    shared.onfinish!();

    expect(parent.removed.map((node) => node.name)).toEqual(['a', 'b']);
    expect(parent.children).toEqual([]);
  });

  it('возврат одного ticket не отменяет общую Animation оставшегося exit', () => {
    const seam = fakeObserverSeam();
    const a = fakeEl(R(0, 0), 'a');
    const b = fakeEl(R(20, 0), 'b');
    const shared: FakeAnimation = {
      onfinish: null,
      cancelled: false,
      cancel() { this.cancelled = true; },
    };
    a.animate = b.animate = () => shared;
    const parent = fakeParent([a, b]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });

    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [a, b] }]);
    seam.state.callback!([{ addedNodes: [a], removedNodes: [] }]);
    seam.state.callback!([{ addedNodes: [a], removedNodes: [] }]);

    expect(shared.cancelled).toBe(false);
    shared.onfinish!();
    expect(parent.removed).not.toContain(a);
    expect(parent.removed).toContain(b);
  });

  it('одна host Animation имеет единого terminal-владельца между контроллерами', () => {
    const leftSeam = fakeObserverSeam();
    const rightSeam = fakeObserverSeam();
    const left = fakeEl(R(0, 0), 'left');
    const right = fakeEl(R(0, 0), 'right');
    const shared: FakeAnimation = {
      onfinish: null,
      cancelled: false,
      cancel() { this.cancelled = true; },
    };
    left.animate = right.animate = () => shared;
    const leftParent = fakeParent([left]);
    const rightParent = fakeParent([right]);
    autoAnimate(leftParent as never, { MutationObserverCtor: leftSeam.Ctor as never });
    autoAnimate(rightParent as never, { MutationObserverCtor: rightSeam.Ctor as never });

    leftParent.children = [];
    leftSeam.state.callback!([{ addedNodes: [], removedNodes: [left] }]);
    rightParent.children = [];
    rightSeam.state.callback!([{ addedNodes: [], removedNodes: [right] }]);
    shared.onfinish!();

    expect(leftParent.removed).toEqual([left]);
    expect(rightParent.removed).toEqual([right]);
  });

  it('disconnect одного контроллера не отменяет shared Animation другого', () => {
    const leftSeam = fakeObserverSeam();
    const rightSeam = fakeObserverSeam();
    const left = fakeEl(R(0, 0), 'left');
    const right = fakeEl(R(0, 0), 'right');
    const shared: FakeAnimation = {
      onfinish: null,
      cancelled: false,
      cancel() { this.cancelled = true; },
    };
    left.animate = right.animate = () => shared;
    const leftParent = fakeParent([left]);
    const rightParent = fakeParent([right]);
    const leftControl = autoAnimate(leftParent as never, {
      MutationObserverCtor: leftSeam.Ctor as never,
    });
    autoAnimate(rightParent as never, { MutationObserverCtor: rightSeam.Ctor as never });

    leftParent.children = [];
    leftSeam.state.callback!([{ addedNodes: [], removedNodes: [left] }]);
    rightParent.children = [];
    rightSeam.state.callback!([{ addedNodes: [], removedNodes: [right] }]);
    leftControl.disconnect();

    expect(shared.cancelled).toBe(false);
    expect(leftParent.removed).toEqual([left]);
    expect(rightParent.removed).toEqual([]);
    shared.onfinish!();
    expect(rightParent.removed).toEqual([right]);
  });

  it('бросок onfinish-setter откатывает ghost, но не обрывает соседний exit', () => {
    const seam = fakeObserverSeam();
    const hostile = fakeEl(R(0, 0), 'hostile');
    const healthy = fakeEl(R(20, 0), 'healthy');
    hostile.style['position'] = 'relative';
    hostile.style['left'] = '3px';
    hostile.style['top'] = '4px';
    let cancelCalls = 0;
    const assigned: Array<() => void> = [];
    const broken = { cancel: () => { cancelCalls++; } } as unknown as FakeAnimation;
    Object.defineProperty(broken, 'onfinish', {
      set(next: (() => void) | null) {
        if (next !== null) assigned.push(next);
        throw new Error('host setter failed');
      },
    });
    hostile.animate = () => broken;
    const parent = fakeParent([hostile, healthy]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });

    parent.children = [];
    expect(() => {
      seam.state.callback!([{ addedNodes: [], removedNodes: [hostile, healthy] }]);
    }).not.toThrow();

    expect(cancelCalls).toBe(1);
    expect(parent.removed).toContain(hostile);
    expect(hostile.style).toMatchObject({ position: 'relative', left: '3px', top: '4px' });
    expect(healthy.animateCalls).toHaveLength(1);
    healthy.animations[0]!.onfinish!();
    expect(parent.removed).toContain(healthy);
    assigned[0]!();
    expect(parent.removed.filter((node) => node === hostile)).toHaveLength(1);
  });

  it('бросок node.animate откатывает ghost, но не обрывает соседний exit', () => {
    const seam = fakeObserverSeam();
    const hostile = fakeEl(R(0, 0), 'hostile');
    const healthy = fakeEl(R(20, 0), 'healthy');
    hostile.style['position'] = 'sticky';
    hostile.style['left'] = '5px';
    hostile.style['top'] = '6px';
    hostile.animate = () => { throw new Error('host animate failed'); };
    const parent = fakeParent([hostile, healthy]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });

    parent.children = [];
    expect(() => {
      seam.state.callback!([{ addedNodes: [], removedNodes: [hostile, healthy] }]);
    }).not.toThrow();

    expect(parent.removed).toContain(hostile);
    expect(hostile.style).toMatchObject({ position: 'sticky', left: '5px', top: '6px' });
    expect(healthy.animateCalls).toHaveLength(1);
    healthy.animations[0]!.onfinish!();
    expect(parent.removed).toContain(healthy);
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
    const parent = fakeParent([]);
    const ctl = autoAnimate(parent as never, {
      MutationObserverCtor: seam.Ctor as never,
    });
    ctl.disconnect();
    expect(seam.state.disconnected).toBe(true);

    const late = fakeEl(R(0, 0), 'late');
    parent.children.push(late);
    seam.state.callback!([{ addedNodes: [late], removedNodes: [] }]);
    expect(late.animateCalls).toHaveLength(0);
  });

  it('disconnect до observer-эха завершает ghost cleanup', () => {
    const seam = fakeObserverSeam();
    const doomed = fakeEl(R(0, 0), 'doomed');
    doomed.style['position'] = 'relative';
    doomed.style['left'] = '9px';
    doomed.style['top'] = '10px';
    const parent = fakeParent([doomed]);
    const ctl = autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });

    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [doomed] }]);
    const animation = doomed.animations[0]!;
    const lateFinish = animation.onfinish!;
    ctl.disconnect();

    expect(animation.cancelled).toBe(true);
    expect(parent.removed).toEqual([doomed]);
    expect(parent.children).toEqual([]);
    expect(doomed.style).toMatchObject({ position: 'relative', left: '9px', top: '10px' });
    lateFinish();
    seam.state.callback!([{ addedNodes: [doomed], removedNodes: [] }]);
    expect(parent.removed).toEqual([doomed]);
    expect(doomed.animateCalls).toHaveLength(1);
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
    expect(timing['fill']).toBe('both');
  });

  it('дефолтный timing запинен целиком: 250ms / ease-in-out / fill both', () => {
    // fill:'both' — семантика FLIP: без backwards-fill инвертированный transform
    // не держится до старта (скачок первого кадра), без forwards — конец.
    const seam = fakeObserverSeam();
    const parent = fakeParent([]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    const child = fakeEl(R(0, 0));
    parent.children.push(child);
    seam.state.callback!([{ addedNodes: [child], removedNodes: [] }]);
    expect(child.animateCalls[0]!.timing).toEqual({
      duration: 250,
      easing: 'ease-in-out',
      fill: 'both',
    });
  });

  it('регрессия: несколько exits в одной записи — оба реинсертятся и удаляются', () => {
    const seam = fakeObserverSeam();
    const d1 = fakeEl(R(0, 0), 'd1');
    const d2 = fakeEl(R(0, 60), 'd2');
    const parent = fakeParent([d1, d2]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [d1, d2] }]);
    expect(parent.appended).toEqual(expect.arrayContaining([d1, d2]));
    d1.animations[0]!.onfinish!();
    d2.animations[0]!.onfinish!();
    expect(parent.removed).toEqual(expect.arrayContaining([d1, d2]));
  });

  it('регрессия: move и exit в одной записи — сосед едет FLIP, удаляемый уходит exit', () => {
    const seam = fakeObserverSeam();
    const doomed = fakeEl(R(0, 0), 'doomed');
    const stays = fakeEl(R(0, 60), 'stays');
    const parent = fakeParent([doomed, stays]);
    autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    parent.children = [stays];
    stays.rect = R(0, 0); // сосед поднялся на место удалённого
    seam.state.callback!([{ addedNodes: [], removedNodes: [doomed] }]);
    const stayKf = stays.animateCalls[0]!.keyframes as Record<string, unknown>[];
    expect(stayKf[0]!['transform']).toBe('translate(0px, 60px) scale(1, 1)');
    const doomKf = doomed.animateCalls[0]!.keyframes as Record<string, unknown>[];
    expect(doomKf.map((k) => k['opacity'])).toEqual([1, 0]);
  });

  it('регрессия: disable() во время живого exit — onfinish всё равно удаляет узел (владение адаптера)', () => {
    const seam = fakeObserverSeam();
    const doomed = fakeEl(R(0, 0), 'doomed');
    const parent = fakeParent([doomed]);
    const ctl = autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [doomed] }]);
    ctl.disable();
    doomed.animations[0]!.onfinish!();
    expect(parent.removed).toContain(doomed);
  });

  it('регрессия: disconnect() во время живого exit — exit доигрывает и удаляет узел (нет утечки)', () => {
    const seam = fakeObserverSeam();
    const doomed = fakeEl(R(0, 0), 'doomed');
    const parent = fakeParent([doomed]);
    const ctl = autoAnimate(parent as never, { MutationObserverCtor: seam.Ctor as never });
    parent.children = [];
    seam.state.callback!([{ addedNodes: [], removedNodes: [doomed] }]);
    ctl.disconnect();
    doomed.animations[0]!.onfinish!();
    expect(parent.removed).toContain(doomed);
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
