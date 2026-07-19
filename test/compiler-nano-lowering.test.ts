/**
 * test/compiler-nano-lowering.test.ts — compiler proof #208: артефакт,
 * AST-план и Vite-адаптер узкого lowering `animate(target, { opacity: N })`
 * из '@labpics/motion/nano'.
 *
 * Инварианты:
 *   C1. Артефакт бит-в-бит совпадает с nano SSOT (springLinear) и проходит
 *       канонический parseMotionProgramV1 (единственный оракул доверия).
 *   C2. Позитивный паттерн понижается: вызов заменяется executor-вызовом с
 *       литеральным артефактом, target-выражение остаётся байт-в-байт и
 *       вычисляется ровно один раз в исходном порядке.
 *   C3. Hostile/сомнительный AST не трансформируется вовсе (источник
 *       семантически исходный) — консервативный отказ.
 *   C4. Executor (private runtime) ведёт себя как nano.animate для того же
 *       вызова: те же keyframes/timing, reduced-политика и finished-протокол.
 */

import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  COMPILED_IMPORT_SOURCE,
  compileNanoOpacityArtifact,
  nanoArtifactLiteral,
  planNanoOpacityLowering,
  type AstNode,
} from '../src/compiler/core.js';
import { motionCompiler } from '../src/compiler/vite/index.js';
import { animateCompiled } from '../src/compiler/runtime/index.js';
import { animate as nanoAnimate } from '../src/nano/index.js';
import { springLinear } from '../src/nano/spring-linear.js';

// ─── Хелперы ─────────────────────────────────────────────────────────────────

async function applyPlugin(code: string): Promise<string | undefined> {
  const plugin = motionCompiler();
  const context = { parse: (source: string) => { throw new Error('sync parse не используется в тесте: ' + source.length); } };
  // Vite отдаёт тот же acorn-AST, что this.parse Rollup-контекста.
  const ast = await parseAstAsync(code);
  const result = plugin.transform.call(
    { parse: () => ast },
    code,
    '/app/module.ts',
  );
  return result?.code;
}

async function plan(code: string) {
  const ast = await parseAstAsync(code);
  return planNanoOpacityLowering(ast as unknown as AstNode, nanoArtifactLiteral);
}

const POSITIVE = `import { animate } from '@labpics/motion/nano';
export function open(card) {
  return animate(card, { opacity: 1 });
}
`;

// ─── C1: артефакт ────────────────────────────────────────────────────────────

describe('compileNanoOpacityArtifact — доверенный артефакт nano SSOT', () => {
  it('durationMs и cssLinear бит-в-бит равны springLinear() nano', () => {
    const [durationMs, cssLinear] = springLinear();
    const artifact = compileNanoOpacityArtifact(0.25);
    expect(artifact.durationMs).toBe(durationMs);
    expect(artifact.cssLinear).toBe(cssLinear);
    expect(artifact.frame).toEqual({ opacity: 0.25 });
  });

  it('литерал артефакта детерминирован и парсится обратно', () => {
    const literal = nanoArtifactLiteral(1);
    expect(nanoArtifactLiteral(1)).toBe(literal);
    const parsed = JSON.parse(
      literal.replace(/([{,])([a-z]+):/g, '$1"$2":'),
    ) as { o: number; d: number; e: string };
    const [durationMs, cssLinear] = springLinear();
    expect(parsed).toEqual({ o: 1, d: durationMs, e: cssLinear });
  });

  it('нечисловая/неконечная opacity — ошибка сборки, не silent fallback', () => {
    expect(() => compileNanoOpacityArtifact(Number.NaN)).toThrow();
    expect(() => compileNanoOpacityArtifact(Number.POSITIVE_INFINITY)).toThrow();
  });
});

// ─── C2: позитивное понижение ────────────────────────────────────────────────

describe('позитивный паттерн — единственный, который понижается', () => {
  it('вызов заменяется executor-вызовом; target остаётся байт-в-байт', async () => {
    const output = await applyPlugin(POSITIVE);
    expect(output).toBeDefined();
    expect(output).toContain('__labMotionNanoCompiled(card, {o:1,d:');
    expect(output).toContain(
      `import { animateCompiled as __labMotionNanoCompiled } from "${COMPILED_IMPORT_SOURCE}";`,
    );
    // Исходный вызов исчез, повторного animate-идентификатора не осталось.
    expect(output).not.toContain('animate(card');
    // Исходные строки не сдвинуты: импорт дописан в конец (hoisted ESM).
    expect(output!.startsWith("import { animate } from '@labpics/motion/nano';")).toBe(true);
  });

  it('несколько валидных вызовов понижаются все, литералы независимы', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
animate(a, { opacity: 0 });
animate(b, { opacity: 0.5 });
`);
    expect(output).toContain('(a, {o:0,d:');
    expect(output).toContain('(b, {o:0.5,d:');
    expect((output!.match(/__labMotionNanoCompiled\(/g) ?? []).length).toBe(2);
  });

  it('смешанный модуль: валидный понижается, динамический остаётся runtime', async () => {
    const result = await plan(`import { animate } from '@labpics/motion/nano';
animate(a, { opacity: 1 });
animate(b, { opacity: level });
`);
    expect(result).toBeDefined();
    expect(result!.edits).toHaveLength(2); // одна пара правок одного вызова
    expect(result!.runtimeCalls).toBe(1);
  });
});

// ─── C3: hostile AST-negative corpus ─────────────────────────────────────────

describe('консервативный отказ: источник остаётся семантически исходным', () => {
  const CASES: readonly [name: string, code: string][] = [
    ['alias-импорт', `import { animate as go } from '@labpics/motion/nano'; go(el, { opacity: 1 });`],
    ['namespace-импорт', `import * as nano from '@labpics/motion/nano'; nano.animate(el, { opacity: 1 });`],
    ['чужой пакет', `import { animate } from 'other-motion'; animate(el, { opacity: 1 });`],
    ['shadowing функцией', `import { animate } from '@labpics/motion/nano';
function scope(animate) { return animate(el, { opacity: 1 }); }`],
    ['shadowing переменной', `import { animate } from '@labpics/motion/nano';
{ const animate = fake; animate(el, { opacity: 1 }); }`],
    ['третий аргумент', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: 1 }, {});`],
    ['один аргумент', `import { animate } from '@labpics/motion/nano'; animate(el);`],
    ['spread-аргумент', `import { animate } from '@labpics/motion/nano'; animate(...args);`],
    ['spread в props', `import { animate } from '@labpics/motion/nano'; animate(el, { ...rest });`],
    ['computed key', `import { animate } from '@labpics/motion/nano'; animate(el, { ['opacity']: 1 });`],
    ['строковый key', `import { animate } from '@labpics/motion/nano'; animate(el, { 'opacity': 1 });`],
    ['getter', `import { animate } from '@labpics/motion/nano'; animate(el, { get opacity() { return 1; } });`],
    ['unary minus', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: -0.5 });`],
    ['unary plus', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: +1 });`],
    ['переменная значением', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: level });`],
    ['Infinity идентификатором', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: Infinity });`],
    ['вторая property', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: 1, scale: 2 });`],
    ['shorthand property', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity });`],
    ['optional call', `import { animate } from '@labpics/motion/nano'; animate?.(el, { opacity: 1 });`],
    ['метод вместо значения', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity() { return 1; } });`],
    ['строковое значение', `import { animate } from '@labpics/motion/nano'; animate(el, { opacity: '1' });`],
    ['коллизия локального имени', `import { animate } from '@labpics/motion/nano';
