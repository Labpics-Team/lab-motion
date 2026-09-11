import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  planNanoOpacityLowering,
  type AstNode,
  type NanoLoweringEdit,
} from '../src/compiler/core.js';
import { nanoDefaultArtifactLiteral } from '../src/compiler/nano-default-artifact.js';
import { motionCompiler } from '../src/compiler/vite/index.js';

const NANO = '@labpics/motion/nano';
const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value: number): string {
  let signed = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = signed & 31;
    signed >>>= 5;
    if (signed > 0) digit |= 32;
    out += VLQ[digit]!;
  } while (signed > 0);
  return out;
}

/**
 * Независимый characterization-oracle прежнего посимвольного map-builder.
 * Намеренно не разделяет алгоритм production-кандидата: здесь каждый UTF-16
 * code unit действительно проходит через charCodeAt, поэтому переход на
 * boundary/LF representation доказывается дифференциально, а не сам собой.
 */
function characterMap(code: string, edits: readonly NanoLoweringEdit[], id: string) {
  const groups: string[][] = [[]];
  let genColumn = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let previousGenColumn = 0;
  let previousLine = 0;
  let previousColumn = 0;
  const segment = (): void => {
    groups.at(-1)!.push(
      vlq(genColumn - previousGenColumn)
      + vlq(0)
      + vlq(originalLine - previousLine)
      + vlq(originalColumn - previousColumn),
    );
    previousGenColumn = genColumn;
    previousLine = originalLine;
    previousColumn = originalColumn;
  };
  const keep = (from: number, to: number): void => {
    if (from < to) segment();
    for (let cursor = from; cursor < to; cursor++) {
      if (code.charCodeAt(cursor) === 10) {
        groups.push([]);
        genColumn = 0;
        previousGenColumn = 0;
        originalLine++;
        originalColumn = 0;
        if (cursor + 1 < to) segment();
      } else {
        genColumn++;
        originalColumn++;
      }
    }
  };
  const replace = (edit: NanoLoweringEdit): void => {
    segment();
    genColumn += edit.replacement.length;
    for (let cursor = edit.start; cursor < edit.end; cursor++) {
      if (code.charCodeAt(cursor) === 10) {
        originalLine++;
        originalColumn = 0;
      } else {
        originalColumn++;
      }
    }
  };
  let cursor = 0;
  for (const edit of edits) {
    keep(cursor, edit.start);
    replace(edit);
    cursor = edit.end;
  }
  keep(cursor, code.length);
  groups.push([], []);
  return {
    version: 3 as const,
    mappings: groups.map((group) => group.join(',')).join(';'),
    sources: [id],
    sourcesContent: [code],
    names: [] as string[],
  };
}

async function lowered(code: string, id: string) {
  const ast = await parseAstAsync(code) as unknown as AstNode;
  const plan = planNanoOpacityLowering(ast, code, nanoDefaultArtifactLiteral);
  expect(plan).toBeDefined();
  const result = motionCompiler().transform.call({
    parse: () => ast,
    warn: (message: string) => { throw new Error(message); },
  }, code, id);
  expect(result).toBeDefined();
  return { plan: plan!, result: result! };
}

describe('compiler sourcemap — boundary/LF representation', () => {
  it('побайтно совпадает с независимым посимвольным oracle на boundary-корпусе', async () => {
    for (let index = 0; index < 48; index++) {
      const nl = index % 2 === 0 ? '\n' : '\r\n';
      const padding = `${'x'.repeat((index * 97) % 701)}${index % 3 === 0 ? '💠' : ''}`;
      const call = index % 4 === 0
        ? `animate(${nl}  card,${nl}  { opacity: ${index % 2 === 0 ? 1 : 0.5} },${nl});`
        : `animate(card, { opacity: ${index % 2 === 0 ? 1 : 0.5} });`;
      const code = [
        `import { animate } from '${NANO}';`,
        `/*${padding}*/`,
        'const card = {};',
        call,
        index % 5 === 0 ? '/* tail\nline */' : '/* tail */',
        '',
      ].join(nl);
      const id = `/app/case-${index}.js`;
      const { plan, result } = await lowered(code, id);
      const expected = characterMap(code, plan.edits, id);
      expect(result.map).toEqual(expected);

      // Положительный контроль: даже одна лишняя mapping-колонка обязана быть видна.
      expect({ ...expected, mappings: expected.mappings + 'A' }).not.toEqual(result.map);
    }
  });

  it('сохраняет exact map на длинной строке без LF, где production не должен идти по code unit', async () => {
    const code = `import { animate } from '${NANO}';\n/*${'q'.repeat(32_768)}*/ animate(card, { opacity: 1 });\n`;
    const id = '/app/long-line.js';
    const { plan, result } = await lowered(code, id);
    expect(result.map).toEqual(characterMap(code, plan.edits, id));
  });
});
