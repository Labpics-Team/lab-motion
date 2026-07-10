/**
 * test/projection-dom.test.ts — тонкий DOM-адаптер ./projection (dom.ts).
 * Классы: Б (контракт адаптера) + Д (mutation-proof) на tree-shaped duck-фейках
 * (node-env, без jsdom). Спека: §2.4 (capture/play/writer/restore), §4.0
 * (граница batch clear→measure→start), §4.2 (capture mid-flight), §4.5 (скролл),
 * §7.5.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написан до реализации: namespace-import + pick-хелпер (канон
 * test/animate-facade-helpers.ts:9-31) — на заглушке src/projection каждый it
 * падает СВОИМ ассертом «createDomProjection is not a function».
 *
 * Mutation proof:
 *   - Писать ребёнка раньше родителя (обход входного порядка вместо топосорта) →
 *     «порядок записи» красный (capture нарочно отдаёт [child, parent]).
 *   - Мерить ДО batch-clear (последовательность measure→clear) → журнал:
 *     замер видит наш `translate(` → «граница 4.0» красный.
 *   - Прошить запись style между clear и measure → «между замерами только
 *     measure» красный.
 *   - Убрать page-space конверсию (+getScroll) → фантомный translate от дельты
 *     скролла → «скролл-дельта» красный.
 *   - Читать getScroll на кадре (после старта) → «скролл в полёте инертен» красный.
 *   - Писать радиус без слэш-синтаксиса / без коррекции k → «radius» красный.
 *   - Не восстановить сохранённый inline на rest/cancel → «restore» красный.
 *   - Убрать хоп assignedSlot или getRootNode().host → ребёнок в shadow/slot
 *     получает наивный root-flip → «composed-обход» красный.
 *   - capture mid-flight через getBoundingClientRect → журнал замеров растёт →
 *     «без gBCR у узлов полёта» красный (класс «замер под transform», гэп flip №2).
 *   - Убрать раннюю проверку capture → «play без capture» красный.
 */

import { describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  makeClock,
  makeWorld,
  parseTranslateScale,
  pickCreateDomProjection,
  type FakeWorld,
  type StepClock,
  type WorldOp,
} from './projection-helpers.js';

const mod = projection as unknown as Record<string, unknown>;
const createDomProjection = pickCreateDomProjection(mod);

function domOptions(
  world: FakeWorld,
  clock: StepClock,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    requestFrame: clock.requestFrame,
    getScroll: () => world.getScroll(),
    getComputedStyle: (el: unknown) => world.getComputedStyle(el),
    ...extra,
  };
}

/** set-записи transform, являющиеся кадрами полёта (writer-формат спеки §2.4). */
function flightTransformWrites(ops: readonly WorldOp[]): WorldOp[] {
  return ops.filter(
    (o) => o.kind === 'set' && o.prop === 'transform' && (o.value ?? '').includes('translate('),
  );
}

// Рект-набор §2.1.3: перестановка родителя и ребёнка с известными кадрами.
const P_FIRST = { x: 0, y: 0, width: 100, height: 100 };
const P_LAST = { x: 50, y: 0, width: 200, height: 200 };
const C_FIRST = { x: 10, y: 10, width: 20, height: 20 };
const C_LAST = { x: 70, y: 10, width: 40, height: 40 };

describe('projection/dom: порядок записи — родитель раньше ребёнка', () => {
  it('дерево выводится по composed-предкам; журнал: P пишется раньше C на каждом кадре', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', P_FIRST);
    const C = world.el('C', C_FIRST, { parent: P });
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([C, P]); // НАРОЧНО ребёнок первым — порядок обязан выправить топосорт
    P.rect = { ...P_LAST };
    C.rect = { ...C_LAST };
    dom.play();

    // Первый кадр — синхронно при play (анти-мигание, §2.3.1).
    expect(flightTransformWrites(world.writes(P)).length).toBeGreaterThanOrEqual(1);
    expect(flightTransformWrites(world.writes(C)).length).toBeGreaterThanOrEqual(1);

    clock.drain(16);
    const pW = flightTransformWrites(world.writes(P));
    const cW = flightTransformWrites(world.writes(C));
    expect(pW.length).toBe(cW.length);
    for (let i = 0; i < pW.length; i++) {
      expect(pW[i].seq, `кадр #${i}: родитель раньше ребёнка`).toBeLessThan(cW[i].seq);
    }
  });

  it('первый кадр ребёнка скорректирован (пин §2.1.3: {0, 10, 1, 1}), transform-origin "0 0"', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', P_FIRST);
    const C = world.el('C', C_FIRST, { parent: P });
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([P, C]);
    P.rect = { ...P_LAST };
    C.rect = { ...C_LAST };
    dom.play();

    const pT = parseTranslateScale(flightTransformWrites(world.writes(P))[0].value!)!;
    expect(pT.tx).toBeCloseTo(-50, 9);
    expect(pT.ty).toBeCloseTo(0, 9);
    expect(pT.sx).toBeCloseTo(0.5, 9);
    expect(pT.sy).toBeCloseTo(0.5, 9);

    const cT = parseTranslateScale(flightTransformWrites(world.writes(C))[0].value!)!;
    expect(cT.tx).toBeCloseTo(0, 9);
    expect(cT.ty).toBeCloseTo(10, 9);
    expect(cT.sx).toBeCloseTo(1, 9);
    expect(cT.sy).toBeCloseTo(1, 9);

    expect(P.inline.get('transform-origin')).toBe('0 0');
    expect(C.inline.get('transform-origin')).toBe('0 0');
  });
});

