/**
 * projection/geometry.ts — ЧИСТАЯ математика вложенного FLIP (subpath ./projection).
 *
 * Zero-DOM (P2), тотальная: враждебные входы (NaN/±Inf-ректы, сырой p вне [0,1])
 * проходят через стражи и дают конечный CSS (P1); бросает только валидация
 * ПАРАМЕТРОВ дерева в createProjector (MotionParamError, рано). Кандидат в Stryker.
 *
 * Замкнутая форма вложенности (полный вывод — в шапке index.ts): кумулятивная
 * карта «layout-пространство сразу над узлом c → page» равна box-map ближайшего
 * ПРОЕЦИРУЮЩЕГО предка A:
 *
 *   Φ_A(q) = V_A.pos + k_A ⊙ (q − B_A.pos),   k_A = V_A.size ⊘ B_A.size (ЛОКАЛЕН)
 *   s_c = (V_c.size ⊘ B_c.size) ⊘ k_A
 *   t_c = (V_c.pos − V_A.pos) ⊘ k_A − (B_c.pos − B_A.pos)
 *   k_c = k_A ⊙ s_c = V_c.size ⊘ B_c.size     // индукция замкнулась
 *
 * k_c не зависит от предков ⇒ нужен ТОЛЬКО ближайший проецирующий предок;
 * цепочка любой глубины схлопывается. Anchor B — где узел ФАКТИЧЕСКИ стоит в
 * layout (default last; = first у кроссфейд-ghost'а).
 *
 * Карта переиспользования: counterScale (src/flip/index.ts:145) и correctRadius
 * (:133) — ЖИВЫЕ вызовы (статичный ребёнок s = 1 ⊘ k_A ≡ counterScale — хелпер
 * flip есть вырожденный случай формулы); finite/finiteDiv/clamp01 — локальные
 * копии ~12 строк (приватны в flip — прецедент самого flip против clampFinite
 * из units.ts; импорт утянул бы чужой граф при splitting:false).
 *
 * Ноль аллокаций на горячем at(p): массив и объекты кадров ПЕРЕИСПОЛЬЗУЮТСЯ
 * между вызовами (тот же принцип у MainUnit._snap) — ссылки
 * не удерживать. Горячая коррекция радиусов пишет сразу в предвыделенный target:
 * это та же finiteDiv-формула, но без лишней оси и объекта от публичного correctRadius.
 *
 * Риск (спека §10.4): сингулярность k→0 достижима при clamp:false overshoot
 * (V.size флорится в 0) — finiteDiv-фоллбеки держат кадр конечным (s → 1,
 * translate → «k_A как 1»), глитч ограничен окрестностью сингулярности.
 */

import { MotionParamError } from '../errors.js';
import { correctRadius, counterScale, type FlipRect } from '../flip/index.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

/** Пер-угловой радиус (px, x/y-полуоси раздельно — эллиптический угол). */
export interface CornerRadius {
  readonly x: number;
  readonly y: number;
}

/** 4 угла в CSS-порядке: TL, TR, BR, BL. */
export type BoxRadii = readonly [CornerRadius, CornerRadius, CornerRadius, CornerRadius];

/** Боксы одного узла. anchor — где узел ФАКТИЧЕСКИ стоит в layout; default last. */
export interface ProjectionBoxes {
  readonly first: FlipRect;
  readonly last: FlipRect;
  readonly anchor?: FlipRect | undefined;
}

export interface ProjectedTransform {
  readonly tx: number;
  readonly ty: number;
  readonly sx: number;
  readonly sy: number;
}

