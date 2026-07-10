/**
 * test/smart-lifecycle.test.ts — enter/exit/ghost/перехват/reduce субпутя ./smart.
 * Классы: Б (контракт) + В (bite-test скорости) + Д (враждебные состояния).
 * Спека: §3.3 (enter/exit протокол), §3.4 (граница animate), §3.7 (reduce),
 * §4.1/4.2/4.3/4.9 (interruption-матрица).
 *
 * ── RED PROOF (факт от 2026-07-10, заглушка src/smart/index.ts `export {}`) ──
 * Каждый it падал «captureSmart is not a function» / «smartTransition is not a
 * function» (pick-хелпер + namespace-import) — RED for the right reason.
 * Характеризация швов ./projection (нижний describe) была ЗЕЛЁНОЙ на заглушке
 * smart — она пинит фактическое поведение уже смерженного драйвера.
 *
 * Mutation proof:
 *   - v0-потеря перехвата (v0 = 0 в driver.play / отказ от first:undefined в
 *     адаптере) → bite-test «|v_after| > 0.65·|v_before|» красный.
 *   - Потерять ghost-реинсерт (removed → ничего) → «exit: реинсерт в root»
 *     красный (нет append/writes).
 *   - Утечка reduce (transform пишется под reduce) → «reduce: matched без
 *     transform» красный; «снапнуть фейды под reduce» → «фейды анимируются»
 *     красный (ноль промежуточных opacity).
 *   - Убрать восстановление инлайнов на rest → restore-ассерты красные.
 *   - Удаление ghost ПОСЛЕ резолва finished → порядок-ассерт красный.
 */

import { describe, expect, it } from 'vitest';
import * as smart from '../src/smart/index.js';
import * as projection from '../src/projection/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  detach,
  makeClock,
  makeSmartWorld,
  pickCaptureSmart,
  pickSmartTransition,
  reduceMedia,
  type SmartWorld,
} from './smart-helpers.js';
import { parseTranslateScale, pickCreateProjection } from './projection-helpers.js';

const mod = smart as unknown as Record<string, unknown>;
const captureSmart = pickCaptureSmart(mod);
const smartTransition = pickSmartTransition(mod);

function opts(world: SmartWorld, clock: ReturnType<typeof makeClock>): Record<string, unknown> {
  return {
    requestFrame: clock.requestFrame,
    getScroll: world.getScroll,
    getComputedStyle: world.getComputedStyle,
  };
}

describe('./smart: enter (fade-in на общем клоке)', () => {
  it('opacity 0→1 возрастает по кадрам; на rest инлайн восстановлен', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    const fresh = world.el('fresh', { x: 40, y: 0, width: 10, height: 10 }, { key: 'fresh', inline: { opacity: '0.9' } });
    root.children.push(fresh);

    const handle = cap.animate();
    expect(handle.plan.entered).toEqual(['fresh']);
    clock.drain();
    await handle.finished;

    const values = world.values(fresh, 'opacity').map(Number);
    expect(values.length).toBeGreaterThan(2);
    expect(values[0]).toBe(0);
    // Хвост журнала: финальный кадр — точный identity (ровно 1), затем restore '0.9'.
    expect(values[values.length - 2]).toBe(1);
    for (const v of values) expect(Number.isFinite(v)).toBe(true);
    // Restore: прежний инлайн-opacity вернулся.
    expect(fresh.inline.get('opacity')).toBe('0.9');
    expect(fresh.inline.has('transform')).toBe(false); // enter — только фейд
  });
});