describe('projection/dom: граница §4.0 — batch clear → measure → start (журнал)', () => {
  it('mid-flight play: до замеров только clear, замеры не под нашим transform, batch чтений сплошной, старт после', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', P_FIRST);
    const C = world.el('C', C_FIRST, { parent: P });
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([P, C]);
    P.rect = { ...P_LAST };
    C.rect = { ...C_LAST };
    dom.play();
    clock.step(16);
    // Полёт живёт, наш inline-transform стоит.
    expect(P.inline.get('transform') ?? '').toContain('translate(');
    expect(dom.playing).toBe(true);

    // Вторая перестановка mid-flight.
    P.rect = { x: 0, y: 100, width: 100, height: 100 };
    C.rect = { x: 10, y: 110, width: 20, height: 20 };
    dom.capture([P, C]); // first = аналитика (§4.2), без gBCR — см. отдельный тест
    const mark = world.ops.length;
    dom.play();

    const slice = world.ops.slice(mark);
    const measureIdx = slice
      .map((o, i) => (o.kind === 'measure' ? i : -1))
      .filter((i) => i >= 0);
    expect(measureIdx.length).toBeGreaterThanOrEqual(2); // оба узла перемеряны
    const firstMeasure = measureIdx[0];
    const lastMeasure = measureIdx[measureIdx.length - 1];

    // (а) до первого замера — только batch-clear (restore-записи), НИКАКИХ кадров.
    const clearOps = slice.slice(0, firstMeasure);
    expect(clearOps.length).toBeGreaterThan(0);
    expect(clearOps.some((o) => o.prop === 'transform')).toBe(true);
    for (const op of clearOps) {
      expect(op.kind === 'set' || op.kind === 'remove').toBe(true);
      expect((op.value ?? '').includes('translate('), 'кадр до замера').toBe(false);
    }

    // (б) замер не под нашим transform (мутация «мерить до clear» → RED).
    for (const m of slice.filter((o) => o.kind === 'measure')) {
      expect((m.inlineTransform ?? '').includes('translate('), 'замер под transform').toBe(false);
    }

    // (в) batch-measure сплошной: между первым и последним замером нет записей style.
    for (const op of slice.slice(firstMeasure, lastMeasure + 1)) {
      expect(op.kind, 'запись style внутри batch-measure').toBe('measure');
    }

    // (г) старт нового полёта — строго после завершения замеров.
    const startIdx = slice.findIndex(
      (o) => o.kind === 'set' && o.prop === 'transform' && (o.value ?? '').includes('translate('),
    );
    expect(startIdx).toBeGreaterThan(lastMeasure);
  });
});

