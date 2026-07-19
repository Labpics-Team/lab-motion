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

async function transform(code: string) {
  const plugin = motionCompiler();
  // Vite отдаёт тот же acorn-AST, что this.parse Rollup-контекста.
  const ast = await parseAstAsync(code);
  return plugin.transform.call({ parse: () => ast }, code, '/app/module.ts');
}

async function applyPlugin(code: string): Promise<string | undefined> {
  return (await transform(code))?.code;
}

async function plan(code: string) {
  const ast = await parseAstAsync(code);
  return planNanoOpacityLowering(ast as unknown as AstNode, code, nanoArtifactLiteral);
}

/** Декодер mappings v3 (обратный к VLQ-энкодеру адаптера) для карт-ассертов. */
function decodeMappings(mappings: string): [gen: number, line: number, col: number][][] {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let sourceLine = 0;
  let sourceColumn = 0;
  return mappings.split(';').map((group) => {
    let genColumn = 0;
    if (group === '') return [];
    return group.split(',').map((seg) => {
      const values: number[] = [];
      let shift = 0;
      let value = 0;
      for (const char of seg) {
        const digit = CHARS.indexOf(char);
        value |= (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          shift = 0;
          value = 0;
        }
      }
      genColumn += values[0]!;
      sourceLine += values[2]!;
      sourceColumn += values[3]!;
      return [genColumn, sourceLine, sourceColumn] as [number, number, number];
    });
  });
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
  // Модульные отказы: план undefined целиком (доверять нечему).
  const MODULE_CASES: readonly [name: string, code: string][] = [
    ['alias-импорт', `import { animate as go } from '@labpics/motion/nano'; go(el, { opacity: 1 });`],
    ['namespace-импорт', `import * as nano from '@labpics/motion/nano'; nano.animate(el, { opacity: 1 });`],
    ['чужой пакет', `import { animate } from 'other-motion'; animate(el, { opacity: 1 });`],
    ['shadowing функцией', `import { animate } from '@labpics/motion/nano';
function scope(animate) { return animate(el, { opacity: 1 }); }`],
    ['shadowing переменной', `import { animate } from '@labpics/motion/nano';
{ const animate = fake; animate(el, { opacity: 1 }); }`],
    ['коллизия локального имени', `import { animate } from '@labpics/motion/nano';
const __labMotionNanoCompiled = 1; animate(el, { opacity: 1 });`],
  ];

  for (const [name, code] of MODULE_CASES) {
    it(`${name} → без трансформации модуля`, async () => {
      expect(await plan(code)).toBeUndefined();
    });
  }

  // Отказ по вызову: hostile-вызов остаётся runtime, а контрольный валидный
  // в том же модуле ОБЯЗАН понизиться — пин того, что сработал именно guard
  // вызова, а не «ничего не совпало» (false-green класса нулевого матчинга).
  const PER_CALL_CASES: readonly [name: string, call: string][] = [
    ['третий аргумент', `animate(el, { opacity: 1 }, {});`],
    ['один аргумент', `animate(el);`],
    ['spread-аргумент', `animate(...args);`],
    ['spread в props', `animate(el, { ...rest });`],
    ['computed key', `animate(el, { ['opacity']: 1 });`],
    ['строковый key', `animate(el, { 'opacity': 1 });`],
    ['getter', `animate(el, { get opacity() { return 1; } });`],
    ['unary minus', `animate(el, { opacity: -0.5 });`],
    ['unary plus', `animate(el, { opacity: +1 });`],
    ['переменная значением', `animate(el, { opacity: level });`],
    ['Infinity идентификатором', `animate(el, { opacity: Infinity });`],
    ['вторая property', `animate(el, { opacity: 1, scale: 2 });`],
    ['shorthand property', `animate(el, { opacity });`],
    ['optional call', `animate?.(el, { opacity: 1 });`],
    ['метод вместо значения', `animate(el, { opacity() { return 1; } });`],
    ['строковое значение', `animate(el, { opacity: '1' });`],
    ['скобки вокруг callee', `(animate)(el, { opacity: 1 });`],
    ['sequence в скобках как target', `animate((x, y), { opacity: 1 });`],
    ['комментарий в тривиа-зоне', `animate(/* hostile */ el, { opacity: 1 });`],
  ];

  for (const [name, call] of PER_CALL_CASES) {
    it(`${name} → вызов остаётся runtime, контрольный понижается`, async () => {
      const result = await plan(`import { animate } from '@labpics/motion/nano';
${call}
animate(ok, { opacity: 1 });
`);
      expect(result).toBeDefined();
      expect(result!.edits).toHaveLength(2); // ровно контрольный вызов
      expect(result!.runtimeCalls).toBe(1); // hostile-вызов сохранён
    });
  }

  it('re-export nano не трансформируется', async () => {
    expect(await plan(`export { animate } from '@labpics/motion/nano';`)).toBeUndefined();
  });

  it('отдельный export-statement: вызов понижается, nano-импорт сохраняется', async () => {
    // Re-export живого биндинга обязан продолжать указывать на настоящий
    // nano-animate: lowering не смеет удалять исходный импорт.
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
export { animate };
animate(el, { opacity: 1 });
`);
    expect(output).toBeDefined();
    expect(output).toContain(`import { animate } from '@labpics/motion/nano';`);
    expect(output).toContain('export { animate };');
    expect(output).toContain('__labMotionNanoCompiled(el, {o:1,d:');
  });
});

describe('вложенные и многострочные вызовы', () => {
  it('вложенный lowerable-вызов в позиции target понижается вместе с внешним', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
export const r = animate(animate(x, { opacity: 1 }), { opacity: 0.5 });
`);
    expect(output).toBeDefined();
    // Оба вызова понижены, target внешнего — понижённый внутренний.
    expect(output).toContain('__labMotionNanoCompiled(__labMotionNanoCompiled(x, {o:1,d:');
    expect((output!.match(/__labMotionNanoCompiled\(/g) ?? []).length).toBe(2);
    // Выход обязан парситься (регрессия: несортированные правки дублировали хвост).
    await expect(parseAstAsync(output!)).resolves.toBeDefined();
  });

  it('многострочный вызов (Prettier-формат) понижается со схлопыванием строк', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
export function open(card) {
  return animate(card, {
    opacity: 1,
  });
}
`);
    expect(output).toBeDefined();
    expect(output).toContain('__labMotionNanoCompiled(card, {o:1,d:');
    await expect(parseAstAsync(output!)).resolves.toBeDefined();
  });
});

describe('sourcemap адаптера', () => {
  it('sources несёт id модуля и sourcesContent — байты исходника', async () => {
    const result = await transform(POSITIVE);
    expect(result!.map.sources).toEqual(['/app/module.ts']);
    expect(result!.map.sourcesContent).toEqual([POSITIVE]);
  });

  it('однострочный вызов: target и хвост строки мапятся точно', async () => {
    const result = await transform(POSITIVE);
    const decoded = decodeMappings(result!.map.mappings);
    const genLines = result!.code.split('\n');
    // 'card' в сгенерированной строке 2 обязан указывать на исходную позицию.
    const genLine = 1;
    const genCol = genLines[genLine]!.indexOf('card');
    const origCol = POSITIVE.split('\n')[1]!.indexOf('card');
    expect(genCol).toBeGreaterThan(-1);
    const hit = decoded[genLine]!.filter(([g]) => g <= genCol).at(-1)!;
    expect(hit[1]).toBe(1); // исходная строка
    expect(genCol - hit[0] + hit[2]).toBe(origCol); // точная колонка
  });

  it('многострочный вызов: строки ПОСЛЕ схлопнутого вызова мапятся верно', async () => {
    const source = `import { animate } from '@labpics/motion/nano';
export function open(card) {
  return animate(card, {
    opacity: 1,
  });
}
next();
`;
    const result = await transform(source);
    const decoded = decodeMappings(result!.map.mappings);
    const genLines = result!.code.split('\n');
    const genNext = genLines.findIndex((line) => line.startsWith('next()'));
    expect(genNext).toBeGreaterThan(-1);
    // next() в исходнике — строка 6 (0-базно); карта обязана указать на неё.
    expect(decoded[genNext]![0]![1]).toBe(6);
    // Дописанный импорт executor не мапится в пользовательский код.
    const genImport = genLines.findIndex((line) => line.startsWith('import { animateCompiled'));
    expect(decoded[genImport] ?? []).toEqual([]);
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
