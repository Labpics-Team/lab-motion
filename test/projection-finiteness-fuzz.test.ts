/**
 * test/projection-finiteness-fuzz.test.ts — CSS-safety fuzz для ./projection.
 * Классы: В (property/fuzz, seeded) + Б (границы валидации MotionParamError).
 * Спека: §2.1.4 (стражи и деградации), §2.1.5 (тексты ошибок), §7.3, P1
 * («каждое число каждого кадра конечно; −0 схлопнут»).
 *
 * Файл добавляется в явный fuzz-список CI (ci.yml:39, шаг §8.6 спеки).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Namespace-import + pick-хелперы (канон test/animate-facade-helpers.ts:9-31) —
 * на заглушке src/projection каждый it падал бы СВОИМ ассертом
 * («createProjector is not a function»), не link-ошибкой: RED for the right reason.
 *
 * Mutation proof:
 *   - Убрать finite()-страж выхода кадра → NaN/±Inf в tx/sx при злых боксах →
 *     «10k злых деревьев» красный.
 *   - Убрать «+ 0» (схлоп −0) → Object.is(x, −0) → красный.
 *   - Убрать finiteDiv-фоллбек при k→0 (overshoot floor'ит V.w предка в 0) →
 *     деление на 0 → Infinity → красный.
 *   - Убрать floor размеров → отрицательные scale уходят в кадры (сами конечны),
 *     но радиусы с отрицательным делителем меняют знак → «radii ≥ 0» красный.
 *   - Убрать любую из четырёх веток валидации → соответствующий бросок исчезает →
 *     красный (текст ошибки пинится буквально, §2.1.5).
 */

import { describe, expect, it } from 'vitest';
import * as projection from '../src/projection/index.js';
import { MotionParamError } from '../src/errors.js';
import {
  lcg,
  pickCornerRadiusAt,
  pickCreateProjector,
  pickMixBox,
  pickProjectAt,
  type BoxRadiiLike,
  type ProjectionNodeInitLike,
  type RectLike,
} from './projection-helpers.js';

const mod = projection as unknown as Record<string, unknown>;
const mixBox = pickMixBox(mod);
const projectAt = pickProjectAt(mod);
const cornerRadiusAt = pickCornerRadiusAt(mod);
const createProjector = pickCreateProjector(mod);

// ─── Генераторы злых входов (только seeded LCG — конвенция пакета) ───────────

const EVIL = [
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  0,
  -0,
  1e-320, // субнормаль
  5e-324, // минимальная субнормаль
  1e308,
  -1e308,
];

function makeGen(seed: number) {
  const rnd = lcg(seed);
  const evil = (): number => EVIL[Math.floor(rnd() * EVIL.length)];
  const num = (): number => (rnd() < 0.35 ? evil() : (rnd() - 0.5) * 2000);
  const size = (): number => {
    const r = rnd();
    if (r < 0.12) return 0; // вырожденный предок
    if (r < 0.24) return rnd() * 1e-7; // около-ε (k→0)
    if (r < 0.42) return evil();
    return rnd() * 500;
  };
  const rect = (): RectLike => ({ x: num(), y: num(), width: size(), height: size() });
  const corner = () => ({
    x: rnd() < 0.3 ? evil() : rnd() * 40,
    y: rnd() < 0.3 ? evil() : rnd() * 40,
  });
  const radii = (): BoxRadiiLike => [corner(), corner(), corner(), corner()];
  const p = (): number => {
    const r = rnd();
    if (r < 0.1) return evil(); // API тотальный: враждебный p тоже не роняет
    return -1.5 + rnd() * 4; // сырой p, включая глубокий overshoot
  };
  return { rnd, num, size, rect, radii, p };
}

/** Валидная структура (id/parent корректны), но злые числа: глубина до 6. */
function evilTree(g: ReturnType<typeof makeGen>): ProjectionNodeInitLike[] {
  const count = 1 + Math.floor(g.rnd() * 6);
  const nodes: ProjectionNodeInitLike[] = [];
  for (let i = 0; i < count; i++) {
    // Смещение к цепочке (глубина до 6), иногда лес/случайный предок.
    const parent =
      i === 0 ? null : g.rnd() < 0.7 ? `n${i - 1}` : g.rnd() < 0.5 ? `n${Math.floor(g.rnd() * i)}` : null;
    nodes.push({
      id: `n${i}`,
      parent,
      first: g.rect(),
      last: g.rect(),
      anchor: g.rnd() < 0.35 ? g.rect() : undefined,
      radii: g.rnd() < 0.4 ? { first: g.radii(), last: g.radii() } : undefined,
      opacity: g.rnd() < 0.3 ? { from: g.num(), to: g.num() } : undefined,
    });
  }
  return nodes;
}