describe('./smart: exit (ghost-протокол, канон auto)', () => {
  it('реинсерт в root absolute на padding-box координатах, removeChild на rest ДО резолва finished', async () => {
    const world = makeSmartWorld();
    const b = world.el('b', { x: 40, y: 30, width: 10, height: 20 }, { key: 'b' });
    const root = world.root(
      'root',
      { x: 0, y: 0, width: 100, height: 100 },
      { children: [b], clientLeft: 3, clientTop: 2, computed: { position: 'static' } },
    );
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    detach(root, b);

    const handle = cap.animate();
    expect(handle.plan.exited).toEqual(['b']);

    // Ghost реинсертнут в root и запинен на прежнем page-rect (padding-box: минус clientLeft/Top).
    expect(world.ops.some((o) => o.el === b && o.kind === 'append')).toBe(true);
    expect(b.inline.get('position')).toBe('absolute');
    expect(b.inline.get('left')).toBe('37px');
    expect(b.inline.get('top')).toBe('28px');
    expect(b.inline.get('width')).toBe('10px');
    expect(b.inline.get('height')).toBe('20px');
    // Static root → инлайн position:relative (канон auto :227-235).
    expect(root.inline.get('position')).toBe('relative');

    let removedAtResolve = false;
    const done = handle.finished.then(() => {
      removedAtResolve = root.children.includes(b);
    });
    clock.drain();
    await done;
    // Порядок «терминальное действие до уведомлений»: ghost удалён ДО резолва.
    expect(removedAtResolve).toBe(false);
    expect(world.ops.some((o) => o.el === b && o.kind === 'removeChild')).toBe(true);

    const values = world.values(b, 'opacity').map(Number);
    expect(values[0]).toBe(1);
    expect(values[values.length - 1]).toBe(0);
  });

  it('нестатичный root НЕ получает position:relative', async () => {
    const world = makeSmartWorld();
    const b = world.el('b', { x: 10, y: 10, width: 10, height: 10 }, { key: 'b' });
    const root = world.root(
      'root',
      { x: 0, y: 0, width: 100, height: 100 },
      { children: [b], computed: { position: 'relative' } },
    );
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    detach(root, b);
    const handle = cap.animate();
    expect(root.inline.has('position')).toBe(false);
    clock.drain();
    await handle.finished;
  });

  it('exit-узел, всё ещё connected (уехал из root) → skipped, не украден', async () => {
    const world = makeSmartWorld();
    const b = world.el('b', { x: 10, y: 10, width: 10, height: 10 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [b] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));

    // Потребитель перенёс узел в ЧУЖОЙ контейнер: из root ушёл, но connected.
    const i = root.children.indexOf(b);
    root.children.splice(i, 1); // isConnected остаётся true

    const handle = cap.animate();
    expect(handle.plan.skipped).toEqual(['b']);
    expect(handle.plan.exited).toEqual([]);
    expect(world.ops.some((o) => o.el === b && o.kind === 'append')).toBe(false);
    expect(world.writes(b)).toHaveLength(0);
    await handle.finished;
  });

  it('cancel(): ghost удаляется НЕМЕДЛЕННО, инлайны сняты, идемпотентен', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const b = world.el('b', { x: 20, y: 0, width: 10, height: 10 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a, b] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    a.rect = { x: 60, y: 0, width: 10, height: 10 };
    detach(root, b);

    const handle = cap.animate();
    clock.step(16);
    expect(handle.playing).toBe(true);
    handle.cancel();
    expect(handle.playing).toBe(false);
    expect(root.children.includes(b)).toBe(false); // владение у адаптера — удалён сразу
    expect(a.inline.has('transform')).toBe(false); // снап в конечный layout
    expect(a.inline.has('transform-origin')).toBe(false);
    expect(b.inline.has('opacity')).toBe(false);
    expect(() => handle.cancel()).not.toThrow();
    await handle.finished;
  });
});

