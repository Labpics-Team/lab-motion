/**
 * #221: build-time lowering статических NanoProps/NanoOptions (spring-форма).
 *
 * Слои соответствуют compiler-nano-lowering.test.ts:
 *   A. Артефакт через канонический V1-парсер (compileNanoArtifact).
 *   B. Позитивные паттерны планировщика — какие вызовы понижаются.
 *   C. Консервативные отказы — источник остаётся семантически исходным.
 *   D. Ошибки сборки на доказанно-статическом инвалиде.
 *   E. Executor ≡ nano.animate: журнал keyframes/options, stagger по индексу,
 *      явная и ambient reduced-политика.
 */
import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';

import {
  compileNanoArtifact,
  nanoCallArtifactLiteral,
  planNanoLowering,
  type AstNode,
  type StaticNanoCall,
} from '../src/compiler/core.js';
import { animateCompiledNano } from '../src/compiler/runtime/index.js';
import { animate as nanoAnimate, type NanoOptions, type NanoProps } from '../src/nano/index.js';

const IMPORT_LINE = "import { animate } from '@labpics/motion/nano';\n";

async function plan(code: string) {
  const ast = (await parseAstAsync(code)) as unknown as AstNode;
  return planNanoLowering(ast, code, nanoCallArtifactLiteral);
}

// ─── A. Артефакт ─────────────────────────────────────────────────────────────

describe('compileNanoArtifact — общий артефакт через V1-парсер', () => {
  it('канонизирует frame ровно по закону nano', () => {
    const artifact = compileNanoArtifact({
      props: { translate: '120px 0', opacity: 1, scale: 1.04, rotate: 8, filter: 'blur(0px)' },
    });
    // scale и rotate назначаются первыми, rotate получает deg, прочие — в
    // исходном порядке: побуквенно порядок присваивания nano/index.ts.
    expect(Object.keys(artifact.frame)).toEqual(['scale', 'rotate', 'translate', 'opacity', 'filter']);
    expect(artifact.frame['rotate']).toBe('8deg');
    expect(artifact.frame['scale']).toBe(1.04);
  });

  it('дефолтная пружина совпадает с nano SSOT', () => {
    const artifact = compileNanoArtifact({ props: { opacity: 0.5 } });
    const reference = compileNanoArtifact({
      props: { opacity: 0.5 },
      spring: { mass: 1, stiffness: 170, damping: 26 },
    });
    expect(artifact.durationMs).toBe(reference.durationMs);
    expect(artifact.cssLinear).toBe(reference.cssLinear);
  });

  it('delay уходит в startMs трека и возвращается из парсера', () => {
    const artifact = compileNanoArtifact({ props: { opacity: 1 }, delayMs: 40, staggerMs: 20 });
    expect(artifact.delayMs).toBe(40);
    expect(artifact.staggerMs).toBe(20);
  });
});

// ─── B. Позитивные паттерны ──────────────────────────────────────────────────

describe('позитивные паттерны — понижаются', () => {
  it('целевой пример issue целиком', async () => {
    const result = await plan(`${IMPORT_LINE}animate(el, {
      translate: '120px 0',
      scale: 1.04,
      rotate: 8,
      opacity: 1,
      filter: 'blur(0px)',
    }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      delay: 40,
      stagger: 20,
      reducedMotion: false,
    });`);
    expect(result).toBeDefined();
    expect(result!.edits).toHaveLength(2);
    expect(result!.runtimeCalls).toBe(0);
    const literal = result!.edits[1]!.replacement;
    expect(literal).toContain('"rotate":"8deg"');
    expect(literal).toContain('y:40');
    expect(literal).toContain('g:20');
    expect(literal).toContain('r:false');
  });

  it('двухаргументная мультиканальная форма (дефолтная пружина)', async () => {
    const result = await plan(`${IMPORT_LINE}animate(el, { opacity: 0.5, translate: '10px 0' });`);
    expect(result).toBeDefined();
    expect(result!.runtimeCalls).toBe(0);
  });

  it('пустые опции эквивалентны их отсутствию', async () => {
    const result = await plan(`${IMPORT_LINE}animate(el, { opacity: 0.5 }, {});`);
    expect(result).toBeDefined();
    expect(result!.runtimeCalls).toBe(0);
  });

  it('частичная пружина и отрицательные литералы', async () => {
    const result = await plan(`${IMPORT_LINE}animate(el, { x: -4 }, { spring: { stiffness: 200 }, delay: -5 });`);
    expect(result).toBeDefined();
    expect(result!.edits[1]!.replacement).toContain('"x":-4');
  });
});

// ─── C. Консервативные отказы ────────────────────────────────────────────────

