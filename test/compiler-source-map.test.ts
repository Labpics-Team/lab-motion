import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  planNanoOpacityLowering,
  planSurfaceLowering,
  type AstNode,
  type NanoLoweringPlan,
} from '../src/compiler/core.js';
import { nanoDefaultArtifactLiteral } from '../src/compiler/nano-default-artifact.js';
import { motionCompiler } from '../src/compiler/vite/index.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Оракул берёт абсолютные позиции из префиксов готового текста. Он намеренно
// не повторяет потоковые курсоры и побитовый VLQ-энкодер production.
function position(text: string, offset: number): readonly [number, number] {
  const lines = text.slice(0, offset).split('\n');
  return [lines.length - 1, lines[lines.length - 1]!.length];
}

function encode(value: number): string {
  let remaining = Math.abs(value) * 2 + Number(value < 0);
  let result = '';
  do {
    const digit = remaining % 32;
    remaining = Math.floor(remaining / 32);
    result += BASE64[digit + (remaining > 0 ? 32 : 0)];
  } while (remaining > 0);
  return result;
}

function reference(code: string, plan: NanoLoweringPlan, id: string) {
  let output = '';
  const marks: [number, number][] = [];
  const keep = (from: number, to: number): void => {
    if (from === to) return;
    marks.push([output.length, from]);
    for (let index = from; index < to - 1; index++) {
      if (code[index] === '\n') marks.push([output.length + index + 1 - from, index + 1]);
    }
    output += code.slice(from, to);
  };
  let cursor = 0;
  for (const edit of plan.edits) {
    keep(cursor, edit.start);
    marks.push([output.length, edit.start]);
    output += edit.replacement;
    cursor = edit.end;
  }
  keep(cursor, code.length);
  output += `\nimport { ${plan.importName} as ${plan.importLocal} } from ${JSON.stringify(plan.importSource)};\n`;
  const groups: string[][] = output.split('\n').map(() => []);
  let priorGeneratedLine = -1;
  let priorGeneratedColumn = 0;
  let priorSourceLine = 0;
  let priorSourceColumn = 0;
  for (const [generatedOffset, sourceOffset] of marks) {
    const [generatedLine, generatedColumn] = position(output, generatedOffset);
    const [sourceLine, sourceColumn] = position(code, sourceOffset);
    if (generatedLine !== priorGeneratedLine) priorGeneratedColumn = 0;
    groups[generatedLine]!.push(encode(generatedColumn - priorGeneratedColumn) + encode(0)
      + encode(sourceLine - priorSourceLine) + encode(sourceColumn - priorSourceColumn));
    priorGeneratedLine = generatedLine;
    priorGeneratedColumn = generatedColumn;
    priorSourceLine = sourceLine;
    priorSourceColumn = sourceColumn;
  }
  return {
    code: output,
    map: {
      version: 3,
      mappings: groups.map((group) => group.join(',')).join(';'),
      sources: [id],
      sourcesContent: [code],
      names: [],
    },
  };
}

async function observed(code: string) {
  const id = '/src/карта-😀.js';
  const ast = await parseAstAsync(code) as unknown as AstNode;
  const plan = planNanoOpacityLowering(ast, code, nanoDefaultArtifactLiteral)
    ?? planSurfaceLowering(ast, code);
  const warnings: string[] = [];
  const actual = motionCompiler().transform.call({
    parse: () => ast,
    warn: (message: string) => { warnings.push(message); },
  }, code, id);
  return { actual, expected: plan === undefined ? undefined : reference(code, plan, id), warnings, plan };
}

const nanoImport = `import { animate } from '@labpics/motion/nano';`;
const surfaceImport = `import { animate } from '@labpics/motion/animate';`;