describe('./smart: перехват повторным animate (C¹ через реестр по строке-ключу)', () => {
  it('bite-test: continuity переживает ПЕРЕСОЗДАНИЕ узла; capture mid-flight не меряет узлы полёта', async () => {
    const world = makeSmartWorld();
    const el1 = world.el('el1', { x: 0, y: 0, width: 100, height: 100 }, { key: 'card' });
    const root = world.root('root', { x: 0, y: 0, width: 600, height: 600 }, { children: [el1] });
    const clock = makeClock();
    const opts1 = opts(world, clock);
    const cap1 = captureSmart(root, opts1);
    el1.rect = { x: 300, y: 0, width: 100, height: 100 };

    const h1 = cap1.animate();
    for (let i = 0; i < 5; i++) clock.step(16);

    // Скорость до перехвата: визуальный x = last.x + tx (корневой узел).
    const before = world
      .values(el1, 'transform')
      .map(parseTranslateScale)
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => 300 + t.tx);
    const vBefore = (before[before.length - 1] - before[before.length - 2]) / 0.016;
    expect(Math.abs(vBefore)).toBeGreaterThan(1);

    // capture mid-flight: узлы активного полёта НЕ меряются (аналитический V(p̂)).
    const measuresBefore = world.measures(el1).length;
    const cap2 = captureSmart(root, opts1);
    expect(world.measures(el1).length).toBe(measuresBefore);

    // «Ре-рендер»: узел пересоздан (тот же ключ, цели не менялись — теорема C¹).
    root.children.length = 0;
    el1.isConnected = false;
    const el2 = world.el('el2', { x: 300, y: 0, width: 100, height: 100 }, { key: 'card' });
    root.children.push(el2);

    const h2 = cap2.animate();
    await h1.finished; // finished прерванного резолвится (не-natural)

    // C⁰: первый синхронный кадр нового полёта = визуальный бокс старого.
    const after = world
      .values(el2, 'transform')
      .map(parseTranslateScale)
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => 300 + t.tx);
    expect(after[0]).toBeCloseTo(before[before.length - 1], 6);

    // C¹ bite-test (канон test/motion-value.test.ts): скорость не потеряна.
    clock.step(16);
    clock.step(16);
    const after2 = world
      .values(el2, 'transform')
      .map(parseTranslateScale)
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => 300 + t.tx);
    const vAfter = (after2[2] - after2[1]) / 0.016;
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(vBefore));

    clock.drain();
    await h2.finished;
    expect(el2.inline.has('transform')).toBe(false); // restore нового узла
  });

  it('ghost старого полёта переносится: фейд продолжается с текущей opacity без прыжка', async () => {
    const world = makeSmartWorld();
    const b = world.el('b', { x: 10, y: 10, width: 10, height: 10 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [b] });
    const clock = makeClock();
    const o = opts(world, clock);
    const cap1 = captureSmart(root, o);
    detach(root, b);

    const h1 = cap1.animate();
    for (let i = 0; i < 4; i++) clock.step(16);
    const mid = world.values(b, 'opacity').map(Number);
    const lastMid = mid[mid.length - 1];
    expect(lastMid).toBeLessThan(1);
    expect(lastMid).toBeGreaterThan(0);

    // Повторный цикл: ключ всё ещё отсутствует → ghost переносится в новый полёт.
    const cap2 = captureSmart(root, o);
    const h2 = cap2.animate();
    await h1.finished;

    const all = world.values(b, 'opacity').map(Number);
    // Первый кадр нового полёта — ровно текущая аналитическая opacity (без прыжка к 1).
    expect(all[mid.length]).toBeCloseTo(lastMid, 12);

    clock.drain();
    await h2.finished;
    expect(root.children.includes(b)).toBe(false);
  });

  it('реинкарнация: ключ вернулся при живом ghost — ghost снят, узел matched от его состояния', async () => {
    const world = makeSmartWorld();
    const b = world.el('b', { x: 10, y: 10, width: 20, height: 20 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [b] });
    const clock = makeClock();
    const o = opts(world, clock);
    const cap1 = captureSmart(root, o);
    detach(root, b);

    const h1 = cap1.animate();
    for (let i = 0; i < 4; i++) clock.step(16);
    const ghostOpacity = world.values(b, 'opacity').map(Number).pop()!;
    expect(ghostOpacity).toBeGreaterThan(0);

    const cap2 = captureSmart(root, o);
    // Реинкарнация НОВЫМ узлом с тем же ключом на новом месте.
    const b2 = world.el('b2', { x: 100, y: 100, width: 40, height: 40 }, { key: 'b' });
    root.children.push(b2);

    const h2 = cap2.animate();
    await h1.finished;

    expect(h2.plan.matched).toEqual(['b']);
    expect(h2.plan.entered).toEqual([]);
    // Ghost физически удалён немедленно (не на rest).
    expect(root.children.includes(b)).toBe(false);
    // Узел стартует от бокса ghost'а (10,10,20,20) → морф к (100,100,40,40).
    const first = parseTranslateScale(b2.inline.get('transform') ?? '')!;
    expect(100 + first.tx).toBeCloseTo(10, 6);
    expect(first.sx).toBeCloseTo(0.5, 6);
    // Opacity продолжает с текущего значения ghost'а к 1 (без прыжка).
    const firstOpacity = world.values(b2, 'opacity').map(Number)[0];
    expect(firstOpacity).toBeCloseTo(ghostOpacity, 12);

    clock.drain();
    await h2.finished;
  });
});

