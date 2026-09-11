import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  planNanoOpacityLowering,
  planSurfaceLowering,
  type AstNode,
} from '../src/compiler/core.js';
import { nanoDefaultArtifactLiteral } from '../src/compiler/nano-default-artifact.js';
import { motionCompiler } from '../src/compiler/vite/index.js';

const NANO = '@labpics/motion/nano';
const SURFACE = '@labpics/motion/animate';
const BODY = `animate(card, { opacity: 1 });
animate(panel, { width: [100, 200] }, { layout: 'project' });
`;

function transform(ast: AstNode, code: string) {
  return motionCompiler().transform.call({
    parse: () => ast,
    warn: (message: string) => { throw new Error(message); },
  }, code, '/app/module.js');
}

describe('единственный применимый lowering-план', () => {
  it('оба direct imports с local animate отвергаются независимым ESM-парсером', () => {
    const code = `import { animate } from '${NANO}';\nimport { animate } from '${SURFACE}';\n`;
    const invalid = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: code,
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(invalid.error).toBeUndefined();
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('SyntaxError');
    const valid = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: code.replace(`{ animate } from '${SURFACE}'`, `{ animate as surface } from '${SURFACE}'`),
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(valid.error).toBeUndefined();
    expect(valid.status).toBe(0);
  });

  it('смешанные импорты и их порядок сохраняют ровно своего владельца', async () => {
    for (const [nano, surface] of [['animate', 'surface'], ['nano', 'animate'], ['nano', 'surface']]) {
      const imports = [
        `import { animate as ${nano} } from '${NANO}';`,
        `import { animate as ${surface} } from '${SURFACE}';`,
      ];
      for (const ordered of [imports, [...imports].reverse()]) {
        const code = ordered.join('\n') + '\n' + BODY;
        const ast = await parseAstAsync(code) as unknown as AstNode;
        const plans = [
          planNanoOpacityLowering(ast, code, nanoDefaultArtifactLiteral),
          planSurfaceLowering(ast, code),
        ].filter((plan) => plan !== undefined);
        expect(plans.length).toBe(nano === 'animate' || surface === 'animate' ? 1 : 0);
        const result = transform(ast, code);
        if (plans.length === 0) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toBeDefined();
          const expectedSource = nano === 'animate' ? '/compiler/runtime' : '/compiler/surface';
          expect(result!.code).toContain(`from "@labpics/motion${expectedSource}";`);
          expect(result!.map.mappings.split(';').length).toBe(result!.code.split('\n').length);
          expect(result!.map.mappings.split(';').slice(-2)).toEqual(['', '']);
        }
      }
    }
  });

  it('успешный Nano не оплачивает третий полный обход AST', async () => {
    const code = `import { animate } from '${NANO}';\nanimate(animate(card, { opacity: 0.5 }), { opacity: 1 });\n`;
    const parsed = await parseAstAsync(code) as unknown as AstNode;
    const body = parsed.body;
    let traversals = 0;
    // Чтение корневого body наблюдает полный проход, не wall-clock/JIT.
    const ast: AstNode = { ...parsed, get body() { traversals++; return body; } };
    const result = transform(ast, code);
    expect(result).toBeDefined();
    expect(result!.code.match(/__labMotionNanoCompiled\(/g)).toHaveLength(2);
    expect(traversals).toBeGreaterThan(0);
    expect(traversals).toBeLessThanOrEqual(2);

    // Положительный контроль: действительно лишний planner виден тому же счётчику.
    const before = traversals;
    expect(planSurfaceLowering(ast, code)).toBeUndefined();
    expect(traversals).toBe(before + 1);
  });
});