export interface ProjectionNodeInit {
  /** Уникален в наборе; пустой/дубль → MotionParamError (рано, в createProjector). */
  readonly id: string;
  /** id ближайшего ПРОЕЦИРУЮЩЕГО предка; null/undefined = корень. Неизвестный/цикл → MotionParamError. */
  readonly parent?: string | null | undefined;
  /** Page-space боксы. */
  readonly first: FlipRect;
  readonly last: FlipRect;
  /** Default = last. Для кроссфейд-ghost'а = first. */
  readonly anchor?: FlipRect | undefined;
  /** Морф радиусов first→last с коррекцией масштаба. Отсутствие = радиусы не трогаем. */
  readonly radii?: { readonly first: BoxRadii; readonly last: BoxRadii } | undefined;
  /** Канал прозрачности (enter/exit/кроссфейд). Выход ВСЕГДА clamp01. */
  readonly opacity?: { readonly from: number; readonly to: number } | undefined;
}

export interface ProjectionFrame {
  readonly id: string;
  /** Локальный transform узла; потребитель ОБЯЗАН выставить transform-origin '0 0'. */
  readonly tx: number;
  readonly ty: number;
  readonly sx: number;
  readonly sy: number;
  /** Кумулятивный визуальный масштаб узла (V.size/anchor.size) — сырьё для своих коррекций. */
  readonly kx: number;
  readonly ky: number;
  /** Скорректированные радиусы; undefined если radii не заданы. */
  readonly radii?: BoxRadii | undefined;
  readonly opacity?: number | undefined;
  /** Вырожденный anchor: transform НЕ применять; дети переякорены выше. */
  readonly degenerate: boolean;
}

export interface Projector {
  /** Кадры на сыром p. Порядок гарантирован: родитель раньше ребёнка.
   *  Массив и объекты кадров ПЕРЕИСПОЛЬЗУЮТСЯ между вызовами — не удерживать ссылки. */
  at(p: number): readonly ProjectionFrame[];
  /** Топологический порядок id (диагностика/тесты). */
  readonly order: readonly string[];
}

// ─── Локальные стражи (копии семантики src/flip/index.ts:70-86) ──────────────

/** Страж конечности: NaN→0, ±Inf→±MAX_VALUE. @internal */
export function finite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/** Конечное деление; знаменатель 0/NaN → нейтральный fallback. @internal */
export function finiteDiv(num: number, den: number, fallback: number): number {
  const d = finite(den);
  if (d === 0) return fallback;
  return finite(finite(num) / d);
}

/** Конечный lerp со схлопом −0 (P1). @internal — переиспользует driver (ребейз). */
export function lerp1(a: number, b: number, t: number): number {
  return finite(finite(a) + (finite(b) - finite(a)) * t) + 0;
}

