/**
 * Наблюдаемая эквивалентность compiled surface-пути (hotfix по брифу, этап A).
 *
 * RED-доказательство на merge 64be08fe: каждый блок здесь падает на исходном
 * коде и зеленеет минимальным production-изменением:
 *   A1 — lowering разрешён ТОЛЬКО доказанно неиспользуемому expression
 *        statement: любой использованный результат оставляет runtime-вызов;
 *   A2 — blend A сериализуется в артефакт и исполняется напрямую; regex Q→A
 *        удалён (он ДОПОЛНЯЛ пары вместо замены: расхождение до 0.738);
 *   A5 — inputPolicy/scrollAnchor/spring.velocity не исполняются executor'ом,
 *        поэтому их наличие — консервативный отказ от lowering;
 *   A6 — hostile host: синхронный бросок startViewTransition не оставляет
 *        ни имени, ни частичного состояния, promises терминализируются;
 *   A7 — "./surface" не является публичным semver-субпутём.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';

import { motionCompiler } from '../src/compiler/vite/index.js';
import { tryCompileSurfaceArtifact } from '../src/future-layout/artifact.js';
import { runSurface, type CompiledSurfaceCall } from '../src/surface/index.js';
import packageJson from '../package.json' with { type: 'json' };

async function applyPlugin(code: string): Promise<string | undefined> {
  const plugin = motionCompiler();
  const ast = await parseAstAsync(code);
  const result = await (plugin.transform as (this: { parse: () => unknown }, c: string, id: string) =>
    Promise<{ code: string } | undefined>).call({ parse: () => ast }, code, '/app/module.ts');
  return result?.code;
}

const IMPORT_LINE = "import { animate } from '@labpics/motion/animate';\n";
const BARE_CALL = "animate(viewport, { width: [240, 360] }, { layout: 'project' });";

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

function fullArtifact(): CompiledSurfaceCall & { a?: string; blendEasing: string } {
  const artifact = tryCompileSurfaceArtifact({ mass: 1, stiffness: 170, damping: 26 }, 240, 360);
  if (artifact === undefined) throw new Error('тестовая пружина обязана сертифицироваться');
  return {
    w0: 240,
    w1: 360,
    d: artifact.durationMs,
    p: artifact.easing,
    q: artifact.reciprocalEasing,
    a: artifact.blendEasing,
    blendEasing: artifact.blendEasing,
  };
}

// ─── A1: только неиспользуемый expression statement ──────────────────────────

describe('A1: использованный результат не понижается', () => {
  const USED: readonly [label: string, source: string][] = [
    ['присваивание', `const c = ${BARE_CALL}`],
    ['возврат', `export function open() { return ${BARE_CALL} }`],
    ['await поля', `await ${BARE_CALL.slice(0, -1)}.finished;`],
    ['чтение свойства', `${BARE_CALL.slice(0, -1)}.state;`],
    ['аргумент вызова', `console.log(${BARE_CALL.slice(0, -1)});`],
    ['optional chaining', `${BARE_CALL.slice(0, -1)}?.cancel();`],
  ];

  for (const [label, source] of USED) {
    it(label, async () => {
      const out = await applyPlugin(`${IMPORT_LINE}${source}`);
      // Либо трансформации нет вовсе, либо surface-вызов остался runtime.
      if (out !== undefined) {
        expect(out).not.toContain('runSurface');
        expect(out).toContain('animate(');
      }
    });
  }

  it('доказанно неиспользуемый expression statement понижается', async () => {
    const out = await applyPlugin(`${IMPORT_LINE}${BARE_CALL}`);
    expect(out).toBeDefined();
    expect(out!).toContain('runSurface');
  });
});

// ─── A2: serialized blend A, никакого regex ──────────────────────────────────

describe('A2: blend A исполняется из артефакта', () => {
  it('opacity-easing инжектнутого CSS бит-в-бит равен artifact.blendEasing', async () => {
    const art = fullArtifact();
    const styles: string[] = [];
    const el = { style: {} as Record<string, string> };
    globals.document = {
      createElement: () => ({ textContent: '', remove(): void {} }),
      head: { appendChild(node: unknown): void { styles.push((node as { textContent: string }).textContent); } },
      startViewTransition: (update: () => void) => {
        update();
        return { ready: Promise.resolve(), finished: new Promise<void>(() => {}), skipTransition(): void {} };
      },
    };
    globals.matchMedia = () => ({ matches: false });
    globals.getComputedStyle = () => ({ width: '360px', transform: 'translate(0px,0px)' });

    runSurface(el, art);
    await Promise.resolve();
    await Promise.resolve();

    expect(styles).toHaveLength(1);
    // Каждая opacity-анимация (-oo и -no) обязана нести ровно blendEasing:
    // ни одной Q-точки в blend-строке быть не может.
    const occurrences = styles[0]!.split(art.blendEasing).length - 1;
    expect(occurrences).toBe(2);
  });

  it('артефакт-литерал компилятора содержит serialized a', async () => {
    const out = await applyPlugin(`${IMPORT_LINE}${BARE_CALL}`);
    expect(out).toBeDefined();
    expect(out!).toMatch(/a:"linear\(/);
  });
});

// ─── A5: неисполняемые опции — консервативный отказ ──────────────────────────

describe('A5: опции, которые executor не исполняет, не понижаются', () => {
  const REFUSALS: readonly [label: string, options: string][] = [
    ['inputPolicy: finish', "{ layout: 'project', inputPolicy: 'finish' }"],
    ['inputPolicy: cancel', "{ layout: 'project', inputPolicy: 'cancel' }"],
    ['inputPolicy: block', "{ layout: 'project', inputPolicy: 'block' }"],
    ['scrollAnchor: preserve-start', "{ layout: 'project', scrollAnchor: 'preserve-start' }"],
    ['scrollAnchor: none', "{ layout: 'project', scrollAnchor: 'none' }"],
    ['spring.velocity', "{ layout: 'project', spring: { mass: 1, stiffness: 170, damping: 26, velocity: 2 } }"],
  ];

  for (const [label, options] of REFUSALS) {
    it(label, async () => {
      const out = await applyPlugin(
        `${IMPORT_LINE}animate(viewport, { width: [240, 360] }, ${options});`,
      );
      if (out !== undefined) {
        expect(out).not.toContain('runSurface');
      }
    });
  }
});

// ─── A6: hostile host ────────────────────────────────────────────────────────

describe('A6: синхронный бросок startViewTransition', () => {
  it('финальный DOM определён, имя снято, finished терминализирован', async () => {
    const art = fullArtifact();
    const el = { style: {} as Record<string, string> };
    globals.document = {
      createElement: () => ({ textContent: '', remove(): void {} }),
      head: { appendChild(): void {} },
      startViewTransition: () => { throw new Error('hostile host'); },
    };
    globals.matchMedia = () => ({ matches: false });

    const controls = runSurface(el, art);
    // Fail-closed snap: конечная ширина применена, наше имя не осталось.
    expect(el.style['width']).toBe('360px');
    expect(el.style['viewTransitionName'] ?? '').toBe('');
    await expect(controls.finished).resolves.toBeUndefined();
  });
});

// ─── A7: приватность executor-субпути ────────────────────────────────────────

describe('A7: surface executor — внутренняя деталь', () => {
  it('package.json не экспортирует "./surface"', () => {
    expect((packageJson as { exports: Record<string, unknown> }).exports['./surface']).toBeUndefined();
  });
});