function checkNumber(violations: string[], label: string, x: number): void {
  if (!Number.isFinite(x)) violations.push(`${label} не конечно: ${x}`);
  if (Object.is(x, -0)) violations.push(`${label} эмитит −0`);
}

// ─── ≥10_000 злых деревьев через createProjector().at() ──────────────────────

describe('projection: finiteness fuzz — 10k злых деревьев (P1)', () => {
  it('каждое число каждого кадра конечно и не −0; радиусы ≥ 0; opacity ∈ [0,1]', () => {
    const g = makeGen(0x517e57ed);
    const violations: string[] = [];
    const TREES = 10_000;
    let trees = 0;

    for (let i = 0; i < TREES && violations.length < 20; i++) {
      const nodes = evilTree(g);
      const projector = createProjector(nodes);
      for (let s = 0; s < 3; s++) {
        const p = g.p();
        const frames = projector.at(p);
        for (const f of frames) {
          const tag = `tree#${i} node ${f.id} p=${p}`;
          checkNumber(violations, `${tag} tx`, f.tx);
          checkNumber(violations, `${tag} ty`, f.ty);
          checkNumber(violations, `${tag} sx`, f.sx);
          checkNumber(violations, `${tag} sy`, f.sy);
          checkNumber(violations, `${tag} kx`, f.kx);
          checkNumber(violations, `${tag} ky`, f.ky);
          if (f.radii !== undefined) {
            for (let c = 0; c < 4; c++) {
              checkNumber(violations, `${tag} radii[${c}].x`, f.radii[c].x);
              checkNumber(violations, `${tag} radii[${c}].y`, f.radii[c].y);
              if (f.radii[c].x < 0) violations.push(`${tag} radii[${c}].x < 0`);
              if (f.radii[c].y < 0) violations.push(`${tag} radii[${c}].y < 0`);
            }
          }
          if (f.opacity !== undefined) {
            checkNumber(violations, `${tag} opacity`, f.opacity);
            if (f.opacity < 0 || f.opacity > 1) violations.push(`${tag} opacity вне [0,1]`);
          }
        }
      }
      trees++;
    }

    expect(violations).toEqual([]);
    expect(trees).toBe(TREES);
  });
});

// ─── Чистые функции: тотальность на злых входах ──────────────────────────────

