import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Эталон получен из неизменяемой базы 80264dc5, а не из кандидата:
// прогон 34570770910 / артефакт 10187698120, characterization.json.
// Полные code/map защищены SHA256 без копий большого CSS-артефакта в тесте;
// mappings сохранён явно, чтобы ошибка сегментов давала читаемое различие.
const GOLDENS = {
  'animate-surface-0': {
    code: 'bfd6ea216b8baaba9dcc84a2ba946b9e959c264c1fdbcab18883176f380b7bcc',
    mappings: 'AAAA;AACA;AACA,wBAAQ,IAAI,mwBAAiB;AAC7B;;;',
    map: '375526f2bb47ca76cb821950166e24515e75ffb380b79cac47e2644437609290',
  },
  'animate-surface-1': {
    code: 'e565adbcf4df90a57e46f11971d3530579cfb7c37ab60420942127b17f6437b9',
    mappings: 'AAAA;AACA;AACA,wBAAQ,IAAI,mwBAAiB;AAC7B;;;',
    map: 'c887245d88ed62b666ca4348c9ac6cb7054446530bdffe4a230a2d4d143aee79',
  },
  'nano-animate-0': {
    code: '82052a25f810c6b50de4435adb85d0d439627673461eb5bb2e2854ca932b2e48',
    mappings: 'AAAA;AACA;AACA;AACA,mBAAQ,KAAK,ijIAA+C;;;',
    map: '5bf2b56c118076441536609f2632cf9ca052c60b43bcd31d9deaafcbfb55ac62',
  },
  'nano-animate-1': {
    code: '2d8d8778a5f0ce37a91894a3c804ac668a183600e071e18cfb0115df0dd54672',
    mappings: 'AAAA;AACA;AACA;AACA,mBAAQ,KAAK,ijIAA+C;;;',
    map: '6f07f102a1abed501f6e73c55846567cb00a3eba99b8449f182b00dbd6566ad5',
  },
  nested: {
    code: '799ada9a37ce604cbc3cadcd2c73bfe44f2df19e49b280b6905611a78714516f',
    mappings: 'AAAA;AACA,wBAAQ,wBAAQ,IAAI,qwBAAmB,mwBAAiB;;;',
    map: '374f369b966ba23aaabbda1e2d9c63d76c73618bfd0d9fe769f5370d8c4c908f',
  },
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
      for (const [index, ordered] of [imports, [...imports].reverse()].entries()) {
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
          assertExact(result!, GOLDENS[`${nano}-${surface}-${index}` as keyof typeof GOLDENS]);
        }
      }
    }
  });

  it('успешный Nano не оплачивает третий полный обход AST', async () => {
    const code = `import { animate } from '${NANO}';\nanimate(animate(card, { opacity: 0.5 }), { opacity: 1 });\n`;
    const parsed = await parseAstAsync(code) as unknown as AstNode;
    const body = parsed.body;
    let traversals = 0;
    // Чтение корневого body наблюдает полный проход, а не время выполнения или работу JIT.
    const ast: AstNode = { ...parsed, get body() { traversals++; return body; } };
    const result = transform(ast, code);
    expect(result).toBeDefined();
    expect(result!.code.match(/__labMotionNanoCompiled\(/g)).toHaveLength(2);
    assertExact(result!, GOLDENS.nested);
    expect(traversals).toBeGreaterThan(0);
    expect(traversals).toBeLessThanOrEqual(2);

    // Положительный контроль должен проходить через реально применимый planner.
    // После #343 чужой planner корректно отсеивается по import ownership до обхода AST,
    // поэтому повторный Nano-план доказывает чувствительность того же счётчика к лишнему проходу.
    const before = traversals;
    expect(planNanoOpacityLowering(ast, code, nanoDefaultArtifactLiteral)).toBeDefined();
    expect(traversals).toBeGreaterThan(before);

    // Оба мутанта сохраняют число строк/вызовов, но точный оракул обязан их ловить.
    expect(() => assertExact({ ...result!, code: result!.code.replace('card', 'panel') }, GOLDENS.nested)).toThrow();
    expect(() => assertExact({
      ...result!,
      map: { ...result!.map, mappings: result!.map.mappings.replace('wBAAQ', 'yBAAQ') },
    }, GOLDENS.nested)).toThrow();
  });
});