/** @internal */
export function clamp01(x: number): number {
  const f = Number.isNaN(x) ? 0 : x;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ─── Внутренние мутируемые формы (переиспользование без аллокаций) ───────────

interface MutableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MutableTransform {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

/** Покомпонентный lerp в out; p уже санирован (NaN→0). Размеры флорятся ≥ 0. */
function mixInto(first: FlipRect, last: FlipRect, t: number, out: MutableRect): MutableRect {
  out.x = finite(finite(first.x) + (finite(last.x) - finite(first.x)) * t) + 0;
  out.y = finite(finite(first.y) + (finite(last.y) - finite(first.y)) * t) + 0;
  const w = finite(finite(first.width) + (finite(last.width) - finite(first.width)) * t) + 0;
  const h = finite(finite(first.height) + (finite(last.height) - finite(first.height)) * t) + 0;
  // Floor размеров: overshoot позиции честный, зеркалирование отрицательным scale — нет.
  out.width = w < 0 ? 0 : w;
  out.height = h < 0 ? 0 : h;
  return out;
}

/**
 * Корень при anchor === last: та же форма выражений, что computeFlip + flipAtRaw
 * (src/flip/index.ts:94, :108) — бит-в-бит паритет с оракулом flipAt на p ∈ [0,1]
 * (вне [0,1] flipAt клампит p, мы честно продолжаем ту же кривую — overshoot-путь).
 * Floor масштаба ≥ 0 — эквивалент floor'а размеров V (mixInto) в этой форме.
 */
function rootFlipInto(first: FlipRect, last: FlipRect, t: number, out: MutableTransform): void {
  const dx = finite(finite(first.x) - finite(last.x));
  const dy = finite(finite(first.y) - finite(last.y));
  const sx0 = finiteDiv(first.width, last.width, 1);
  const sy0 = finiteDiv(first.height, last.height, 1);
  const inv1 = 1 - t;
  out.tx = finite(dx * inv1) + 0;
  out.ty = finite(dy * inv1) + 0;
  const sx = finite(sx0 + (1 - sx0) * t) + 0;
  const sy = finite(sy0 + (1 - sy0) * t) + 0;
  out.sx = sx < 0 ? 0 : sx;
  out.sy = sy < 0 ? 0 : sy;
}

/**
 * Корень с явным anchor ≠ last (кроссфейд-ghost): k_A = (1,1), общая форма.
 * Floor масштаба ≥ 0 (паритет rootFlipInto): V ≥ 0 по mixInto, минус может дать
 * только враждебный отрицательный anchor — зеркалирование не эмитим.
 */
function rootAnchorInto(v: MutableRect, anchor: FlipRect, out: MutableTransform): void {
  out.tx = finite(v.x - finite(anchor.x)) + 0;
  out.ty = finite(v.y - finite(anchor.y)) + 0;
  const sx = finite(finiteDiv(v.width, anchor.width, 1)) + 0;
  const sy = finite(finiteDiv(v.height, anchor.height, 1)) + 0;
  out.sx = sx < 0 ? 0 : sx;
  out.sy = sy < 0 ? 0 : sy;
}

/**
 * Ребёнок под проецирующим предком: замкнутая форма (шапка файла).
 * Сборка масштаба — через ЖИВОЙ вызов counterScale (./flip:145).
 * finiteDiv-фоллбек translate — «k_A как 1» (деградация k→0, спека §2.1.4).
 */
function childInto(
  v: MutableRect,
  anchor: FlipRect,
  vaX: number,
  vaY: number,
  ancestorAnchor: FlipRect,
  kAx: number,
  kAy: number,
  out: MutableTransform,
): void {
  // Floor собственного масштаба ≥ 0 (паритет rootFlipInto): враждебный
  // отрицательный anchor не должен зеркалить ребёнка.
  const rawOwnX = finiteDiv(v.width, anchor.width, 1);
  const rawOwnY = finiteDiv(v.height, anchor.height, 1);
  const ownX = rawOwnX < 0 ? 0 : rawOwnX;
  const ownY = rawOwnY < 0 ? 0 : rawOwnY;
  const cs = counterScale(kAx, kAy); // живой вызов ./flip
  out.sx = finite(ownX * cs.sx) + 0;
  out.sy = finite(ownY * cs.sy) + 0;
  const dVx = v.x - vaX;
  const dVy = v.y - vaY;
  out.tx = finite(finiteDiv(dVx, kAx, dVx) - (finite(anchor.x) - finite(ancestorAnchor.x))) + 0;
  out.ty = finite(finiteDiv(dVy, kAy, dVy) - (finite(anchor.y) - finite(ancestorAnchor.y))) + 0;
}

// ─── Чистая математика (headless, тотальная: враждебные входы → стражи) ──────

/** Покомпонентный lerp боксов; p НЕ клампится (overshoot-путь; NaN→0); размеры флорятся ≥ 0. */
export function mixBox(first: FlipRect, last: FlipRect, p: number): FlipRect {
  const t = Number.isNaN(p) ? 0 : p;
  return mixInto(first, last, t, { x: 0, y: 0, width: 0, height: 0 });
}

/**
 * Локальный transform узла на прогрессе p через visual box ближайшего ПРОЕЦИРУЮЩЕГО
 * предка (ancestor: null = корень; тогда ≡ flipAt(computeFlip(first,last), p) при
 * anchor=last — differential-оракул). Оба узла берутся на ОДНОМ p.
 */
export function projectAt(
  node: ProjectionBoxes,
  ancestor: ProjectionBoxes | null,
  p: number,
): ProjectedTransform {
  const t = Number.isNaN(p) ? 0 : p;
  const anchor = node.anchor ?? node.last;
  const out: MutableTransform = { tx: 0, ty: 0, sx: 1, sy: 1 };

  if (ancestor === null) {
    if (anchor === node.last) {
      rootFlipInto(node.first, node.last, t, out);
    } else {
      const v = mixInto(node.first, node.last, t, { x: 0, y: 0, width: 0, height: 0 });
      rootAnchorInto(v, anchor, out);
    }
    return out;
  }

  const v = mixInto(node.first, node.last, t, { x: 0, y: 0, width: 0, height: 0 });
  const ancestorAnchor = ancestor.anchor ?? ancestor.last;
  const va = mixInto(ancestor.first, ancestor.last, t, { x: 0, y: 0, width: 0, height: 0 });
  const kAx = finiteDiv(va.width, ancestorAnchor.width, 1);
  const kAy = finiteDiv(va.height, ancestorAnchor.height, 1);
  childInto(v, anchor, va.x, va.y, ancestorAnchor, kAx, kAy, out);
  return out;
}

/**
 * Радиус угла на прогрессе p с коррекцией под КУМУЛЯТИВНЫЙ масштаб узла (kx, ky):
 * lerp(first,last,clamp01(p)), floor 0, затем correctRadius пер-оси (./flip:133).
 * Делитель — кумулятивный k узла (V.size/B.size), НЕ локальный s: по индукции k
 * уже равен полному произведению масштабов предков — коррекция не знает предков.
 */
export function cornerRadiusAt(
  first: CornerRadius,
  last: CornerRadius,
  kx: number,
  ky: number,
  p: number,
): CornerRadius {
  const t = clamp01(p); // прогресс радиуса клампится: overshoot на радиус не транслируем
  let rx = finite(finite(first.x) + (finite(last.x) - finite(first.x)) * t);
  let ry = finite(finite(first.y) + (finite(last.y) - finite(first.y)) * t);
  if (rx < 0) rx = 0;
  if (ry < 0) ry = 0;
  // Живые вызовы ./flip: x/y-полуоси корректируются независимо (эллиптический угол).
  return {
    x: finite(correctRadius(rx, kx, ky).x) + 0,
    y: finite(correctRadius(ry, kx, ky).y) + 0,
  };
}

// ─── Дерево: валидация + топосорт + degenerate-precompute ────────────────────

/** Порог вырожденного anchor-бокса (px). */
const DEGENERATE_EPSILON = 1e-6;

interface MutableCorner {
  x: number;
  y: number;
}

interface MutableFrame {
  id: string;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  kx: number;
  ky: number;
  radii: [MutableCorner, MutableCorner, MutableCorner, MutableCorner] | undefined;
  opacity: number | undefined;
  degenerate: boolean;
}

function isDegenerateBox(b: FlipRect): boolean {
  return (
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y) ||
    !Number.isFinite(b.width) ||
    !Number.isFinite(b.height) ||
    b.width <= DEGENERATE_EPSILON ||
    b.height <= DEGENERATE_EPSILON
  );
}

/**
 * Чистая фабрика: валидация + топосорт + degenerate-precompute один раз. SSR-safe.
 *
 * Валидация — MotionParamError РАНО, с именем виновника (даже под reduced-motion —
 * драйвер зовёт фабрику до резолва reduce). Вырожденные узлы (anchor ≤ ε либо
 * нефинитен) помечаются на precompute: transform для них не вычисляется, дети
 * ПЕРЕЯКОРИВАЮТСЯ к следующему невырожденному проецирующему предку (один раз);
 * finiteDiv остаётся вторым эшелоном (враждебный NaN в середине полёта).
 */
export function createProjector(nodes: readonly ProjectionNodeInit[]): Projector {
  const count = nodes.length;

  // Валидация id (рано, с именем виновника).
  const indexById = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const id = nodes[i].id;
    if (typeof id !== 'string' || id === '') {
      throw new MotionParamError('LM079');
    }
    if (indexById.has(id)) {
      throw new MotionParamError('LM080');
    }
    indexById.set(id, i);
    // Radii-кортежи: ровно 4 угла с обеих сторон (мальформный as-any вход —
    // ранний MotionParamError, не поздний TypeError из горячего at()).
    const r = nodes[i].radii;
    if (
      r !== undefined &&
      !(
        Array.isArray(r.first) &&
        r.first.length === 4 &&
        Array.isArray(r.last) &&
        r.last.length === 4 &&
        r.first.every((c) => c !== null && typeof c === 'object') &&
        r.last.every((c) => c !== null && typeof c === 'object')
      )
    ) {
      throw new MotionParamError('LM081');
    }
  }

  // Parent-ссылки (лес: у узла не больше одного родителя).
  const parentIdx: (number | null)[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const parent = nodes[i].parent;
    if (parent === null || parent === undefined) {
      parentIdx[i] = null;
      continue;
    }
    const idx = indexById.get(parent);
    if (idx === undefined) {
      throw new MotionParamError('LM082');
    }
    parentIdx[i] = idx;
  }

  // Топосорт: родитель строго раньше ребёнка (вход в любом порядке); циклы — бросок.
  // 0 = не посещён, 1 = в текущей цепочке, 2 = размещён.
  const state = new Uint8Array(count);
  const orderIdx: number[] = [];
  const chain: number[] = [];
  for (let i = 0; i < count; i++) {
    if (state[i] !== 0) continue;
    chain.length = 0;
    let j: number | null = i;
    while (j !== null && state[j] === 0) {
      state[j] = 1;
      chain.push(j);
      j = parentIdx[j];
    }
    if (j !== null && state[j] === 1) {
      throw new MotionParamError('LM083');
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      state[chain[k]] = 2;
      orderIdx.push(chain[k]);
    }
  }

  // Precompute: anchor-боксы, вырожденность, переякоривание детей вырожденных.
  const anchors: FlipRect[] = new Array(count);
  const anchorIsLast: boolean[] = new Array(count);
  const degenerate: boolean[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = nodes[i].anchor;
    anchors[i] = a ?? nodes[i].last;
    anchorIsLast[i] = a === undefined || a === nodes[i].last;
    degenerate[i] = isDegenerateBox(anchors[i]);
  }
  // liveAncestor: ближайший НЕвырожденный проецирующий предок (родители в topo-порядке
  // обработаны раньше — одна проходка).
  const liveAncestor: (number | null)[] = new Array(count);
  for (const i of orderIdx) {
    const a = parentIdx[i];
    liveAncestor[i] = a === null ? null : degenerate[a] ? liveAncestor[a] : a;
  }

  // Переиспользуемые кадры (мутируются между вызовами at) + скретчи резолва.
  // Degenerate-кадр не зависит от p — заполняется ЦЕЛИКОМ один раз здесь
  // (transform-нейтраль, opacity снапнут к to, radii undefined); в at() для
  // таких узлов ранний continue. degenerate — константа полёта: флаг кадра
  // тоже выставляется один раз.
  const frames: MutableFrame[] = new Array(orderIdx.length);
  for (let oi = 0; oi < orderIdx.length; oi++) {
    const i = orderIdx[oi];
    const op = nodes[i].opacity;
    frames[oi] = {
      id: nodes[i].id,
      tx: 0,
      ty: 0,
      sx: 1,
      sy: 1,
      kx: 1,
      ky: 1,
      radii:
        nodes[i].radii === undefined || degenerate[i]
          ? undefined
          : [
              { x: 0, y: 0 },
              { x: 0, y: 0 },
              { x: 0, y: 0 },
              { x: 0, y: 0 },
            ],
      // «+ 0» — схлоп −0 (P1: каждый выход кадра, включая opacity).
      opacity: degenerate[i] && op !== undefined ? clamp01(op.to) + 0 : undefined,
      degenerate: degenerate[i],
    };
  }

  const kx = new Float64Array(count);
  const ky = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  // vx/vy/kx/ky degenerate-узлов никем не читаются: liveAncestor по построению
  // пропускает вырожденных предков, а их кадры заполнены на precompute (§2.1.4).
  const v: MutableRect = { x: 0, y: 0, width: 0, height: 0 };
  const order: readonly string[] = orderIdx.map((i) => nodes[i].id);

  const at = (p: number): readonly ProjectionFrame[] => {
    const t = Number.isNaN(p) ? 0 : p; // санация p — паритет flipAtRaw (NaN → 0)
    const tc = clamp01(t);
    for (let oi = 0; oi < orderIdx.length; oi++) {
      const i = orderIdx[oi];
      // Degenerate: кадр заполнен целиком на precompute (p в него не входит);
      // vx/vy/kx/ky узла никем не читаются — дети переякорены через liveAncestor.
      if (degenerate[i]) continue;
      const node = nodes[i];
      const frame = frames[oi];
      mixInto(node.first, node.last, t, v);

      const a = liveAncestor[i];
      if (a === null) {
        if (anchorIsLast[i]) {
          rootFlipInto(node.first, node.last, t, frame);
          // k корня = V.size ⊘ B.size = эмитированный s (k_A = 1) — бит-консистентно
          // с фактически применённым масштабом.
          kx[i] = frame.sx;
          ky[i] = frame.sy;
        } else {
          rootAnchorInto(v, anchors[i], frame);
          kx[i] = frame.sx;
          ky[i] = frame.sy;
        }
      } else {
        childInto(v, anchors[i], vx[a], vy[a], anchors[a], kx[a], ky[a], frame);
        const kxi = finiteDiv(v.width, anchors[i].width, 1);
        const kyi = finiteDiv(v.height, anchors[i].height, 1);
        kx[i] = kxi < 0 ? 0 : kxi; // floor ≥ 0 — питает correctRadius и детей
        ky[i] = kyi < 0 ? 0 : kyi;
      }
      vx[i] = v.x;
      vy[i] = v.y;
      frame.kx = kx[i];
      frame.ky = ky[i];

      const radii = node.radii;
      if (radii !== undefined) {
        // Инлайн семантики cornerRadiusAt в переиспользуемый target (ноль
        // промежуточных объектов лерпа): lerp по tc → floor 0 → живой
        // correctRadius-семантика пер-оси (эллиптический угол). target предвыделен на
        // precompute для каждого невырожденного узла с radii.
        const target = frame.radii as [
          MutableCorner,
          MutableCorner,
          MutableCorner,
          MutableCorner,
        ];
        for (let c = 0; c < 4; c++) {
          const rf = radii.first[c];
          const rl = radii.last[c];
          let rx = finite(finite(rf.x) + (finite(rl.x) - finite(rf.x)) * tc);
          let ry = finite(finite(rf.y) + (finite(rl.y) - finite(rf.y)) * tc);
          if (rx < 0) rx = 0;
          if (ry < 0) ry = 0;
          // Скалярный путь делает два деления на угол вместо четырёх: публичный
          // correctRadius считает обе оси, а здесь rx нужен только x, ry — только y.
          target[c].x = finiteDiv(rx, kx[i], rx) + 0;
          target[c].y = finiteDiv(ry, ky[i], ry) + 0;
        }
      }

      const opacity = node.opacity;
      // «+ 0» — схлоп −0 (P1: каждый выход кадра, включая opacity).
      frame.opacity =
        opacity === undefined
          ? undefined
          : clamp01(finite(opacity.from + (opacity.to - opacity.from) * tc)) + 0;
    }
    return frames; // ПЕРЕИСПОЛЬЗУЕМЫЙ массив — не удерживать ссылку
  };

  return { at, order };
}