describe('projection: finiteness fuzz — чистые функции (mixBox/projectAt/cornerRadiusAt)', () => {
  it('mixBox: конечно, без −0, размеры ≥ 0 (floor) на 3000 злых пар', () => {
    const g = makeGen(0xb0b0feed);
    const violations: string[] = [];
    for (let i = 0; i < 3000 && violations.length < 20; i++) {
      const v = mixBox(g.rect(), g.rect(), g.p());
      checkNumber(violations, `mix#${i} x`, v.x);
      checkNumber(violations, `mix#${i} y`, v.y);
      checkNumber(violations, `mix#${i} w`, v.width);
      checkNumber(violations, `mix#${i} h`, v.height);
      if (v.width < 0) violations.push(`mix#${i} width < 0`);
      if (v.height < 0) violations.push(`mix#${i} height < 0`);
    }
    expect(violations).toEqual([]);
  });

  it('projectAt: конечно и без −0 на 3000 злых узлов (с предком и без)', () => {
    const g = makeGen(0xdeadbea7);
    const violations: string[] = [];
    for (let i = 0; i < 3000 && violations.length < 20; i++) {
      const node = { first: g.rect(), last: g.rect(), anchor: g.rnd() < 0.4 ? g.rect() : undefined };
      const ancestor =
        g.rnd() < 0.5
          ? null
          : { first: g.rect(), last: g.rect(), anchor: g.rnd() < 0.4 ? g.rect() : undefined };
      const t = projectAt(node, ancestor, g.p());
      checkNumber(violations, `proj#${i} tx`, t.tx);
      checkNumber(violations, `proj#${i} ty`, t.ty);
      checkNumber(violations, `proj#${i} sx`, t.sx);
      checkNumber(violations, `proj#${i} sy`, t.sy);
    }
    expect(violations).toEqual([]);
  });

  it('cornerRadiusAt: конечно, без −0, ≥ 0 на 3000 злых углов (включая k→0/NaN)', () => {
    const g = makeGen(0xfaceb00c);
    const violations: string[] = [];
    for (let i = 0; i < 3000 && violations.length < 20; i++) {
      const kx = g.rnd() < 0.4 ? EVIL[Math.floor(g.rnd() * EVIL.length)] : (g.rnd() - 0.5) * 8;
      const ky = g.rnd() < 0.4 ? EVIL[Math.floor(g.rnd() * EVIL.length)] : (g.rnd() - 0.5) * 8;
      const c = cornerRadiusAt(
        { x: g.num(), y: g.num() },
        { x: g.num(), y: g.num() },
        kx,
        ky,
        g.p(),
      );
      checkNumber(violations, `corner#${i} x`, c.x);
      checkNumber(violations, `corner#${i} y`, c.y);
      // Floor радиуса — ДО correctRadius (§2.2): при неотрицательном кумулятивном
      // k (гарантия проектора по построению) выход тоже неотрицателен.
      if (kx >= 0 && ky >= 0) {
        if (c.x < 0) violations.push(`corner#${i} x < 0 (kx=${kx}, ky=${ky})`);
        if (c.y < 0) violations.push(`corner#${i} y < 0 (kx=${kx}, ky=${ky})`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ─── Границы валидации: бросок (MotionParamError), не NaN (§2.1.5 буквально) ─

const OK: RectLike = { x: 0, y: 0, width: 100, height: 100 };

describe('projection: валидация createProjector — MotionParamError, тексты §2.1.5', () => {
  it('пустой id', () => {
    expect(() => createProjector([{ id: '', first: OK, last: OK }])).toThrow(MotionParamError);
    expect(() => createProjector([{ id: '', first: OK, last: OK }])).toThrow(
      'projection: node id must be a non-empty string',
    );
  });

  it('дубль id', () => {
    const nodes = [
      { id: 'a', first: OK, last: OK },
      { id: 'a', first: OK, last: OK },
    ];
    expect(() => createProjector(nodes)).toThrow(MotionParamError);
    expect(() => createProjector(nodes)).toThrow('projection: duplicate node id "a"');
  });

  it('неизвестный parent', () => {
    const nodes = [
      { id: 'a', first: OK, last: OK },
      { id: 'b', parent: 'ghost', first: OK, last: OK },
    ];
    expect(() => createProjector(nodes)).toThrow(MotionParamError);
    expect(() => createProjector(nodes)).toThrow(
      'projection: unknown parent "ghost" of node "b"',
    );
  });

  it('цикл: самоссылка', () => {
    const nodes = [{ id: 'a', parent: 'a', first: OK, last: OK }];
    expect(() => createProjector(nodes)).toThrow(MotionParamError);
    expect(() => createProjector(nodes)).toThrow('projection: parent cycle at node "a"');
  });

  it('цикл из двух узлов: бросок с текстом цикла (виновник — один из участников)', () => {
    const nodes = [
      { id: 'a', parent: 'b', first: OK, last: OK },
      { id: 'b', parent: 'a', first: OK, last: OK },
    ];
    expect(() => createProjector(nodes)).toThrow(MotionParamError);
    expect(() => createProjector(nodes)).toThrow(
      /^projection: parent cycle at node "(a|b)"$/,
    );
  });

  it('валидные структуры НЕ бросают даже со злыми числами (враждебное состояние ≠ параметры)', () => {
    expect(() =>
      createProjector([
        { id: 'a', first: { x: NaN, y: Infinity, width: -0, height: 1e-320 }, last: OK },
        { id: 'b', parent: 'a', first: OK, last: { x: 0, y: 0, width: NaN, height: -Infinity } },
      ]).at(NaN),
    ).not.toThrow();
  });
});
