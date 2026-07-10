/**
 * test/projection-geometry.test.ts — чистая математика ./projection (geometry.ts).
 * Класс: А (формулы, differential-оракулы) + Д (mutation-proof).
 * Спека: §2.1 (модель, замкнутая форма §2.1.2, числовой пример §2.1.3,
 * стражи/деградации §2.1.4, резолв §2.1.5), §2.2 (сигнатуры), §7.2.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Namespace-import + pick-хелперы (канон test/animate-facade-helpers.ts:9-31) —
 * на заглушке src/projection каждый it падал бы СВОИМ ассертом класса
 * «mixBox is not a function», а не link-ошибкой всего файла: RED for the
 * right reason.
 *
 * Mutation proof:
 *   - Перепутать знак anchor-разности (B_A.pos − B_c.pos вместо B_c.pos − B_A.pos)
 *     → пин §2.1.3 (ty = 10/3) красный.
 *   - Наивный child-flip без деления на k_A → пин §2.1.3 (tx=0, sx=1) красный
 *     (наив даёт tx=−30, sx=0.75 — искажение из спеки).
 *   - Убрать живой вызов counterScale (cs := 1) → блок «статичный ребёнок» красный.
 *   - k как произведение по цепочке вместо локального V/B (или k_c := k_A) →
 *     рендер-проверка цепочки глубины 4 красная.
 *   - Убрать floor размеров в mixBox → отрицательный scale при overshoot →
 *     блок «floor размеров» красный.
 *   - Сломать топосорт (порядок входа вместо родитель-раньше-ребёнка) →
 *     order-пин красный.
 *   - Перепутать first/last в mixBox → p=0 ≠ first → пин §2.1.3 красный.
 *   - Убрать коррекцию радиуса кумулятивным k → radii-блок (sx≠sy) красный.
 */

import { describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import { computeFlip, flipAt, correctRadius, counterScale } from '../src/flip/index.js';
import {
  pickCornerRadiusAt,
  pickCreateProjector,
  pickMixBox,
  pickProjectAt,
  type BoxRadiiLike,
  type ProjectionFrameLike,
  type RectLike,
} from './projection-helpers.js';

const mod = projection as unknown as Record<string, unknown>;
const mixBox = pickMixBox(mod);
const projectAt = pickProjectAt(mod);
const cornerRadiusAt = pickCornerRadiusAt(mod);
const createProjector = pickCreateProjector(mod);

// ─── Локальный оракул: raw-путь flipAt (семантика src/flip/index.ts:108-118) ──
// flipAt публично клампит p; для сетки с overshoot оракул — та же формула без
// клампа (локальная копия ~10 строк, прецедент самих локальных стражей flip).

function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

function rawFlipAt(
  inv: { dx: number; dy: number; sx: number; sy: number },
  p: number,
): { tx: number; ty: number; sx: number; sy: number } {
  const t = Number.isNaN(p) ? 0 : p;
  const inv1 = 1 - t;
  return {
    tx: finite(inv.dx * inv1) + 0,
    ty: finite(inv.dy * inv1) + 0,
    sx: finite(inv.sx + (1 - inv.sx) * t) + 0,
    sy: finite(inv.sy + (1 - inv.sy) * t) + 0,
  };
}

// ─── Рендер-модель (§2.1.1): Φ(q) = V.pos + k ⊙ (q − B.pos), origin '0 0' ─────

interface BoxMap {
  vx: number;
  vy: number;
  bx: number;
  by: number;
  kx: number;
  ky: number;
}

const IDENTITY_MAP: BoxMap = { vx: 0, vy: 0, bx: 0, by: 0, kx: 1, ky: 1 };

/** Рендерит узел (anchor B + локальный transform кадра) под картой предка. */
function renderNode(
  map: BoxMap,
  anchor: RectLike,
  f: { tx: number; ty: number; sx: number; sy: number },
): { box: RectLike; map: BoxMap } {
  const x = map.vx + map.kx * (anchor.x + f.tx - map.bx);
  const y = map.vy + map.ky * (anchor.y + f.ty - map.by);
  const kx = map.kx * f.sx;
  const ky = map.ky * f.sy;
  const box = { x, y, width: kx * anchor.width, height: ky * anchor.height };
  return { box, map: { vx: x, vy: y, bx: anchor.x, by: anchor.y, kx, ky } };
}

// ─── §2.1.3: числовой пример (обязательный пин) ──────────────────────────────

const P_F = { x: 0, y: 0, width: 100, height: 100 };
const P_L = { x: 50, y: 0, width: 200, height: 200 };
const C_F = { x: 10, y: 10, width: 20, height: 20 };
const C_L = { x: 70, y: 10, width: 40, height: 40 };
const PARENT = { first: P_F, last: P_L };
const CHILD = { first: C_F, last: C_L };

describe('projection/geometry: числовой пример §2.1.3 (пин)', () => {
  it('p=0.5: parent (корень) → {tx:−25, ty:0, sx:0.75, sy:0.75}, сверка flipAt', () => {
    const t = projectAt(PARENT, null, 0.5);
    expect(t.tx).toBe(-25);
    expect(t.ty).toBe(0);
    expect(t.sx).toBe(0.75);
    expect(t.sy).toBe(0.75);
    // Сверка спеки: dx=−50 → tx=−25; sxInv=0.5 → 0.75 (живой оракул ./flip).
    const oracle = flipAt(computeFlip(P_F, P_L), 0.5);
    expect(t.tx).toBe(oracle.tx);
    expect(t.sx).toBe(oracle.sx);
  });

  it('p=0.5: child → {tx:0, ty:10/3, sx:1, sy:1}', () => {
    const t = projectAt(CHILD, PARENT, 0.5);
    expect(t.tx).toBe(0); // (40−25)/0.75 − 20 = 0 (и −0 схлопнут: Object.is-пин toBe)
    expect(t.ty).toBeCloseTo(10 / 3, 12); // 10/0.75 − 10 = 10/3 ≈ 3.3333
    expect(t.sx).toBeCloseTo(1, 12); // (30/40)/0.75 = 1
    expect(t.sy).toBeCloseTo(1, 12);
  });

  it('p=0: child → {tx:0, ty:10, sx:1, sy:1}; рендер даёт ровно F_C', () => {
    const t = projectAt(CHILD, PARENT, 0);
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(10);
    expect(t.sx).toBe(1);
    expect(t.sy).toBe(1);
    // Рендер: под картой родителя на p=0 ребёнок стоит ровно на F_C=(10,10,20,20).
    const pT = projectAt(PARENT, null, 0);
    const { map } = renderNode(IDENTITY_MAP, P_L, pT);
    const { box } = renderNode(map, C_L, t);
    expect(box.x).toBeCloseTo(10, 12);
    expect(box.y).toBeCloseTo(10, 12);
    expect(box.width).toBeCloseTo(20, 12);
    expect(box.height).toBeCloseTo(20, 12);
  });

  it('p=1: child → identity {0, 0, 1, 1}', () => {
    const t = projectAt(CHILD, PARENT, 1);
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
    expect(t.sx).toBe(1);
    expect(t.sy).toBe(1);
  });

  it('рендер-проверка спеки: p=0.5 → child визуально на V_C=(40,10,30,30)', () => {
    const pT = projectAt(PARENT, null, 0.5);
    const cT = projectAt(CHILD, PARENT, 0.5);
    const { map } = renderNode(IDENTITY_MAP, P_L, pT);
    const { box } = renderNode(map, C_L, cT);
    expect(box.x).toBeCloseTo(40, 12);
    expect(box.y).toBeCloseTo(10, 12);
    expect(box.width).toBeCloseTo(30, 12);
    expect(box.height).toBeCloseTo(30, 12);
  });

  it('наивный child-flip без коррекции (tx=−30, sx=0.75) отвергнут — искажение поймано', () => {
    const naive = flipAt(computeFlip(C_F, C_L), 0.5);
    expect(naive.tx).toBe(-30); // документация гэпа из спеки
    expect(naive.sx).toBe(0.75);
    const t = projectAt(CHILD, PARENT, 0.5);
    expect(Math.abs(t.tx - naive.tx)).toBeGreaterThan(1);
    expect(Math.abs(t.sx - naive.sx)).toBeGreaterThan(0.1);
  });
});

// ─── Differential-оракул корня: projectAt(node, null, p) ≡ flipAt ────────────

describe('projection/geometry: differential корня ≡ flipAt(computeFlip) бит-в-бит', () => {
  const F = { x: 0, y: 0, width: 100, height: 100 };
  const L = { x: 200, y: 50, width: 200, height: 50 };
  const node = { first: F, last: L };
  const inv = computeFlip(F, L);
  // Сетка p ∈ {−0.2 … 1.15} с шагом 0.05 (28 точек), включая overshoot.
  const grid: number[] = [];
  for (let i = 0; i <= 27; i++) grid.push((-20 + 5 * i) / 100);

  it('оракул совпадает с публичным flipAt на p ∈ [0,1] (валидность копии raw-пути)', () => {
    for (const p of grid) {
      if (p < 0 || p > 1) continue;
      const raw = rawFlipAt(inv, p);
      const pub = flipAt(inv, p);
      expect(raw.tx, `p=${p}`).toBe(pub.tx);
      expect(raw.ty, `p=${p}`).toBe(pub.ty);
      expect(raw.sx, `p=${p}`).toBe(pub.sx);
      expect(raw.sy, `p=${p}`).toBe(pub.sy);
    }
  });

  it('projectAt(node, null, p) ≡ оракулу бит-в-бит по всей сетке (включая overshoot)', () => {
    for (const p of grid) {
      const expected = rawFlipAt(inv, p);
      const t = projectAt(node, null, p);
      // toBe = Object.is: заодно пинит схлоп −0 (P1).
      expect(t.tx, `tx@p=${p}`).toBe(expected.tx);
      expect(t.ty, `ty@p=${p}`).toBe(expected.ty);
      expect(t.sx, `sx@p=${p}`).toBe(expected.sx);
      expect(t.sy, `sy@p=${p}`).toBe(expected.sy);
    }
  });

  it('overshoot реален: p=1.15 НЕ identity (mixBox p не клампится)', () => {
    const t = projectAt(node, null, 1.15);
    expect(Math.abs(t.tx)).toBeGreaterThan(1);
    const v = mixBox(F, L, -0.2);
    expect(v.x).toBeCloseTo(-40, 12); // экстраполяция ниже first
  });
});

// ─── Статичный ребёнок ≡ counterScale (вырожденный случай формулы) ───────────

describe('projection/geometry: статичный ребёнок ≡ counterScale(k_A)', () => {
  const PF = { x: 0, y: 0, width: 100, height: 100 };
  const PL = { x: 0, y: 0, width: 200, height: 50 };
  const S = { x: 10, y: 10, width: 30, height: 30 };
  const parent = { first: PF, last: PL };
  const child = { first: S, last: S };

  it('s_c = counterScale(k_A) бит-в-бит (живой вызов ./flip)', () => {
    for (const p of [0, 0.25, 0.5, 1, 1.1]) {
      const vp = mixBox(PF, PL, p);
      const cs = counterScale(vp.width / PL.width, vp.height / PL.height);
      const t = projectAt(child, parent, p);
      expect(t.sx, `sx@p=${p}`).toBe(cs.sx);
      expect(t.sy, `sy@p=${p}`).toBe(cs.sy);
    }
  });

  it('рендер: статичный ребёнок визуально не двигается и не искажается', () => {
    for (const p of [0.25, 0.5, 0.75, 1.1]) {
      const pT = projectAt(parent, null, p);
      const cT = projectAt(child, parent, p);
      const { map } = renderNode(IDENTITY_MAP, PL, pT);
      const { box } = renderNode(map, S, cT);
      expect(box.x, `x@p=${p}`).toBeCloseTo(10, 12);
      expect(box.y, `y@p=${p}`).toBeCloseTo(10, 12);
      expect(box.width, `w@p=${p}`).toBeCloseTo(30, 12);
      expect(box.height, `h@p=${p}`).toBeCloseTo(30, 12);
    }
  });
});

// ─── Цепочка глубины 4: индукция схлопывается, рендер ≤ 1e-12 ────────────────

describe('projection/geometry: цепочка глубины 4 (createProjector, рендер-проверка)', () => {
  const boxes = {
    root: { first: { x: 0, y: 0, width: 100, height: 100 }, last: { x: 40, y: 20, width: 160, height: 80 } },
    a: { first: { x: 10, y: 10, width: 30, height: 30 }, last: { x: 60, y: 30, width: 60, height: 20 } },
    b: { first: { x: 12, y: 14, width: 10, height: 10 }, last: { x: 70, y: 35, width: 20, height: 10 } },
    c: { first: { x: 13, y: 15, width: 4, height: 4 }, last: { x: 74, y: 37, width: 8, height: 5 } },
  } as const;
  // Вход НАРОЧНО ребёнок-раньше-родителя: топосорт обязан выправить порядок.
  const nodes = [
    { id: 'c', parent: 'b', ...boxes.c },
    { id: 'b', parent: 'a', ...boxes.b },
    { id: 'root', ...boxes.root },
    { id: 'a', parent: 'root', ...boxes.a },
  ];
  const parentOf: Record<string, string | null> = { root: null, a: 'root', b: 'a', c: 'b' };

  it('order-пин: родитель строго раньше ребёнка при любом порядке входа', () => {
    const projector = createProjector(nodes);
    expect([...projector.order].sort()).toEqual(['a', 'b', 'c', 'root']);
    for (const [id, parent] of Object.entries(parentOf)) {
      if (parent === null) continue;
      expect(
        projector.order.indexOf(parent),
        `${parent} раньше ${id}`,
      ).toBeLessThan(projector.order.indexOf(id));
    }
  });

  it('кадры идут в порядке order (родитель раньше ребёнка в самом массиве)', () => {
    const projector = createProjector(nodes);
    const frames = projector.at(0.5);
    expect(frames.map((f) => f.id)).toEqual([...projector.order]);
  });

  it('рендер каждого узла = mixBox(F,L,p) с точностью 1e-12 (включая overshoot)', () => {
    const projector = createProjector(nodes);
    for (const p of [-0.2, 0, 0.3, 0.5, 0.75, 1, 1.1]) {
      const frames = projector.at(p);
      const maps = new Map<string, BoxMap>();
      for (const f of frames) {
        const own = boxes[f.id as keyof typeof boxes];
        const parent = parentOf[f.id];
        const parentMap = parent === null ? IDENTITY_MAP : maps.get(parent!)!;
        const { box, map } = renderNode(parentMap, own.last, f);
        maps.set(f.id, map);
        const v = mixBox(own.first, own.last, p);
        expect(Math.abs(box.x - v.x), `${f.id}.x@p=${p}`).toBeLessThanOrEqual(1e-12);
        expect(Math.abs(box.y - v.y), `${f.id}.y@p=${p}`).toBeLessThanOrEqual(1e-12);
        expect(Math.abs(box.width - v.width), `${f.id}.w@p=${p}`).toBeLessThanOrEqual(1e-12);
        expect(Math.abs(box.height - v.height), `${f.id}.h@p=${p}`).toBeLessThanOrEqual(1e-12);
        // Кумулятивный k кадра = произведению локальных s по цепочке (индукция §2.1.2).
        expect(Math.abs(f.kx - map.kx), `${f.id}.kx@p=${p}`).toBeLessThanOrEqual(1e-12);
        expect(Math.abs(f.ky - map.ky), `${f.id}.ky@p=${p}`).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it('внуку достаточно ближайшего проецирующего предка: projectAt(b, a, p) ≡ кадру', () => {
    const projector = createProjector(nodes);
    for (const p of [0.25, 0.8]) {
      const frames = projector.at(p);
      const fb = frames.find((f) => f.id === 'b')!;
      const t = projectAt(boxes.b, boxes.a, p);
      expect(fb.tx, `tx@p=${p}`).toBeCloseTo(t.tx, 12);
      expect(fb.ty, `ty@p=${p}`).toBeCloseTo(t.ty, 12);
      expect(fb.sx, `sx@p=${p}`).toBeCloseTo(t.sx, 12);
      expect(fb.sy, `sy@p=${p}`).toBeCloseTo(t.sy, 12);
    }
  });
});

// ─── anchor ≠ last: кроссфейд-геометрия ──────────────────────────────────────

describe('projection/geometry: anchor ≠ last (кроссфейд-ghost)', () => {
  const F_OLD = { x: 0, y: 0, width: 100, height: 50 };
  const L_NEW = { x: 300, y: 120, width: 50, height: 100 };
  const ghost = { first: F_OLD, last: L_NEW, anchor: F_OLD };
  const fresh = { first: F_OLD, last: L_NEW, anchor: L_NEW };

  it('ghost (anchor=first): p=0 → identity (стоит ровно на F_old)', () => {
    const t = projectAt(ghost, null, 0);
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
    expect(t.sx).toBe(1);
    expect(t.sy).toBe(1);
  });

  it('ghost: p=1 → унесён ровно в L_new (t = L−F, s = размерное отношение)', () => {
    const t = projectAt(ghost, null, 1);
    expect(t.tx).toBe(300);
    expect(t.ty).toBe(120);
    expect(t.sx).toBe(0.5); // 50/100
    expect(t.sy).toBe(2); // 100/50
  });

  it('новый узел (anchor=last, default): p=0 → на F_old, p=1 → identity', () => {
    const t0 = projectAt(fresh, null, 0);
    expect(t0.tx).toBe(-300);
    expect(t0.ty).toBe(-120);
    expect(t0.sx).toBe(2); // 100/50
    expect(t0.sy).toBe(0.5); // 50/100
    const t1 = projectAt(fresh, null, 1);
    expect(t1.tx).toBe(0);
    expect(t1.ty).toBe(0);
    expect(t1.sx).toBe(1);
    expect(t1.sy).toBe(1);
    // anchor опущен = last (default §2.1.1) — та же геометрия.
    const tDefault = projectAt({ first: F_OLD, last: L_NEW }, null, 0);
    expect(tDefault.tx).toBe(t0.tx);
    expect(tDefault.sx).toBe(t0.sx);
  });

  it('оба узла рендерятся в ОДИН интерполируемый бокс на каждом p', () => {
    for (const p of [0.25, 0.5, 0.75]) {
      const v = mixBox(F_OLD, L_NEW, p);
      const tg = projectAt(ghost, null, p);
      const tf = projectAt(fresh, null, p);
      const g = renderNode(IDENTITY_MAP, F_OLD, tg).box;
      const n = renderNode(IDENTITY_MAP, L_NEW, tf).box;
      for (const [label, got] of [
        ['ghost', g],
        ['fresh', n],
      ] as const) {
        expect(got.x, `${label}.x@p=${p}`).toBeCloseTo(v.x, 12);
        expect(got.y, `${label}.y@p=${p}`).toBeCloseTo(v.y, 12);
        expect(got.width, `${label}.w@p=${p}`).toBeCloseTo(v.width, 12);
        expect(got.height, `${label}.h@p=${p}`).toBeCloseTo(v.height, 12);
      }
    }
  });
});

// ─── Degenerate: снап и переякоривание детей (§2.1.4 п.1) ────────────────────

describe('projection/geometry: degenerate-предок — снап и переякоривание', () => {
  const rootB = { first: { x: 0, y: 0, width: 100, height: 100 }, last: { x: 0, y: 0, width: 200, height: 200 } };
  const midB = { first: { x: 10, y: 10, width: 50, height: 50 }, last: { x: 20, y: 20, width: 0, height: 0 } };
  const childB = { first: { x: 12, y: 12, width: 10, height: 10 }, last: { x: 30, y: 30, width: 20, height: 20 } };

  const nodes = [
    { id: 'root', ...rootB },
    { id: 'mid', parent: 'root', ...midB, opacity: { from: 0.25, to: 0.8 } },
    { id: 'child', parent: 'mid', ...childB },
  ];

  it('вырожденный anchor (0×0): frame.degenerate=true, transform-нейтраль, opacity снапнут к to', () => {
    const projector = createProjector(nodes);
    const frames = projector.at(0.5);
    const mid = frames.find((f) => f.id === 'mid')!;
    expect(mid.degenerate).toBe(true);
    expect(mid.tx).toBe(0);
    expect(mid.ty).toBe(0);
    expect(mid.sx).toBe(1);
    expect(mid.sy).toBe(1);
    expect(mid.kx).toBe(1);
    expect(mid.ky).toBe(1);
    expect(mid.opacity).toBe(0.8);
    expect(mid.radii).toBeUndefined();
    const root = frames.find((f) => f.id === 'root')!;
    expect(root.degenerate).toBe(false);
  });

  it('дети переякорены к следующему невырожденному предку: child ≡ projectAt(child, root, p)', () => {
    const projector = createProjector(nodes);
    for (const p of [0, 0.5, 1, 1.1]) {
      const child = projector.at(p).find((f) => f.id === 'child')!;
      const t = projectAt(childB, rootB, p);
      expect(child.degenerate, `deg@p=${p}`).toBe(false);
      expect(child.tx, `tx@p=${p}`).toBeCloseTo(t.tx, 12);
      expect(child.ty, `ty@p=${p}`).toBeCloseTo(t.ty, 12);
      expect(child.sx, `sx@p=${p}`).toBeCloseTo(t.sx, 12);
      expect(child.sy, `sy@p=${p}`).toBeCloseTo(t.sy, 12);
    }
  });

  it('нефинитный anchor тоже degenerate (страж на precompute)', () => {
    const projector = createProjector([
      {
        id: 'bad',
        first: { x: 0, y: 0, width: 10, height: 10 },
        last: { x: 0, y: 0, width: 20, height: 20 },
        anchor: { x: 0, y: 0, width: NaN, height: 100 },
      },
    ]);
    const [f] = projector.at(0.5);
    expect(f.degenerate).toBe(true);
    expect(f.sx).toBe(1);
  });
});

// ─── Floor размеров при overshoot (P1: без зеркалирования) ───────────────────

describe('projection/geometry: floor размеров при overshoot', () => {
  it('mixBox: размер флорится в 0 (не отрицательный, не −0), позиция overshoot честная', () => {
    const F = { x: 0, y: 0, width: 100, height: 100 };
    const L = { x: 50, y: 50, width: 10, height: 10 };
    const v = mixBox(F, L, 1.15); // w: 100 + 1.15·(−90) = −3.5 → floor 0
    expect(v.width).toBe(0);
    expect(v.height).toBe(0);
    expect(Object.is(v.width, -0)).toBe(false);
    expect(Object.is(v.height, -0)).toBe(false);
    expect(v.x).toBeCloseTo(57.5, 12); // позиция НЕ флорится
  });

  it('projectAt: overshoot схлопнутого размера → scale 0, не отрицательный (мутация floor → RED)', () => {
    const node = {
      first: { x: 0, y: 0, width: 100, height: 100 },
      last: { x: 50, y: 50, width: 10, height: 10 },
    };
    const t = projectAt(node, null, 1.15);
    expect(t.sx).toBe(0);
    expect(t.sy).toBe(0);
    expect(t.sx).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(t.tx)).toBe(true);
    expect(Number.isFinite(t.ty)).toBe(true);
  });
});

// ─── Радиусы: морф + коррекция кумулятивным k при sx ≠ sy ────────────────────

describe('projection/geometry: cornerRadiusAt (морф + correctRadius per-axis)', () => {
  it('differential: cornerRadiusAt ≡ живому correctRadius на лерпнутом радиусе', () => {
    const first = { x: 8, y: 8 };
    const last = { x: 16, y: 4 };
    const c = cornerRadiusAt(first, last, 2, 0.5, 0.5); // lerp → {12, 6}
    expect(c.x).toBe(correctRadius(12, 2, 0.5).x); // 12/2 = 6
    expect(c.y).toBe(correctRadius(6, 2, 0.5).y); // 6/0.5 = 12
    expect(c.x).toBeCloseTo(6, 12);
    expect(c.y).toBeCloseTo(12, 12);
  });

  it('прогресс радиуса КЛАМПИТСЯ (overshoot на радиус не транслируем)', () => {
    const first = { x: 8, y: 8 };
    const last = { x: 16, y: 4 };
    const over = cornerRadiusAt(first, last, 1, 1, 1.5);
    const atOne = cornerRadiusAt(first, last, 1, 1, 1);
    expect(over.x).toBe(atOne.x);
    expect(over.y).toBe(atOne.y);
    const under = cornerRadiusAt(first, last, 1, 1, -0.5);
    const atZero = cornerRadiusAt(first, last, 1, 1, 0);
    expect(under.x).toBe(atZero.x);
    expect(under.y).toBe(atZero.y);
  });

  it('floor 0: отрицательный лерпнутый радиус не эмитится (и не −0)', () => {
    const c = cornerRadiusAt({ x: 0, y: 2 }, { x: -8, y: -2 }, 1, 1, 1);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
    expect(Object.is(c.x, -0)).toBe(false);
    expect(Object.is(c.y, -0)).toBe(false);
  });
});

describe('projection/geometry: radii в кадрах проектора при sx ≠ sy', () => {
  const radiiFirst: BoxRadiiLike = [
    { x: 8, y: 8 },
    { x: 16, y: 4 },
    { x: 12, y: 12 },
    { x: 4, y: 6 },
  ];
  const radiiLast: BoxRadiiLike = [
    { x: 10, y: 2 },
    { x: 0, y: 0 },
    { x: 6, y: 6 },
    { x: 8, y: 8 },
  ];
  const node = {
    id: 'r',
    first: { x: 0, y: 0, width: 100, height: 100 },
    last: { x: 0, y: 0, width: 200, height: 50 },
    radii: { first: radiiFirst, last: radiiLast },
    opacity: { from: 0, to: 1 },
  };

  it('frame.radii = cornerRadiusAt(first, last, kx, ky, p) для всех 4 углов (эллиптические пары)', () => {
    const projector = createProjector([node]);
    const p = 0.5;
    const [f] = projector.at(p) as readonly ProjectionFrameLike[];
    // kx ≠ ky по построению: w 100→200, h 100→50.
    expect(f.kx).toBe(0.75); // 150/200
    expect(f.ky).toBe(1.5); // 75/50
    expect(f.radii).toBeDefined();
    for (let i = 0; i < 4; i++) {
      const expected = cornerRadiusAt(radiiFirst[i], radiiLast[i], f.kx, f.ky, p);
      expect(f.radii![i].x, `corner ${i}.x`).toBe(expected.x);
      expect(f.radii![i].y, `corner ${i}.y`).toBe(expected.y);
    }
  });

  it('без radii во входе → frame.radii === undefined; opacity лерпится с clamp01', () => {
    const bare = createProjector([
      { id: 'x', first: node.first, last: node.last },
    ]);
    expect(bare.at(0.5)[0].radii).toBeUndefined();
    expect(bare.at(0.5)[0].opacity).toBeUndefined();

    const withOp = createProjector([node]);
    expect(withOp.at(0.5)[0].opacity).toBe(0.5);
    expect(withOp.at(1.5)[0].opacity).toBe(1); // clamp01 на overshoot (§2.1.5)
    expect(withOp.at(-0.5)[0].opacity).toBe(0);
  });
});