describe('консервативный отказ — вызов остаётся runtime', () => {
  const REFUSALS: readonly [label: string, source: string][] = [
    ['tween-форма: duration', "animate(el, { opacity: 1 }, { duration: 200 });"],
    ['tween-форма: ease', "animate(el, { opacity: 1 }, { duration: 200, ease: 'ease-out' });"],
    ['неизвестная опция', "animate(el, { opacity: 1 }, { repeat: 2 });"],
    ['динамическое значение', 'animate(el, { opacity: level });'],
    ['вычисляемый ключ', "animate(el, { ['opa' + 'city']: 1 });"],
    ['shorthand', 'animate(el, { opacity });'],
    ['spread в props', 'animate(el, { ...rest });'],
    ['spread в options', 'animate(el, { opacity: 1 }, { ...rest });'],
    ['дубликат ключа', "animate(el, { opacity: 1, opacity: 0.5 });"],
    ['null-значение', 'animate(el, { opacity: null });'],
    ['строковый rotate', "animate(el, { rotate: '8deg' });"],
    ['строковый scale', "animate(el, { scale: 'big' });"],
    ['динамическая пружина', 'animate(el, { opacity: 1 }, { spring: springOf() });'],
    ['неизвестное поле пружины', 'animate(el, { opacity: 1 }, { spring: { mass: 1, velocity: 2 } });'],
    ['reducedMotion не литерал', 'animate(el, { opacity: 1 }, { reducedMotion: flag });'],
    ['опции переменной', 'animate(el, { opacity: 1 }, opts);'],
  ];

  for (const [label, source] of REFUSALS) {
    it(label, async () => {
      const result = await plan(`${IMPORT_LINE}${source}`);
      // Либо плана нет вовсе, либо вызов учтён как непонижаемый runtime-вызов.
      if (result !== undefined) {
        expect(result.edits).toHaveLength(0);
        expect(result.runtimeCalls).toBeGreaterThan(0);
      } else {
        expect(result).toBeUndefined();
      }
    });
  }
});

// ─── D. Ошибки сборки на доказанном инвалиде ─────────────────────────────────

describe('доказанно-статический инвалид — ошибка сборки, не silent fallback', () => {
  it('невалидная пружина падает причиной SSOT', () => {
    expect(() =>
      compileNanoArtifact({ props: { opacity: 1 }, spring: { mass: 0, stiffness: 1, damping: 1 } }),
    ).toThrow(/finite and positive/);
  });

  it('пустой frame непонижаем', () => {
    expect(() => compileNanoArtifact({ props: {} })).toThrow(/пустой frame/);
  });
});

// ─── E. Executor ≡ nano ──────────────────────────────────────────────────────

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

function journals(call: StaticNanoCall, props: NanoProps, options: NanoOptions | undefined, elements = 1) {
  const nanoJournal: JournalEntry[] = [];
  const compiledJournal: JournalEntry[] = [];
  const nanoTargets = Array.from({ length: elements }, () => fakeElement(nanoJournal));
  const compiledTargets = Array.from({ length: elements }, () => fakeElement(compiledJournal));
  if (options === undefined) nanoAnimate(nanoTargets, props);
  else nanoAnimate(nanoTargets, props, options);
  const artifact = compileNanoArtifact(call);
  animateCompiledNano(compiledTargets, {
    f: artifact.frame,
    d: artifact.durationMs,
    e: artifact.cssLinear,
    ...(artifact.delayMs !== 0 ? { y: artifact.delayMs } : {}),
    ...(artifact.staggerMs !== 0 ? { g: artifact.staggerMs } : {}),
    ...(artifact.reducedMotion !== undefined ? { r: artifact.reducedMotion } : {}),
  });
  return { nanoJournal, compiledJournal };
}

describe('animateCompiledNano ≡ nano.animate', () => {
  it('мультиканальный вызов с delay и stagger на трёх элементах', () => {
    const props = { translate: '120px 0', scale: 1.04, rotate: 8, opacity: 1 } as const;
    const options = { spring: { mass: 1, stiffness: 170, damping: 26 }, delay: 40, stagger: 20 } as const;
    const { nanoJournal, compiledJournal } = journals(
      { props, spring: options.spring, delayMs: 40, staggerMs: 20 },
      props,
      options,
      3,
    );
    expect(compiledJournal).toEqual(nanoJournal);
    // Индексный stagger: delay растёт по элементам ровно как у nano.
    expect(compiledJournal.map((entry) => entry.options['delay'])).toEqual([40, 60, 80]);
  });

  it('явный reducedMotion: false игнорирует ambient-медиа', () => {
    const original = globalThis.matchMedia;
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
    try {
      const { nanoJournal, compiledJournal } = journals(
        { props: { opacity: 1 }, reducedMotion: false },
        { opacity: 1 },
        { reducedMotion: false },
      );
      expect(compiledJournal).toEqual(nanoJournal);
      expect(compiledJournal[0]!.options['duration']).not.toBe(0);
    } finally {
      (globalThis as { matchMedia?: unknown }).matchMedia = original;
    }
  });

  it('явный reducedMotion: true даёт duration 0 и linear', () => {
    const { nanoJournal, compiledJournal } = journals(
      { props: { opacity: 1 }, reducedMotion: true },
      { opacity: 1 },
      { reducedMotion: true },
    );
    expect(compiledJournal).toEqual(nanoJournal);
    expect(compiledJournal[0]!.options).toMatchObject({ duration: 0, easing: 'linear', delay: 0 });
  });

  it('один frame-объект на вызов, а не на элемент', () => {
    const journal: JournalEntry[] = [];
    const targets = [fakeElement(journal), fakeElement(journal)];
    const artifact = compileNanoArtifact({ props: { opacity: 0.5 } });
    animateCompiledNano(targets, { f: artifact.frame, d: artifact.durationMs, e: artifact.cssLinear });
    expect(journal[0]!.frame).toBe(journal[1]!.frame);
  });
});
