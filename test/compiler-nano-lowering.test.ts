/**
 * test/compiler-nano-lowering.test.ts — compiler proof #208 + #221: артефакт,
 * AST-план и Vite-адаптер lowering статических NanoProps/NanoOptions
 * (`animate(target, props, options?)`, spring-режим) из '@labpics/motion/nano'.
 *
 * Инварианты:
 *   C1. Артефакт бит-в-бит совпадает с nano SSOT (кадр по семантике
 *       nano/index.ts включая порядок ключей и `${rotate}deg`; springLinear
 *       с теми же дефолтами частичной пружины) и проходит канонический
 *       parseMotionProgramV1 (единственный оракул доверия; multi-prop кадр —
 *       standard opacity + escaped webCssOpaque/scalar каналы).
 *   C2. Позитивный паттерн понижается: вызов заменяется executor-вызовом с
 *       литеральным артефактом, target-выражение остаётся байт-в-байт и
 *       вычисляется ровно один раз в исходном порядке. Options-формы:
 *       отсутствуют / {} / spring / delay / stagger / reducedMotion.
 *   C3. Hostile/сомнительный AST не трансформируется вовсе (источник
 *       семантически исходный) — консервативный отказ; tween-режим
 *       {duration, ease} — осознанный runtime (V1 не выражает нативную
 *       easing-строку без потери).
 *   C4. Executor (private runtime) ведёт себя как nano.animate для того же
 *       вызова: те же keyframes/timing (включая delay+stagger·index и
 *       explicit/ambient reduced-политику) и finished-протокол.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  COMPILED_IMPORT_SOURCE,
  compileNanoCallArtifact,
  nanoArtifactLiteral,
  planNanoLowering,
  type AstNode,
} from '../src/compiler/core.js';
import { motionCompiler } from '../src/compiler/vite/index.js';
import { animateCompiled, type CompiledNanoCall } from '../src/compiler/runtime/index.js';
import { animate as nanoAnimate, type NanoOptions } from '../src/nano/index.js';
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
  return planNanoLowering(ast as unknown as AstNode, code, nanoArtifactLiteral);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── C1: артефакт ────────────────────────────────────────────────────────────

describe('compileNanoCallArtifact — доверенный артефакт nano SSOT', () => {
  it('durationMs и cssLinear бит-в-бит равны springLinear() nano (дефолт)', () => {
    const [durationMs, cssLinear] = springLinear();
    const artifact = compileNanoCallArtifact({ opacity: 0.25 });
    expect(artifact.durationMs).toBe(durationMs);
    expect(artifact.cssLinear).toBe(cssLinear);
    expect(artifact.frame).toEqual({ opacity: 0.25 });
  });

  it('явная и ЧАСТИЧНАЯ пружина получают те же дефолты, что nano runtime', () => {
    const explicit = springLinear({ mass: 2, stiffness: 300, damping: 30 });
    expect(compileNanoCallArtifact({ opacity: 1 }, {
      spring: { mass: 2, stiffness: 300, damping: 30 },
    }).cssLinear).toBe(explicit[1]);
    // Частичная {stiffness: 200} ≡ {mass:1, stiffness:200, damping:26} — как
    // читает springLinear через `?? 170/26/1`.
    const partial = springLinear({ mass: 1, stiffness: 200, damping: 26 });
    const artifact = compileNanoCallArtifact({ opacity: 1 }, { spring: { stiffness: 200 } });
    expect(artifact.durationMs).toBe(partial[0]);
    expect(artifact.cssLinear).toBe(partial[1]);
  });

  it('multi-prop кадр воспроизводит порядок и `${rotate}deg` nano', () => {
    const artifact = compileNanoCallArtifact({
      translate: '120px 0',
      opacity: 1,
      rotate: 8,
      scale: 1.04,
      filter: 'blur(0px)',
    });
    // nano: единый цикл — авторский порядок ключей, rotate с deg-суффиксом.
    expect(Object.entries(artifact.frame)).toEqual([
      ['translate', '120px 0'],
      ['opacity', 1],
      ['rotate', '8deg'],
      ['scale', 1.04],
      ['filter', 'blur(0px)'],
    ]);
  });

  it('литерал артефакта детерминирован и парсится обратно (полные options)', () => {
    const literal = nanoArtifactLiteral(
      { opacity: 1, translate: '10px 0' },
      { delay: 40, stagger: 20, reducedMotion: false },
    );
    expect(nanoArtifactLiteral(
      { opacity: 1, translate: '10px 0' },
      { delay: 40, stagger: 20, reducedMotion: false },
    )).toBe(literal);
    expect(literal.includes('\n')).toBe(false);
    const parsed = JSON.parse(
      literal.replace(/([{,])([a-zA-Z]+):/g, '$1"$2":'),
    ) as CompiledNanoCall;
    const [durationMs, cssLinear] = springLinear();
    expect(parsed).toEqual({
      f: { opacity: 1, translate: '10px 0' },
      d: durationMs,
      e: cssLinear,
      y: 40,
      g: 20,
      r: 0,
    });
  });

  it('незатухающая статическая пружина — ошибка сборки, не silent fallback', () => {
    expect(() => compileNanoCallArtifact({ opacity: 1 }, {
      spring: { mass: 1, stiffness: 100, damping: 0 },
    })).toThrow(RangeError);
    expect(() => compileNanoCallArtifact({ opacity: Number.NaN })).toThrow();
  });

  it('пустой кадр не понижается (ошибка артефакта)', () => {
    expect(() => compileNanoCallArtifact({})).toThrow();
  });
});

// ─── C2: позитивное понижение ────────────────────────────────────────────────

describe('позитивный паттерн — понижается', () => {
  it('вызов заменяется executor-вызовом; target остаётся байт-в-байт', async () => {
    const output = await applyPlugin(POSITIVE);
    expect(output).toBeDefined();
    expect(output).toContain('__labMotionNanoCompiled(card, {f:{opacity:1},d:');
    expect(output).toContain(
      `import { animateCompiled as __labMotionNanoCompiled } from "${COMPILED_IMPORT_SOURCE}";`,
    );
    // Исходный вызов исчез, повторного animate-идентификатора не осталось.
    expect(output).not.toContain('animate(card');
    // Исходные строки не сдвинуты: импорт дописан в конец (hoisted ESM).
    expect(output!.startsWith("import { animate } from '@labpics/motion/nano';")).toBe(true);
  });

  it('полный common-motion вызов (#220) понижается с options', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
animate(el, { translate: '120px 0', scale: 1, rotate: 8, opacity: 1 }, {
  spring: { mass: 1, stiffness: 170, damping: 26 },
  delay: 40,
  stagger: 20,
});
`);
    expect(output).toBeDefined();
    expect(output).toContain(
      '__labMotionNanoCompiled(el, {f:{translate:"120px 0",scale:1,rotate:"8deg",opacity:1},d:',
    );
    expect(output).toContain(',y:40,g:20}');
    await expect(parseAstAsync(output!)).resolves.toBeDefined();
  });

  it('пустые options {} эквивалентны отсутствию (дефолтная пружина)', async () => {
    const result = await plan(`import { animate } from '@labpics/motion/nano';
animate(el, { opacity: 1 }, {});
`);
    expect(result).toBeDefined();
    expect(result!.edits).toHaveLength(2);
    expect(result!.runtimeCalls).toBe(0);
  });

  it('explicit reducedMotion сериализуется в r:1/r:0', async () => {
    const on = await applyPlugin(`import { animate } from '@labpics/motion/nano';
animate(el, { opacity: 1 }, { reducedMotion: true });
`);
    expect(on).toContain(',r:1}');
    const off = await applyPlugin(`import { animate } from '@labpics/motion/nano';
animate(el, { opacity: 1 }, { reducedMotion: false });
`);
    expect(off).toContain(',r:0}');
  });

  it('несколько валидных вызовов понижаются все, литералы независимы', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
animate(a, { opacity: 0 });
animate(b, { opacity: 0.5 });
`);
    expect(output).toContain('(a, {f:{opacity:0},d:');
    expect(output).toContain('(b, {f:{opacity:0.5},d:');
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
  // Модульные отказы (#237): план без правок, но с МОДУЛЬНЫМ refusal —
  // ./nano удерживается в графе, strict обязан это видеть. Адаптер модуль
  // не трансформирует. Чужой пакет — по-прежнему undefined (не при делах).
  const MODULE_CASES: readonly [name: string, code: string][] = [
    ['alias-импорт', `import { animate as go } from '@labpics/motion/nano'; go(el, { opacity: 1 });`],
    ['namespace-импорт', `import * as nano from '@labpics/motion/nano'; nano.animate(el, { opacity: 1 });`],
    ['shadowing функцией', `import { animate } from '@labpics/motion/nano';
function scope(animate) { return animate(el, { opacity: 1 }); }`],
    ['shadowing переменной', `import { animate } from '@labpics/motion/nano';
{ const animate = fake; animate(el, { opacity: 1 }); }`],
    ['коллизия локального имени', `import { animate } from '@labpics/motion/nano';
const __labMotionNanoCompiled = 1; animate(el, { opacity: 1 });`],
  ];

  for (const [name, code] of MODULE_CASES) {
    it(`${name} → без трансформации модуля, но с модульным refusal`, async () => {
      const p = await plan(code);
      expect(p).toBeDefined();
      expect(p!.edits).toHaveLength(0);
      expect(p!.refusals).toHaveLength(1);
      expect(await applyPlugin(code)).toBeUndefined();
    });
  }

  it('чужой пакет → план undefined целиком (не при делах)', async () => {
    expect(await plan(`import { animate } from 'other-motion'; animate(el, { opacity: 1 });`))
      .toBeUndefined();
  });

  // Отказ по вызову: hostile-вызов остаётся runtime, а контрольный валидный
  // в том же модуле ОБЯЗАН понизиться — пин того, что сработал именно guard
  // вызова, а не «ничего не совпало» (false-green класса нулевого матчинга).
  const PER_CALL_CASES: readonly [name: string, call: string][] = [
    ['четвёртый аргумент', `animate(el, { opacity: 1 }, {}, extra);`],
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
    ['shorthand property', `animate(el, { opacity });`],
    ['дубликат ключа props', `animate(el, { opacity: 1, opacity: 0 });`],
    ['пустые props', `animate(el, {});`],
    ['scale строкой', `animate(el, { scale: '2' });`],
    ['rotate строкой', `animate(el, { rotate: '8deg' });`],
    ['optional call', `animate?.(el, { opacity: 1 });`],
    ['метод вместо значения', `animate(el, { opacity() { return 1; } });`],
    ['tween-режим duration', `animate(el, { opacity: 1 }, { duration: 200 });`],
    ['tween-режим ease', `animate(el, { opacity: 1 }, { duration: 200, ease: 'ease-out' });`],
    ['неизвестный ключ options', `animate(el, { opacity: 1 }, { onFinish: cb });`],
    ['options переменной', `animate(el, { opacity: 1 }, opts);`],
    ['spread в options', `animate(el, { opacity: 1 }, { ...opts });`],
    ['spring переменной', `animate(el, { opacity: 1 }, { spring: theSpring });`],
    ['spring с лишним ключом', `animate(el, { opacity: 1 }, { spring: { mass: 1, bounce: 1 } });`],
    ['spring со spread', `animate(el, { opacity: 1 }, { spring: { ...base } });`],
    ['delay переменной', `animate(el, { opacity: 1 }, { delay: wait });`],
    ['stagger unary minus', `animate(el, { opacity: 1 }, { stagger: -20 });`],
    ['reducedMotion не boolean', `animate(el, { opacity: 1 }, { reducedMotion: 1 });`],
    ['дубликат ключа options', `animate(el, { opacity: 1 }, { delay: 1, delay: 2 });`],
    ['getter в options', `animate(el, { opacity: 1 }, { get delay() { return 1; } });`],
    ['скобки вокруг callee', `(animate)(el, { opacity: 1 });`],
    ['sequence в скобках как target', `animate((x, y), { opacity: 1 });`],
    ['комментарий в тривиа-зоне', `animate(/* hostile */ el, { opacity: 1 });`],
    ['комментарий перед options', `animate(el, { opacity: 1 } /* hostile */, {});`],
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

  it('re-export nano не трансформируется, но даёт модульный refusal (#237)', async () => {
    const p = await plan(`export { animate } from '@labpics/motion/nano';`);
    expect(p).toBeDefined();
    expect(p!.edits).toHaveLength(0);
    expect(p!.refusals).toHaveLength(1);
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
    expect(output).toContain('__labMotionNanoCompiled(el, {f:{opacity:1},d:');
  });

  it('невалидная доказанно-статическая пружина — ошибка сборки с причиной', async () => {
    await expect(plan(`import { animate } from '@labpics/motion/nano';
