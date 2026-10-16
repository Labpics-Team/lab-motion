import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';
import {
  planNativeOpacityLowering,
  planSurfaceLowering,
  type AstNode,
} from '../src/compiler/core.js';
import { nativeDefaultArtifactLiteral } from '../src/compiler/native-default-artifact.js';
import { motionCompiler } from '../src/compiler/vite/index.js';

const NATIVE = '@labpics/motion/native';
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

// Хеш и sourcemap закрепляют вложенную специализацию. Остальные ветви
// проверяются по инвариантам владения import-binding.
const NESTED_GOLDEN = {
  code: '1de8b3cd0dd3aaa8e1ace59c760a048fdf7f81c950afe827bafdfec5316d6a3b',
  mappings: 'AAAA;AACA,0BAAQ,0BAAQ,IAAI,qwBAAmB,mwBAAiB;;;',
  map: 'e441e1606556c8611711aaedfc1b92bf6d7b1ba7c14d6194092f9e8e4ccd35a9',
};
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
function assertExact(
  result: NonNullable<ReturnType<typeof transform>>,
  expected: { code: string; mappings: string; map: string },
): void {
  expect(sha256(result.code)).toBe(expected.code);
  expect(result.map.mappings).toBe(expected.mappings);
  expect(sha256(JSON.stringify(result.map))).toBe(expected.map);
}

describe('единственный применимый план lowering', () => {
  it('два прямых импорта с локальным именем animate отвергаются независимым ESM-парсером', () => {
    const code = `import { animate } from '${NATIVE}';\nimport { animate } from '${SURFACE}';\n`;
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
    for (const [native, surface] of [['animate', 'surface'], ['native', 'animate'], ['native', 'surface']]) {
      const imports = [
        `import { animate as ${native} } from '${NATIVE}';`,
        `import { animate as ${surface} } from '${SURFACE}';`,
      ];
      for (const ordered of [imports, [...imports].reverse()]) {
        const code = ordered.join('\n') + '\n' + BODY;
        const ast = await parseAstAsync(code) as unknown as AstNode;
        const plans = [
          planNativeOpacityLowering(ast, code, nativeDefaultArtifactLiteral),
          planSurfaceLowering(ast, code),
        ].filter((plan) => plan !== undefined);
        expect(plans.length).toBe(native === 'animate' || surface === 'animate' ? 1 : 0);
        const result = transform(ast, code);
        if (plans.length === 0) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toBeDefined();
          const plan = plans[0]!;
          expect(result!.code).toContain(`from ${JSON.stringify(plan.importSource)};`);
          const otherSource = plan.importSource.endsWith('/runtime')
            ? '@labpics/motion/compiler/surface'
            : '@labpics/motion/compiler/runtime';
          expect(result!.code).not.toContain(`from ${JSON.stringify(otherSource)};`);
          expect(result!.map.mappings.split(';').length).toBe(result!.code.split('\n').length);
          expect(result!.map.mappings.split(';').slice(-2)).toEqual(['', '']);
        }
      }
    }
  });

  it('успешный Native не оплачивает проверку владения второго planner', async () => {
    const code = `import { animate } from '${NATIVE}';\nanimate(animate(card, { opacity: 0.5 }), { opacity: 1 });\n`;
    const parsed = await parseAstAsync(code) as unknown as AstNode;
    const body = parsed.body;
    let bodyReads = 0;
    // После #343 собственный planner читает Program.body трижды: быстрый import scan,
    // проверка затенения и lowering walk. Вызов чужого Surface planner добавил бы
    // ещё один import-ownership scan даже без полного обхода вложенного AST.
    const ast: AstNode = { ...parsed, get body() { bodyReads++; return body; } };
    const result = transform(ast, code);
    expect(result).toBeDefined();
    expect(result!.code.match(/__labMotionNativeCompiled\(/g)).toHaveLength(2);
    assertExact(result!, NESTED_GOLDEN);
    expect(bodyReads).toBe(3);

    // Положительный контроль: лишняя проверка второго planner наблюдаема тем же probe.
    const before = bodyReads;
    expect(planSurfaceLowering(ast, code)).toBeUndefined();
    expect(bodyReads).toBe(before + 1);

    // Оба мутанта сохраняют число строк/вызовов, но точный оракул обязан их ловить.
    expect(() => assertExact({ ...result!, code: result!.code.replace('card', 'panel') }, NESTED_GOLDEN)).toThrow();
    expect(() => assertExact({
      ...result!,
      map: { ...result!.map, mappings: result!.map.mappings.replace('0BAAQ', 'yBAAQ') },
    }, NESTED_GOLDEN)).toThrow();
  });
});
