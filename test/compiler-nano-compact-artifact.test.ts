import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';

import { nanoArtifactLiteral } from '../src/compiler/core.js';
import {
  nanoCompactArtifactLiteral,
  nanoDefaultArtifactLiteral,
} from '../src/compiler/nano-default-artifact.js';
import { motionCompiler } from '../src/compiler/vite/index.js';

function decodeArtifact(literal: string): { o: number; d: number; e: string } {
  return JSON.parse(literal.replace(/([{,])([a-z]+):/g, '$1"$2":')) as {
    o: number;
    d: number;
    e: string;
  };
}

function linearTokens(css: string): string[] {
  expect(css.startsWith('linear(')).toBe(true);
  expect(css.endsWith(')')).toBe(true);
  return css.slice(7, -1).split(',');
}

describe('краткий frozen Nano-артефакт compiler', () => {
  it('сохраняет канонический V1 численно, удаляя только 106 ведущих нулей', () => {
    for (const opacity of [-0, 0, Number.MIN_VALUE, 0.125, 0.5, 1, 123.456, 1e300]) {
      const canonical = decodeArtifact(nanoDefaultArtifactLiteral(opacity));
      const compact = decodeArtifact(nanoCompactArtifactLiteral(opacity));
      const oracle = decodeArtifact(nanoArtifactLiteral(opacity));

      expect(canonical).toEqual(oracle);
      expect(Object.is(compact.o, canonical.o)).toBe(true);
      expect(Object.is(compact.d, canonical.d)).toBe(true);

      const canonicalTokens = linearTokens(canonical.e);
      const compactTokens = linearTokens(compact.e);
      expect(compactTokens).toHaveLength(canonicalTokens.length);
      for (let index = 0; index < canonicalTokens.length; index++) {
        expect(Object.is(Number(compactTokens[index]), Number(canonicalTokens[index]))).toBe(true);
        if (/^0\./.test(canonicalTokens[index]!)) {
          expect(compactTokens[index]).toMatch(/^\.\d+$/);
        } else {
          expect(compactTokens[index]).toBe(canonicalTokens[index]);
        }
      }
      expect(canonical.e.length - compact.e.length).toBe(106);
      expect(nanoDefaultArtifactLiteral(opacity)).toBe(nanoArtifactLiteral(opacity));
    }
  });

  it('положительный контроль ловит изменение числового stop', () => {
    const canonical = decodeArtifact(nanoDefaultArtifactLiteral(1));
    const sabotaged = decodeArtifact(nanoCompactArtifactLiteral(1).replace('.0037', '.0038'));
    expect(linearTokens(sabotaged.e).map(Number)).not.toEqual(linearTokens(canonical.e).map(Number));
  });

  it('Vite lowering фактически эмитит краткую форму, а не oracle-строку', async () => {
    const code = `import { animate } from '@labpics/motion/nano';\nanimate(el, { opacity: 1 });\n`;
    const ast = await parseAstAsync(code);
    const result = motionCompiler().transform.call(
      { parse: () => ast, warn: (message: string) => { throw new Error(message); } },
      code,
      '/app/module.js',
    );
    expect(result).toBeDefined();
    expect(result!.code).toContain('linear(0,.0037,.014,.0298');
    expect(result!.code).not.toContain('linear(0,0.0037,0.014,0.0298');
  });
});