describe('projection/dom: page-space (§2.1.4 п.4, §4.5)', () => {
  it('дельта скролла окна между capture и play не рождает фантомный translate', () => {
    const world = makeWorld();
    const clock = makeClock();
    const E = world.el('E', { x: 0, y: 0, width: 100, height: 100 }); // не двигается
    const M = world.el('M', { x: 0, y: 200, width: 50, height: 50 }); // едет на +30 по x
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([E, M]); // scroll (0,0)
    world.scroll = { x: 0, y: 100 }; // потребитель проскроллил между замерами
    M.rect = { x: 30, y: 200, width: 50, height: 50 };
    dom.play();
    clock.step(16);

    // Неподвижный элемент: ни одного ненулевого translate (фантома нет).
    for (const w of flightTransformWrites(world.writes(E))) {
      const t = parseTranslateScale(w.value!)!;
      expect(t.tx).toBeCloseTo(0, 9);
      expect(t.ty).toBeCloseTo(0, 9);
    }
    // Двигавшийся: только честная layout-дельта (−30, 0), без скролловой сотни.
    const m0 = parseTranslateScale(flightTransformWrites(world.writes(M))[0].value!)!;
    expect(m0.tx).toBeCloseTo(-30, 9);
    expect(m0.ty).toBeCloseTo(0, 9);
  });

  it('скролл ВО ВРЕМЯ полёта не влияет на кадры (transform относителен layout-боксов)', () => {
    const run = (scrollMidFlight: boolean): string[] => {
      const world = makeWorld();
      const clock = makeClock();
      const M = world.el('M', { x: 0, y: 0, width: 100, height: 100 });
      const dom = createDomProjection(domOptions(world, clock));
      dom.capture([M]);
      M.rect = { x: 150, y: 40, width: 100, height: 100 };
      dom.play();
      clock.step(16);
      if (scrollMidFlight) world.scroll = { x: 500, y: 300 };
      clock.step(16);
      clock.step(16);
      return flightTransformWrites(world.writes(M)).map((o) => o.value!);
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe('projection/dom: радиусы (§2.4 writer, §3.5 парсинг)', () => {
  it('слэш-синтаксис одной декларацией; коррекция кумулятивным k при sx≠sy', () => {
    const world = makeWorld();
    const clock = makeClock();
    const R = world.el(
      'R',
      { x: 0, y: 0, width: 100, height: 100 },
      {
        computed: {
          'border-radius': '8px 16px 12px 4px',
          'border-top-left-radius': '8px',
          'border-top-right-radius': '16px 4px', // эллиптический угол
          'border-bottom-right-radius': '12px',
          'border-bottom-left-radius': '4px',
        },
      },
    );
    const dom = createDomProjection(domOptions(world, clock));
    dom.capture([R]);
    R.rect = { x: 0, y: 0, width: 200, height: 100 }; // w ×2, h ×1 → kx ≠ ky
    dom.play();

    const writes = world
      .writes(R, 'border-radius')
      .filter((o) => o.kind === 'set');
    expect(writes.length).toBeGreaterThan(0);
    // p=0: kx = 100/200 = 0.5, ky = 1 → x-полуоси делятся на 0.5 (×2), y — нетронуты.
    expect(writes[0].value).toBe('16px 32px 24px 8px / 8px 4px 12px 4px');

    clock.step(16);
    clock.step(16);
    for (const w of world.writes(R, 'border-radius').filter((o) => o.kind === 'set')) {
      expect(w.value).toMatch(
        /^-?[\d.eE+]+px -?[\d.eE+]+px -?[\d.eE+]+px -?[\d.eE+]+px \/ -?[\d.eE+]+px -?[\d.eE+]+px -?[\d.eE+]+px -?[\d.eE+]+px$/,
      );
    }
  });

  it("шорт-чек: computed border-radius '0px' → ноль записей радиуса за весь полёт", () => {
    const world = makeWorld();
    const clock = makeClock();
    const Z = world.el('Z', { x: 0, y: 0, width: 50, height: 50 }); // default '0px'
    const dom = createDomProjection(domOptions(world, clock));
    dom.capture([Z]);
    Z.rect = { x: 100, y: 100, width: 100, height: 100 };
    dom.play();
    clock.drain(16);
    // «Ноль работы в полёте» (§2.4): ни одной ЗАПИСИ значения радиуса.
    // Restore-снятие свойства на rest (removeProperty) — не эмиссия радиуса.
    const sets = world.writes(Z, 'border-radius').filter((o) => o.kind === 'set');
    expect(sets).toEqual([]);
  });
});

describe('projection/dom: restore инлайнов (rest и cancel)', () => {
  const setup = () => {
    const world = makeWorld();
    const clock = makeClock();
    const A = world.el(
      'A',
      { x: 0, y: 0, width: 100, height: 100 },
      {
        inline: {
          transform: 'translateX(5px)',
          'transform-origin': 'center',
          'border-radius': '7px',
        },
        computed: {
          'border-radius': '8px',
          'border-top-left-radius': '8px',
          'border-top-right-radius': '8px',
          'border-bottom-right-radius': '8px',
          'border-bottom-left-radius': '8px',
        },
      },
    );
    const B = world.el('B', { x: 0, y: 200, width: 50, height: 50 }); // без инлайнов
    const dom = createDomProjection(domOptions(world, clock));
    dom.capture([A, B]);
    A.rect = { x: 300, y: 0, width: 100, height: 100 };
    B.rect = { x: 100, y: 200, width: 50, height: 50 };
    dom.play();
    return { world, clock, A, B, dom };
  };

  it('на rest прежние инлайны восстановлены (в т.ч. transform-origin), чужого не оставляем', () => {
    const { clock, A, B, dom } = setup();
    expect(A.inline.get('transform-origin')).toBe('0 0'); // в полёте наш origin
    clock.drain(16);
    expect(dom.playing).toBe(false);
    expect(A.style.getPropertyValue('transform')).toBe('translateX(5px)');
    expect(A.style.getPropertyValue('transform-origin')).toBe('center');
    expect(A.style.getPropertyValue('border-radius')).toBe('7px');
    // У элемента без прежних инлайнов наши свойства сняты подчистую.
    expect(B.style.getPropertyValue('transform')).toBe('');
    expect(B.style.getPropertyValue('transform-origin')).toBe('');
    expect(B.style.getPropertyValue('border-radius')).toBe('');
  });

  it('cancel: восстанавливает немедленно (снап в layout), полёт глушится, кадры не идут', () => {
    const { world, clock, A, B, dom } = setup();
    clock.step(16);
    dom.cancel();
    expect(dom.playing).toBe(false);
    expect(A.style.getPropertyValue('transform')).toBe('translateX(5px)');
    expect(A.style.getPropertyValue('transform-origin')).toBe('center');
    expect(A.style.getPropertyValue('border-radius')).toBe('7px');
    expect(B.style.getPropertyValue('transform')).toBe('');
    const mark = world.ops.length;
    clock.step(16);
    clock.step(16);
    expect(world.ops.length).toBe(mark); // stale-кадры инертны и после cancel
    expect(() => dom.cancel()).not.toThrow(); // идемпотентен
  });
});

describe('projection/dom: composed-обход (assignedSlot → parentElement → getRootNode().host)', () => {
  it('ребёнок за границей shadow root (host-хоп) проецируется под предком, не наивным flip', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', P_FIRST);
    // parentElement НАРОЧНО null: до P можно дойти только через getRootNode().host.
    const S = world.el('S', C_FIRST, { host: P });
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([P, S]);
    P.rect = { ...P_LAST };
    S.rect = { ...C_LAST };
    dom.play();

    // Наивный root-flip дал бы {−60, 0, 0.5, 0.5}; коррекция под предком — {0, 10, 1, 1}.
    const t = parseTranslateScale(flightTransformWrites(world.writes(S))[0].value!)!;
    expect(t.tx).toBeCloseTo(0, 9);
    expect(t.ty).toBeCloseTo(10, 9);
    expect(t.sx).toBeCloseTo(1, 9);
    expect(t.sy).toBeCloseTo(1, 9);
  });

  it('slotted-ребёнок (assignedSlot-хоп через слот в shadow) тоже находит предка', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', P_FIRST);
    // Слот живёт в shadow-дереве P (его host — P), сам не проецируется.
    const slot = world.el('slot', { x: 0, y: 0, width: 0, height: 0 }, { host: P });
    // parentElement НАРОЧНО null: подъём обязан идти через assignedSlot.
    const C2 = world.el('C2', C_FIRST, { slot });
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([P, C2]);
    P.rect = { ...P_LAST };
    C2.rect = { ...C_LAST };
    dom.play();

    const t = parseTranslateScale(flightTransformWrites(world.writes(C2))[0].value!)!;
    expect(t.tx).toBeCloseTo(0, 9);
    expect(t.ty).toBeCloseTo(10, 9);
    expect(t.sx).toBeCloseTo(1, 9);
    expect(t.sy).toBeCloseTo(1, 9);
  });
});

describe('projection/dom: capture mid-flight — аналитика вместо gBCR (§4.2)', () => {
  it('узлы активного полёта не меряются (журнал gBCR пуст), новые — меряются', () => {
    const world = makeWorld();
    const clock = makeClock();
    const P = world.el('P', P_FIRST);
    const C = world.el('C', C_FIRST, { parent: P });
    const dom = createDomProjection(domOptions(world, clock));

    dom.capture([P, C]);
    P.rect = { ...P_LAST };
    C.rect = { ...C_LAST };
    dom.play();
    clock.step(16);
    expect(dom.playing).toBe(true);

    const mP = world.measures(P).length;
    const mC = world.measures(C).length;
    const N = world.el('N', { x: 0, y: 300, width: 40, height: 40 });

    dom.capture([P, C, N]); // mid-flight: first полётных узлов = V(p̂) аналитически
    expect(world.measures(P).length, 'gBCR узла полёта на capture').toBe(mP);
    expect(world.measures(C).length, 'gBCR узла полёта на capture').toBe(mC);
    expect(world.measures(N).length).toBeGreaterThanOrEqual(1); // не-полётный — честный замер
  });
});

describe('projection/dom: play без capture — MotionParamError (текст §2.2 буквально)', () => {
  it('бросает рано с точным сообщением', () => {
    const world = makeWorld();
    const clock = makeClock();
    const dom = createDomProjection(domOptions(world, clock));
    expect(() => dom.play()).toThrow(MotionParamError);
    expect(() => dom.play()).toThrow(
      'projection.play: call capture(elements) before mutating the DOM',
    );
  });
});