describe('карта правок совпадает с независимыми абсолютными координатами', () => {
  it('сохраняет строки, UTF-16-колонки и вложенные диапазоны', async () => {
    let seed = 0x721942;
    const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const gaps = ['', ' ', '\t', '\n', '\r\n', '\n\n', '\n \n'];
    const nextGap = (): string => gaps[Math.floor(random() * gaps.length)]!;
    for (let index = 0; index < 128; index++) {
      const gap = nextGap;
      const call = (target: string): string => `animate${gap()}(${gap()}${target}${gap()},${gap()}{ opacity: 0.5 }${gap()})`;
      const target = index % 2 === 0 ? call('el') : 'el';
      const code = `/* 😀 е\u0301 */${gap()}${nanoImport}${gap()}\n`
        + `const text = '😀';${gap()}${call(target)};${gap()}${call('other')};${gap()}`;
      const { actual, expected, warnings, plan } = await observed(code);
      expect(plan, `case ${index}`).toBeDefined();
      expect(plan!.edits.length).toBe(index % 2 === 0 ? 6 : 4);
      expect(actual, `case ${index}`).toEqual(expected);
      expect(warnings).toEqual([]);
    }
  });

  it('сохраняет карту Surface и явно непонижаемый соседний вызов', async () => {
    for (const newline of ['\n', '\r\n', '\n\n', '\n \n']) {
      const code = `${surfaceImport}${newline}`
        + `animate(${newline}el,${newline}{ width: [100, 200] },${newline}{ layout: 'project' }${newline});${newline}`
        + `animate(other, { opacity: level });${newline}`;
      const { actual, expected, warnings, plan } = await observed(code);
      expect(plan).toBeDefined();
      expect(plan!.edits).toHaveLength(2);
      expect(plan!.runtimeCalls).toBe(1);
      expect(actual).toEqual(expected);
      expect(actual!.code).toContain('animate(other, { opacity: level })');
      expect(warnings).toEqual([]);
    }
  });

  it('различает начало/конец строки и отсутствие завершающего LF', async () => {
    for (const prefix of ['', '\n', '\n\n', '/* 😀 */']) {
      for (const tail of ['', '\n', '\r\n', '\n\n', '; const last = 1;']) {
        const code = `${prefix}${nanoImport}\nanimate(\nel\n,\n{ opacity: 1 }\n);${tail}`;
        const { actual, expected, plan } = await observed(code);
        expect(plan).toBeDefined();
        expect(actual).toEqual(expected);
        expect(actual!.map.mappings.endsWith(';;')).toBe(true);
      }
    }
  });

  it('отказ не превращается в пустую карту или переписанный source', async () => {
    for (const code of [
      `${nanoImport} animate(el, { opacity: level });`,
      `${nanoImport} { const animate = fake; animate(el, { opacity: 1 }); }`,
      `import { animate as go } from '@labpics/motion/nano'; go(el, { opacity: 1 });`,
    ]) {
      const { actual, expected, warnings } = await observed(code);
      expect(actual).toBeUndefined();
      expect(expected).toBeUndefined();
      expect(warnings).toEqual([]);
    }
  });

  it('positive controls ловят внутренний сегмент, текст и потерю unmapped-хвоста', async () => {
    const { actual, expected } = await observed(`${nanoImport}\nanimate(\nel,\n{ opacity: 1 }\n);\n`);
    expect(actual).toEqual(expected);
    const mappings = actual!.map.mappings;
    const comma = mappings.indexOf(',');
    expect(comma).toBeGreaterThanOrEqual(0);
    const at = comma + 1;
    const replacement = mappings[at] === 'A' ? 'C' : 'A';
    const damaged = { ...actual, map: { ...actual!.map,
      mappings: mappings.slice(0, at) + replacement + mappings.slice(at + 1),
    } };
    expect(damaged).not.toEqual(expected);
    expect(actual!.code).toContain('Compiled(el');
    expect({ ...actual, code: actual!.code.replace('Compiled(el', 'Compiled(other') }).not.toEqual(expected);
    expect({ ...actual, map: { ...actual!.map, mappings: mappings.slice(0, -1) } }).not.toEqual(expected);
  });
});
