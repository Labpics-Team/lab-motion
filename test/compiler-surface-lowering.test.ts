/**
 * test/compiler-surface-lowering.test.ts — GREEN: реальное Vite-lowering
 * animate(..., { width: [w0, w1] }, { layout: 'project' }) из
 * '@labpics/motion/animate' в приватный surface-executor.
 *
 * Инварианты:
 *   S1. Артефакт-литерал детерминирован и бит-в-бит равен SSOT-сертификации
 *       (tryCompileSurfaceArtifact: позитивность + reciprocal-бюджет ≤0.25 px);
 *       несертифицируемый вызов → undefined (fail-closed, runtime path).
 *   S2. Плагин заменяет статический вызов executor-вызовом с литералом и
 *       hoisted-импортом '@labpics/motion/surface'; любой намёк на динамику,
 *       onFrame, shadowing или коллизию имени — источник не тронут.
 *   S3. Executor runSurface: snap без VT/reduced, certified VT-путь (5 CSS
 *       effects, cleanup ровно один раз), fail-closed skip при недоказанной
 *       pseudo-модели, cancel раскрывает committed DOM, не-Element цель —
 *       width-tween семантика обычного runtime path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  SURFACE_IMPORT_SOURCE,
  planSurfaceLowering,
  surfaceArtifactLiteral,
  type AstNode,
  type SurfaceProgram,
} from '../src/compiler/core.js';
import { motionCompiler } from '../src/compiler/vite/index.js';
import { tryCompileSurfaceArtifact } from '../src/future-layout/artifact.js';
import { runSurface, type CompiledSurfaceCall } from '../src/compiler/surface/index.js';

// ─── Хелперы ─────────────────────────────────────────────────────────────────

async function applyPlugin(code: string): Promise<string | undefined> {
  const plugin = motionCompiler();
  const ast = await parseAstAsync(code);
  const result = await (plugin.transform as (this: { parse: () => unknown }, c: string, id: string) =>
    Promise<{ code: string } | undefined>).call({ parse: () => ast }, code, '/app/module.ts');
  return result?.code;
}

function program(overrides: Partial<SurfaceProgram> = {}): SurfaceProgram {
  return {
    version: 'surface/1',
    target: { kind: 'identifier', name: 'viewport' },
    fromWidth: 240,
    toWidth: 360,
    ...overrides,
  };
}

/** Реальный сертифицированный артефакт → форма CompiledSurfaceCall. */
function realArtifact(): CompiledSurfaceCall {
  const artifact = tryCompileSurfaceArtifact({ mass: 1, stiffness: 170, damping: 26 }, 240, 360);
  if (artifact === undefined) throw new Error('тестовая пружина обязана сертифицироваться');
  return { w0: 240, w1: 360, d: artifact.durationMs, p: artifact.easing, q: artifact.reciprocalEasing, a: artifact.blendEasing };
}

interface FakeStyle {
  width?: string;
  viewTransitionName?: string;
  setProperty?: (n: string, v: string) => void;
}
interface FakeEl { style: FakeStyle; animate?: (kf: unknown, timing: unknown) => unknown }

const fakeEl = (): FakeEl => ({ style: {} });

interface FakeTransition {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition(): void;
}

interface FakeDoc {
  styles: string[];
  removals: number;
  updates: number;
  skips: number;
  finish(): void;
  document: {
    createElement(tag: string): { textContent: string; remove(): void };
    head: { appendChild(node: unknown): void };
    querySelectorAll?(selector: string): FakeEl[];
    startViewTransition?(update: () => void): FakeTransition;
  };
}