describe('./smart: reduced-motion (character-switch, канон auto §3.7)', () => {
  it('matched НЕ пишет transform; enter/exit-фейды ЖИВЫЕ (не снап); tier = reduced', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const b = world.el('b', { x: 20, y: 0, width: 10, height: 10 }, { key: 'b' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a, b] });
    const clock = makeClock();
    const cap = captureSmart(root, { ...opts(world, clock), matchMedia: reduceMedia(true) });

    a.rect = { x: 60, y: 0, width: 10, height: 10 };
    detach(root, b);
    const fresh = world.el('fresh', { x: 40, y: 40, width: 10, height: 10 }, { key: 'fresh' });
    root.children.push(fresh);

    const handle = cap.animate();
    expect(handle.tier).toBe('reduced');
    expect(handle.plan.matched).toEqual(['a']);
    clock.drain();
    await handle.finished;

    // Matched — снап: транспорта нет вовсе.
    expect(world.writes(a)).toHaveLength(0);
    // Фейды — живые: промежуточные значения существуют (не только 0 и 1).
    const enterValues = world.values(fresh, 'opacity').map(Number);
    expect(enterValues.length).toBeGreaterThan(2);
    expect(enterValues.some((v) => v > 0 && v < 1)).toBe(true);
    const exitValues = world.values(b, 'opacity').map(Number);
    expect(exitValues.some((v) => v > 0 && v < 1)).toBe(true);
    expect(root.children.includes(b)).toBe(false); // ghost удалён на rest
  });

  it('respectReducedMotion: false игнорирует reduce (matched едет transform-ом)', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 10, height: 10 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a] });
    const clock = makeClock();
    const cap = captureSmart(root, {
      ...opts(world, clock),
      matchMedia: reduceMedia(true),
      respectReducedMotion: false,
    });
    a.rect = { x: 60, y: 0, width: 10, height: 10 };
    const handle = cap.animate();
    expect(handle.tier).toBe('projection');
    expect(world.writes(a, 'transform').length).toBeGreaterThan(0);
    clock.drain();
    await handle.finished;
  });
});

describe('./smart: smartTransition (capture → mutate → animate)', () => {
  it('sync mutate: узлы доезжают, handle живой синхронно', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 20, height: 20 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [a] });
    const clock = makeClock();
    const handle = smartTransition(
      root,
      () => {
        a.rect = { x: 100, y: 0, width: 20, height: 20 };
      },
      opts(world, clock),
    );
    expect(handle.plan.matched).toEqual(['a']);
    expect(handle.playing).toBe(true);
    clock.drain();
    await handle.finished;
    expect(a.inline.has('transform')).toBe(false);
  });

  it('async mutate: handle синхронный фасад, переход подвязывается после await', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 20, height: 20 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [a] });
    const clock = makeClock();
    const handle = smartTransition(
      root,
      async () => {
        a.rect = { x: 100, y: 0, width: 20, height: 20 };
      },
      opts(world, clock),
    );
    expect(handle.playing).toBe(false); // до подвязки
    expect(handle.plan.matched).toEqual([]);
    await Promise.resolve(); // микротик — mutate await'нут, внутренний animate стартовал
    expect(handle.plan.matched).toEqual(['a']);
    expect(handle.playing).toBe(true);
    clock.drain();
    await handle.finished;
  });

  it('cancel() до подвязки async mutate: внутренний переход не стартует, finished резолвится', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 0, y: 0, width: 20, height: 20 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [a] });
    const clock = makeClock();
    const handle = smartTransition(
      root,
      async () => {
        a.rect = { x: 100, y: 0, width: 20, height: 20 };
      },
      opts(world, clock),
    );
    handle.cancel();
    await handle.finished;
    await Promise.resolve();
    await Promise.resolve();
    expect(world.writes(a)).toHaveLength(0); // ни одного кадра
    expect(handle.playing).toBe(false);
  });
});