const __labMotionNanoCompiled = 1; animate(el, { opacity: 1 });`],
  ];

  for (const [name, code] of CASES) {
    it(`${name} → без трансформации`, async () => {
      expect(await plan(code)).toBeUndefined();
    });
  }

  it('re-export nano не трансформируется', async () => {
    expect(await plan(`export { animate } from '@labpics/motion/nano';`)).toBeUndefined();
  });
});

// ─── C4: executor ≡ nano для того же вызова ──────────────────────────────────

interface JournalEntry {
  frame: Record<string, unknown>;
  options: Record<string, unknown>;
}

function fakeElement(journal: JournalEntry[]): Element {
  return {
    animate(frame: Record<string, unknown>, options: Record<string, unknown>) {
      journal.push({ frame, options });
      return {
        finished: new Promise(() => {}),
        addEventListener() {},
        commitStyles() {},
        cancel() {},
      };
    },
  } as unknown as Element;
}

describe('animateCompiled ≡ nano.animate для позитивного паттерна', () => {
  it('идентичные keyframes и WAAPI-опции (обычный режим)', () => {
    const nanoJournal: JournalEntry[] = [];
    const compiledJournal: JournalEntry[] = [];
    nanoAnimate(fakeElement(nanoJournal), { opacity: 0.25 });
    const artifact = compileNanoOpacityArtifact(0.25);
    animateCompiled(fakeElement(compiledJournal), {
      o: artifact.frame.opacity,
      d: artifact.durationMs,
      e: artifact.cssLinear,
    });
    expect(compiledJournal).toEqual(nanoJournal);
  });

  it('reduced-motion: duration 0 и linear, как у nano', () => {
    const original = globalThis.matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia =
      () => ({ matches: true });
    try {
      const nanoJournal: JournalEntry[] = [];
      const compiledJournal: JournalEntry[] = [];
      nanoAnimate(fakeElement(nanoJournal), { opacity: 1 });
      const artifact = compileNanoOpacityArtifact(1);
      animateCompiled(fakeElement(compiledJournal), {
        o: 1,
        d: artifact.durationMs,
        e: artifact.cssLinear,
      });
      expect(compiledJournal).toEqual(nanoJournal);
      expect(compiledJournal[0]!.options['duration']).toBe(0);
      expect(compiledJournal[0]!.options['easing']).toBe('linear');
    } finally {
      if (original === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia;
      else globalThis.matchMedia = original;
    }
  });

  it('finished-агрегат и controls-массив совпадают по форме', () => {
    const journal: JournalEntry[] = [];
    const artifact = compileNanoOpacityArtifact(1);
    const controls = animateCompiled(fakeElement(journal), {
      o: 1,
      d: artifact.durationMs,
      e: artifact.cssLinear,
    });
    expect(Array.isArray(controls)).toBe(true);
    expect(controls).toHaveLength(1);
    expect(controls.finished).toBeInstanceOf(Promise);
  });
});