function fakeDoc(withVt: boolean): FakeDoc {
  const state = {
    styles: [] as string[],
    removals: 0,
    updates: 0,
    skips: 0,
    finishVt: undefined as (() => void) | undefined,
  };
  const doc: FakeDoc['document'] = {
    createElement: () => {
      const el = {
        textContent: '',
        remove(): void { state.removals++; },
      };
      return el;
    },
    head: {
      appendChild(node: unknown): void {
        state.styles.push((node as { textContent: string }).textContent);
      },
    },
  };
  if (withVt) {
    doc.startViewTransition = (update) => {
      update();
      state.updates++;
      let resolveFinished: () => void = () => {};
      const finished = new Promise<void>((r) => { resolveFinished = r; });
      state.finishVt = resolveFinished;
      return {
        ready: Promise.resolve(),
        finished,
        skipTransition(): void { state.skips++; },
      };
    };
  }
  return {
    get styles() { return state.styles; },
    get removals() { return state.removals; },
    get updates() { return state.updates; },
    get skips() { return state.skips; },
    finish(): void { state.finishVt?.(); },
    document: doc,
  };
}

type Globals = { document?: unknown; matchMedia?: unknown; getComputedStyle?: unknown };
const globals = globalThis as Globals;
let saved: Globals;

beforeEach(() => {
  saved = {
    document: globals.document,
    matchMedia: globals.matchMedia,
    getComputedStyle: globals.getComputedStyle,
  };
});

afterEach(() => {
  globals.document = saved.document;
  globals.matchMedia = saved.matchMedia;
  globals.getComputedStyle = saved.getComputedStyle;
});

const certifyOk = (): void => {
  globals.getComputedStyle = () => ({ width: '360px', transform: 'matrix(1, 0, 0, 1, 12, 34)' });
};

// ─── S1: артефакт-литерал ────────────────────────────────────────────────────

describe('surfaceArtifactLiteral — build-time сертификация', () => {
  it('литерал детерминирован и бит-в-бит равен SSOT-артефакту', () => {
    const literal = surfaceArtifactLiteral(program());
    expect(literal).toBe(surfaceArtifactLiteral(program()));
    const artifact = tryCompileSurfaceArtifact({ mass: 1, stiffness: 170, damping: 26 }, 240, 360);
    expect(artifact).toBeDefined();
    expect(literal).toBe(
      `{w0:240,w1:360,d:${artifact!.durationMs},`
      + `p:${JSON.stringify(artifact!.easing)},q:${JSON.stringify(artifact!.reciprocalEasing)},`
      + `a:${JSON.stringify(artifact!.blendEasing)}}`,
    );
  });

  it('явная пружина проходит в артефакт (spring — SSOT, не дубль)', () => {
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    const literal = surfaceArtifactLiteral(program({ spring }));
    const artifact = tryCompileSurfaceArtifact(spring, 240, 360);
    expect(literal).toContain(`d:${artifact!.durationMs},`);
  });

  it('velocity уходит в initialVelocity, а не в ключи пружины', () => {
    const literal = surfaceArtifactLiteral(
      program({ spring: { mass: 1, stiffness: 170, damping: 26, velocity: 0 } }),
    );
    expect(literal).toBe(surfaceArtifactLiteral(program()));
  });

  it('несертифицируемый вызов (позитивность недоказуема) → undefined, не тихий lowering', () => {
    // Огромная отрицательная скорость рождения топит minWidth ниже нуля.
    const literal = surfaceArtifactLiteral(
      program({ spring: { mass: 1, stiffness: 170, damping: 4, velocity: -5000 } }),
    );
    expect(literal).toBeUndefined();
  });
});

// ─── S2: AST-план и Vite-адаптер ─────────────────────────────────────────────

// Позитивная форма после hotfix наблюдаемой эквивалентности: ТОЛЬКО голый
// expression statement — результат никем не используется, поэтому неполные
// compiled-контролы ненаблюдаемы. return-форма стала консервативным отказом.
const POSITIVE = `import { animate } from '@labpics/motion/animate';
export function open(viewport) {
  animate(viewport, { width: [240, 360] }, { layout: 'project' });
}
`;