describe('./smart: радиусы matched-узлов (морф + коррекция масштаба)', () => {
  it('border-radius пишется слэш-синтаксисом и восстанавливается на rest', async () => {
    const world = makeSmartWorld();
    const a = world.el(
      'a',
      { x: 0, y: 0, width: 20, height: 20 },
      {
        key: 'a',
        computed: {
          'border-radius': '8px',
          'border-top-left-radius': '8px',
          'border-top-right-radius': '8px',
          'border-bottom-right-radius': '8px',
          'border-bottom-left-radius': '8px',
        },
      },
    );
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [a] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    a.rect = { x: 100, y: 0, width: 40, height: 40 };

    const handle = cap.animate();
    clock.drain();
    await handle.finished;

    const radii = world.values(a, 'border-radius');
    expect(radii.length).toBeGreaterThan(0);
    for (const v of radii) {
      expect(v).toContain(' / ');
      for (const n of v.replaceAll('px', '').replaceAll('/', ' ').trim().split(/\s+/).map(Number)) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    }
    expect(a.inline.has('border-radius')).toBe(false); // restore
  });

  it('radius: false выключает слой радиусов (ноль border-radius записей)', async () => {
    const world = makeSmartWorld();
    const a = world.el(
      'a',
      { x: 0, y: 0, width: 20, height: 20 },
      { key: 'a', computed: { 'border-radius': '8px', 'border-top-left-radius': '8px', 'border-top-right-radius': '8px', 'border-bottom-right-radius': '8px', 'border-bottom-left-radius': '8px' } },
    );
    const root = world.root('root', { x: 0, y: 0, width: 200, height: 200 }, { children: [a] });
    const clock = makeClock();
    const cap = captureSmart(root, { ...opts(world, clock), radius: false });
    a.rect = { x: 100, y: 0, width: 40, height: 40 };
    const handle = cap.animate();
    clock.drain();
    await handle.finished;
    expect(world.values(a, 'border-radius')).toHaveLength(0);
  });
});

describe('./smart: page-space (скролл между capture и animate не рождает фантомный translate)', () => {
  it('дельта скролла окна без мутации → пустой диф', async () => {
    const world = makeSmartWorld();
    const a = world.el('a', { x: 10, y: 10, width: 10, height: 10 }, { key: 'a' });
    const root = world.root('root', { x: 0, y: 0, width: 100, height: 100 }, { children: [a] });
    const clock = makeClock();
    const cap = captureSmart(root, opts(world, clock));
    world.scroll = { x: 120, y: 340 }; // скролл окна, layout не менялся
    const handle = cap.animate();
    expect(handle.plan.matched).toEqual([]);
    expect(world.writes(a)).toHaveLength(0);
    await handle.finished;
  });
});

describe('швы ./projection (характеризация фактического поведения драйвера)', () => {
  const pmod = projection as unknown as Record<string, unknown>;

  it('play(first: undefined) на незнакомый id → MotionParamError с фактическим текстом', () => {
    const controls = pickCreateProjection(pmod)();
    expect(() =>
      controls.play([{ id: 'ghost', last: { x: 0, y: 0, width: 10, height: 10 } }]),
    ).toThrowError(
      'projection.play: node "ghost" has no "first" and no active flight to pick up from',
    );
  });

  it('pickup ребейзит opacity-канал аналитически (from\' = lerp по clamp01(p̂))', () => {
    const clock = makeClock();
    const frames: Array<number | undefined> = [];
    const controls = pickCreateProjection(pmod)({
      requestFrame: clock.requestFrame,
      onFrame: (fs: ReadonlyArray<{ opacity?: number }>) => frames.push(fs[0]?.opacity),
    });
    const r = { x: 0, y: 0, width: 10, height: 10 };
    controls.play([{ id: 'g', first: r, last: r, anchor: r, opacity: { from: 1, to: 0 } }]);
    clock.step(16);
    clock.step(16);
    const current = frames[frames.length - 1]!;
    expect(current).toBeLessThan(1);
    // Перехват: цели прежние; первый кадр нового полёта продолжает ровно с current.
    controls.play([{ id: 'g', last: r, anchor: r, opacity: { from: 1, to: 0 } }]);
    expect(frames[frames.length - 1]).toBeCloseTo(current, 12);
  });

  it('boxAt в полёте — аналитический mixBox (без чтения DOM), публичный progress ∈ [0,1]', () => {
    const clock = makeClock();
    const controls = pickCreateProjection(pmod)({ requestFrame: clock.requestFrame });
    controls.play([
      {
        id: 'n',
        first: { x: 0, y: 0, width: 100, height: 100 },
        last: { x: 100, y: 0, width: 100, height: 100 },
      },
    ]);
    clock.step(16);
    const box = controls.boxAt('n')!;
    expect(box.x).toBeGreaterThan(0);
    expect(box.x).toBeLessThan(100 + 60); // overshoot допустим, но конечен
    expect(controls.progress).toBeGreaterThanOrEqual(0);
    expect(controls.progress).toBeLessThanOrEqual(1);
    controls.cancel();
  });
});