animate(el, { opacity: 1 }, { spring: { mass: 1, stiffness: 100, damping: 0 } });
`)).rejects.toThrow(/статический nano-вызов невалиден/);
  });
});

describe('вложенные и многострочные вызовы', () => {
  it('вложенный lowerable-вызов в позиции target понижается вместе с внешним', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
export const r = animate(animate(x, { opacity: 1 }), { opacity: 0.5 });
`);
    expect(output).toBeDefined();
    // Оба вызова понижены, target внешнего — понижённый внутренний.
    expect(output).toContain('__labMotionNanoCompiled(__labMotionNanoCompiled(x, {f:{opacity:1},d:');
    expect((output!.match(/__labMotionNanoCompiled\(/g) ?? []).length).toBe(2);
    // Выход обязан парситься (регрессия: несортированные правки дублировали хвост).
    await expect(parseAstAsync(output!)).resolves.toBeDefined();
  });

  it('многострочный вызов (Prettier-формат, с options) понижается со схлопыванием строк', async () => {
    const output = await applyPlugin(`import { animate } from '@labpics/motion/nano';
export function open(card) {
  return animate(card, {
    opacity: 1,
  }, {
    delay: 40,
  });
}
`);
    expect(output).toBeDefined();
    expect(output).toContain('__labMotionNanoCompiled(card, {f:{opacity:1},d:');
    expect(output).toContain(',y:40}');
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

/** Артефакт статического вызова как построил бы его compiler. */
function artifactOf(
  props: Readonly<Record<string, number | string>>,
  options: Parameters<typeof compileNanoCallArtifact>[1] = {},
): CompiledNanoCall {
  const compiled = compileNanoCallArtifact(props, options);
  const artifact: {
    f: Readonly<Record<string, number | string>>;
    d: number;
    e: string;
    y?: number;
    g?: number;
    r?: 0 | 1;
  } = { f: compiled.frame, d: compiled.durationMs, e: compiled.cssLinear };
  if (compiled.delay !== undefined) artifact.y = compiled.delay;
  if (compiled.stagger !== undefined) artifact.g = compiled.stagger;
  if (compiled.reducedMotion !== undefined) artifact.r = compiled.reducedMotion ? 1 : 0;
  return artifact;
}

describe('animateCompiled ≡ nano.animate для позитивного паттерна', () => {
  const MATRIX: readonly [
    name: string,
    props: Record<string, number | string>,
    options: NanoOptions & Parameters<typeof compileNanoCallArtifact>[1],
  ][] = [
    ['дефолтная пружина', { opacity: 0.25 }, {}],
    ['multi-prop кадр', { translate: '120px 0', scale: 1.04, rotate: 8, opacity: 1, filter: 'blur(0px)' }, {}],
    ['явная пружина', { opacity: 1 }, { spring: { mass: 2, stiffness: 300, damping: 30 } }],
    ['delay', { opacity: 1 }, { delay: 40 }],
    ['delay + stagger', { opacity: 1 }, { delay: 40, stagger: 20 }],
    ['explicit reducedMotion: false подавляет ambient', { opacity: 1 }, { reducedMotion: false }],
  ];

  for (const [name, props, options] of MATRIX) {
    it(`идентичные keyframes и WAAPI-опции на группе целей — ${name}`, () => {
      const nanoJournal: JournalEntry[] = [];
      const compiledJournal: JournalEntry[] = [];
      const nanoTargets = [fakeElement(nanoJournal), fakeElement(nanoJournal)];
      const compiledTargets = [fakeElement(compiledJournal), fakeElement(compiledJournal)];
      nanoAnimate(nanoTargets, props, options as NanoOptions);
      animateCompiled(compiledTargets, artifactOf(props, options));
      expect(compiledJournal).toEqual(nanoJournal);
      // toEqual нечувствителен к порядку ключей — байт-паритет кадра пинится
      // отдельно (порядок разъехался незамеченным при слиянии циклов nano).
      expect(compiledJournal.map((entry) => Object.keys(entry.frame)))
        .toEqual(nanoJournal.map((entry) => Object.keys(entry.frame)));
      expect(compiledJournal).toHaveLength(2);
    });
  }

  it('ambient reduced-motion: duration 0 и linear, как у nano', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const nanoJournal: JournalEntry[] = [];
    const compiledJournal: JournalEntry[] = [];
    nanoAnimate(fakeElement(nanoJournal), { opacity: 1 }, { delay: 40, stagger: 20 });
    animateCompiled(fakeElement(compiledJournal), artifactOf({ opacity: 1 }, { delay: 40, stagger: 20 }));
    expect(compiledJournal).toEqual(nanoJournal);
    expect(compiledJournal[0]!.options['duration']).toBe(0);
    expect(compiledJournal[0]!.options['easing']).toBe('linear');
    expect(compiledJournal[0]!.options['delay']).toBe(0);
  });

  it('explicit reducedMotion: true схлопывает без ambient matchMedia', () => {
    const nanoJournal: JournalEntry[] = [];
    const compiledJournal: JournalEntry[] = [];
    nanoAnimate(fakeElement(nanoJournal), { opacity: 1 }, { reducedMotion: true });
    animateCompiled(fakeElement(compiledJournal), artifactOf({ opacity: 1 }, { reducedMotion: true }));
    expect(compiledJournal).toEqual(nanoJournal);
    expect(compiledJournal[0]!.options['duration']).toBe(0);
  });

  it('один frame-объект на вызов (не на элемент) — паритет с nano', () => {
    const journal: JournalEntry[] = [];
    animateCompiled(
      [fakeElement(journal), fakeElement(journal)],
      artifactOf({ opacity: 1 }),
    );
    expect(journal[0]!.frame).toBe(journal[1]!.frame);
  });

  it('finished-агрегат и controls-массив совпадают по форме', () => {
    const journal: JournalEntry[] = [];
    const controls = animateCompiled(fakeElement(journal), artifactOf({ opacity: 1 }));
    expect(Array.isArray(controls)).toBe(true);
    expect(controls).toHaveLength(1);
    expect(controls.finished).toBeInstanceOf(Promise);
  });
});

// ─── strict-режим, @motion-runtime и леджер (#237) ───────────────────────────
//
// Контракт: план несёт refusals ({start, reason}) для КАЖДОГО непониженного
// вызова без маркера `@motion-runtime`; strict-режим адаптера превращает
// первый такой отказ в ошибку сборки с файлом и line:col; onBudget отдаёт
// квитанцию build-фактов. Mutation proof: убрать refuse()-причины → тест
// причин падает; убрать positionAt → strict-тест позиции падает.

describe('strict-режим и compiled-леджер (#237)', () => {
  const DYNAMIC = `import { animate } from '@labpics/motion/nano';
export function play(el, v) { return animate(el, { opacity: v }); }
`;
  const MARKED = `import { animate } from '@labpics/motion/nano';
export function play(el, v) { return /* @motion-runtime */ animate(el, { opacity: v }); }
`;
  const MIXED = `import { animate } from '@labpics/motion/nano';
export function play(el, v) {
  animate(el, { opacity: 0.5 });
  return animate(el, { opacity: v });
}
`;

  it('план: refusal с причиной и offset; edits пусты — адаптер не трансформирует', async () => {
    const p = await plan(DYNAMIC);
    expect(p).toBeDefined();
    expect(p!.edits).toHaveLength(0);
    expect(p!.runtimeCalls).toBe(1);
    expect(p!.refusals).toHaveLength(1);
    expect(p!.refusals[0]!.reason).toContain('props');
    expect(DYNAMIC.slice(p!.refusals[0]!.start)).toMatch(/^animate\(/);
    expect(await applyPlugin(DYNAMIC)).toBeUndefined();
  });

  it('маркер @motion-runtime: вызов легитимно рантаймовый — не в refusals, но в runtimeCalls', async () => {
    const p = await plan(MARKED);
    expect(p).toBeUndefined(); // ни правок, ни отказов — модуль не при делах
  });

  it('strict: ошибка сборки с id, line:col и причиной', async () => {
    const plugin = motionCompiler({ strict: true });
    const ast = await parseAstAsync(DYNAMIC);
    expect(() => plugin.transform.call({ parse: () => ast }, DYNAMIC, '/app/module.ts'))
      .toThrow(/strict: непониженный nano-вызов \/app\/module\.ts:2:38 — props не доказаны статическими/);
  });

  it('strict: маркер @motion-runtime пропускает вызов без ошибки', async () => {
    const plugin = motionCompiler({ strict: true });
    const ast = await parseAstAsync(MARKED);
    expect(plugin.transform.call({ parse: () => ast }, MARKED, '/app/module.ts')).toBeUndefined();
  });

  it('strict: смешанный модуль падает ДО частичного понижения (нет дуал-шипа)', async () => {
    const plugin = motionCompiler({ strict: true });
    const ast = await parseAstAsync(MIXED);
    expect(() => plugin.transform.call({ parse: () => ast }, MIXED, '/app/mixed.ts'))
      .toThrow(/strict/);
  });

  it('strict видит МОДУЛЬНЫЕ формы удержания ./nano: alias/namespace/re-export — refusal', async () => {
    const forms = [
      `import { animate as go } from '@labpics/motion/nano';\nexport const play = (el, v) => go(el, { opacity: v });\n`,
      `import * as m from '@labpics/motion/nano';\nexport const play = (el, v) => m.animate(el, { opacity: v });\n`,
      `export { animate } from '@labpics/motion/nano';\n`,
      `import '@labpics/motion/nano';\n`,
    ];
    for (const code of forms) {
      const p = await plan(code);
      expect(p, code).toBeDefined();
      expect(p!.edits, code).toHaveLength(0);
      expect(p!.refusals, code).toHaveLength(1);
      expect(p!.refusals[0]!.reason, code).toContain('неанализируемой форме');
      const plugin = motionCompiler({ strict: true });
      const ast = await parseAstAsync(code);
      expect(() => plugin.transform.call({ parse: () => ast }, code, '/app/held.ts'), code)
        .toThrow(/strict/);
    }
  });

  it('маркер @motion-runtime перед неанализируемым импортом снимает модульный refusal', async () => {
    const code = `/* @motion-runtime */ import * as m from '@labpics/motion/nano';\nexport const play = (el, v) => m.animate(el, { opacity: v });\n`;
    expect(await plan(code)).toBeUndefined();
  });

  it('buildStart сбрасывает счётчики квитанции (watch-ребилды не наследуют)', async () => {
    let report: { lowered: number; runtimeCalls: number; artifactChars: number } | undefined;
    const plugin = motionCompiler({ onBudget: (r) => { report = r; } });
    const lowerable = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }
`;
    const ast = await parseAstAsync(lowerable);
    plugin.buildStart();
    plugin.transform.call({ parse: () => ast }, lowerable, '/app/a.ts');
    plugin.buildEnd();
    expect(report!.lowered).toBe(1);
    plugin.buildStart(); // watch-ребилд без модулей
    plugin.buildEnd();
    expect(report).toEqual({ lowered: 0, runtimeCalls: 0, artifactChars: 0 });
  });

  it('artifactChars считает ТОЛЬКО литералы артефактов, без обёртки вызова', async () => {
    let report: { artifactChars: number } | undefined;
    const plugin = motionCompiler({ onBudget: (r) => { report = r; } });
    const lowerable = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }
`;
    const p = await plan(lowerable);
    const ast = await parseAstAsync(lowerable);
    plugin.buildStart();
    plugin.transform.call({ parse: () => ast }, lowerable, '/app/a.ts');
    plugin.buildEnd();
    expect(report!.artifactChars).toBe(p!.literalChars);
    // Литерал = ровно содержимое второй правки без ", " и ")".
    const second = p!.edits[1]!.replacement;
    expect(p!.literalChars).toBe(second.length - 3);
  });

  it('onBudget: квитанция lowered/runtimeCalls/artifactChars по buildEnd', async () => {
    let report: { lowered: number; runtimeCalls: number; artifactChars: number } | undefined;
    const plugin = motionCompiler({ onBudget: (r) => { report = r; } });
    const lowerable = `import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }
`;
    const astA = await parseAstAsync(lowerable);
    plugin.transform.call({ parse: () => astA }, lowerable, '/app/a.ts');
    const astB = await parseAstAsync(DYNAMIC);
    plugin.transform.call({ parse: () => astB }, DYNAMIC, '/app/b.ts');
    plugin.buildEnd();
    expect(report).toBeDefined();
    expect(report!.lowered).toBe(1);
    expect(report!.runtimeCalls).toBe(1);
    expect(report!.artifactChars).toBeGreaterThan(100); // linear()-строка внутри
  });
});