describe('planSurfaceLowering / motionCompiler — реальное понижение', () => {
  it('статический вызов заменяется executor-вызовом с сертифицированным литералом', async () => {
    const output = await applyPlugin(POSITIVE);
    expect(output).toBeDefined();
    expect(output).toContain('__labMotionSurface(viewport, {w0:240,w1:360,');
    // Hoisted-импорт приватного executor.
    expect(output).toContain(
      `import { runSurface as __labMotionSurface } from "${SURFACE_IMPORT_SOURCE}";`,
    );
    // Фасадные опции стерты вместе с вызовом: литерал несёт только артефакт.
    expect(output).not.toContain('layout');
  });

  it('target остаётся байт-в-байт и вычисляется ровно один раз', async () => {
    const output = await applyPlugin(POSITIVE);
    expect(output).toContain('__labMotionSurface(viewport, ');
  });

  it('план: правки непересекающиеся, по возрастанию, runtimeCalls честный', async () => {
    const code = `import { animate } from '@labpics/motion/animate';
animate(a, { width: [240, 360] }, { layout: 'project' });
animate(b, { width: [240, w] }, { layout: 'project' });
`;
    const ast = await parseAstAsync(code);
    const plan = planSurfaceLowering(ast as unknown as AstNode, code);
    expect(plan).toBeDefined();
    expect(plan!.edits.length).toBe(2); // пара правок на единственный статический вызов
    for (let i = 1; i < plan!.edits.length; i++) {
      expect(plan!.edits[i]!.start).toBeGreaterThanOrEqual(plan!.edits[i - 1]!.end);
    }
    expect(plan!.runtimeCalls).toBe(1); // динамический конец остался runtime path
    expect(plan!.importSource).toBe(SURFACE_IMPORT_SOURCE);
  });

  it.each([
    ['onFrame требует observer-час runtime path', `import { animate } from '@labpics/motion/animate';
animate(el, { width: [240, 360] }, { layout: 'project', onFrame: (f) => f });
`],
    ['динамические концы', `import { animate } from '@labpics/motion/animate';
animate(el, { width: [240, w] }, { layout: 'project' });
`],
    ['без layout — обычный width-tween', `import { animate } from '@labpics/motion/animate';
animate(el, { width: [240, 360] }, {});
`],
    ['alias-импорт', `import { animate as anim } from '@labpics/motion/animate';
anim(el, { width: [240, 360] }, { layout: 'project' });
`],
    ['shadowing локальным объявлением', `import { animate } from '@labpics/motion/animate';
const animate = null;
`],
    ['коллизия имени executor-биндинга', `import { animate } from '@labpics/motion/animate';
const __labMotionSurface = 1;
animate(el, { width: [240, 360] }, { layout: 'project' });
`],
    ['двухаргументный вызов (не surface-форма)', `import { animate } from '@labpics/motion/animate';
animate(el, { width: [240, 360] });
`],
    ['trailing comma в вызове — экзотика тривиа-зон', `import { animate } from '@labpics/motion/animate';
animate(el, { width: [240, 360] }, { layout: 'project' },);
`],
    ['несертифицируемая пружина — fail-closed', `import { animate } from '@labpics/motion/animate';
animate(el, { width: [240, 360] }, { layout: 'project', spring: { mass: 1, stiffness: 170, damping: 4, velocity: -5000 } });
`],
  ])('консервативный отказ: %s', async (_label, code) => {
    expect(await applyPlugin(code)).toBeUndefined();
  });
});

// ─── S3: executor ────────────────────────────────────────────────────────────

describe('runSurface — executor compiled-артефактов', () => {
  it('нет VT-capability → мгновенный snap-коммит, finished резолвится', async () => {
    const el = fakeEl();
    globals.document = fakeDoc(false).document;
    const controls = runSurface(el, realArtifact());
    expect(el.style.width).toBe('360px');
    await controls.finished;
  });

  it('reduced-motion при живом VT → всё равно snap', async () => {
    const el = fakeEl();
    const doc = fakeDoc(true);
    globals.document = doc.document;
    globals.matchMedia = () => ({ matches: true });
    const controls = runSurface(el, realArtifact());
    expect(el.style.width).toBe('360px');
    expect(doc.updates).toBe(0); // VT не запускался
    await controls.finished;
  });

  it('certified VT-путь: 5 CSS-effects, cleanup ровно один раз', async () => {
    const el = fakeEl();
    const doc = fakeDoc(true);
    globals.document = doc.document;
    certifyOk();
    const controls = runSurface(el, realArtifact());
    expect(el.style.viewTransitionName).toMatch(/^lm\d+$/);
    expect(doc.updates).toBe(1); // commit конечной ширины внутри startViewTransition
    expect(el.style.width).toBe('360px');
    await Promise.resolve(); // ready-микротаск → certify
    expect(doc.styles.length).toBe(1);
    const css = doc.styles[0]!;
    expect(css.match(/@keyframes /g)!.length).toBe(5);
    expect(css).toContain('::view-transition-group(lm');
    expect(css).toContain('::view-transition-image-pair(lm');
    expect(css).toContain('::view-transition-old(lm');
    expect(css).toContain('::view-transition-new(lm');
    expect(css).toContain('overflow: hidden');
    doc.finish();
    await controls.finished;
    expect(doc.removals).toBe(1); // stylesheet снят ровно один раз
    expect(el.style.viewTransitionName).toBe(''); // имя цели снято
  });

  it('pseudo-модель недоказуема (group-бокс ≠ committed) → skip, DOM раскрыт', async () => {
    const el = fakeEl();
    const doc = fakeDoc(true);
    globals.document = doc.document;
    globals.getComputedStyle = () => ({ width: '500px', transform: 'none' });
    const controls = runSurface(el, realArtifact());
    await Promise.resolve();
    expect(doc.skips).toBe(1);   // snapshot-плоскости сняты немедленно
    expect(doc.styles.length).toBe(0); // effects CSS не инжектился
    expect(el.style.width).toBe('360px'); // committed DOM не откатывается
    await controls.finished;
  });

  it('cancel в активной фазе раскрывает committed DOM и не откатывает commit', async () => {
    const el = fakeEl();
    const doc = fakeDoc(true);
    globals.document = doc.document;
    certifyOk();
    const controls = runSurface(el, realArtifact());
    await Promise.resolve(); // certify прошёл, active phase
    controls.cancel();
    expect(doc.skips).toBe(1);
    expect(doc.removals).toBe(1);
    expect(el.style.width).toBe('360px');
    await controls.finished;
    // Повторный cancel — no-op (cleanup ровно один раз).
    controls.cancel();
    expect(doc.skips).toBe(1);
  });

  it('не-Element цель (селектор) — width-tween семантика runtime path', async () => {
    const a = fakeEl();
    const b = fakeEl();
    const calls: unknown[] = [];
    a.animate = (kf, timing) => { calls.push([kf, timing]); return {}; };
    b.animate = (kf, timing) => { calls.push([kf, timing]); return {}; };
    const doc = fakeDoc(false);
    doc.document.querySelectorAll = () => [a, b];
    globals.document = doc.document;
    const art = realArtifact();
    const controls = runSurface('.panel', art);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([
      { width: ['240px', '360px'] },
      { duration: art.d, easing: art.p, fill: 'both' },
    ]);
    expect(doc.updates).toBe(0); // это не поверхность
    await controls.finished;
  });

  it('список целей без WAAPI — мгновенный коммит каждой', async () => {
    const a = fakeEl();
    const b = fakeEl();
    globals.document = fakeDoc(false).document;
    const controls = runSurface([a, b], realArtifact());
    expect(a.style.width).toBe('360px');
    expect(b.style.width).toBe('360px');
    await controls.finished;
  });
});
