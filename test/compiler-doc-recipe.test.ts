import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILER_NANO_RECIPE_MARKER, readCompilerNanoRecipe } from '../scripts/compiler-doc-recipe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function independentlyExtractRecipe(markdown: string): string {
  const first = markdown.indexOf(COMPILER_NANO_RECIPE_MARKER);
  if (first < 0 || markdown.indexOf(COMPILER_NANO_RECIPE_MARKER, first + COMPILER_NANO_RECIPE_MARKER.length) >= 0) {
    throw new Error('independent oracle: marker count');
  }

  const lines = markdown.slice(first + COMPILER_NANO_RECIPE_MARKER.length).split('\n');
  let openIndex = 0;
  while (openIndex < lines.length && lines[openIndex]!.trim() === '') openIndex += 1;
  const opening = /^(`{3,})typescript[ \t]*\r?$/.exec(lines[openIndex] ?? '');
  if (!opening) throw new Error('independent oracle: opening fence');

  const fenceLength = opening[1]!.length;
  let closeIndex = openIndex + 1;
  for (; closeIndex < lines.length; closeIndex += 1) {
    const candidate = /^(`+)[ \t]*\r?$/.exec(lines[closeIndex]!);
    if (candidate && candidate[1]!.length >= fenceLength) break;
  }
  if (closeIndex === lines.length) throw new Error('independent oracle: closing fence');
  return lines.slice(openIndex + 1, closeIndex).join('\n').replace(/\r$/, '');
}

function withFixtureDocs(markdown: string, check: (fixtureRoot: string) => void): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'lab-motion-compiler-doc-'));
  try {
    mkdirSync(join(fixtureRoot, 'docs'));
    writeFileSync(join(fixtureRoot, 'docs/compiler.md'), markdown);
    check(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function assertDirectRecipeOwner(source: string, binding: string): void {
  const assignment = new RegExp(`^const ${binding} = readCompilerNanoRecipe\\(ROOT\\);$`, 'm');
  if (!assignment.test(source)) {
    throw new Error(`${binding} больше не получает docs-рецепт напрямую`);
  }
}

describe('compiler docs recipe owner', () => {
  it('совпадает с независимым line-oriented oracle байт-в-байт', () => {
    const docs = readFileSync(join(root, 'docs/compiler.md'), 'utf8');
    expect(readCompilerNanoRecipe(root)).toBe(independentlyExtractRecipe(docs));
  });

  it('fail-closed отвергает отсутствие marker и исполнимого/закрытого блока', () => {
    withFixtureDocs('# no recipe\n', (fixtureRoot) => {
      expect(() => readCompilerNanoRecipe(fixtureRoot)).toThrow('Ожидается ровно один');
    });
    withFixtureDocs(`${COMPILER_NANO_RECIPE_MARKER}\nобычный текст\n`, (fixtureRoot) => {
      expect(() => readCompilerNanoRecipe(fixtureRoot)).toThrow('Нет исполнимого TypeScript');
    });
    withFixtureDocs(`${COMPILER_NANO_RECIPE_MARKER}\n\`\`\`typescript\nexport const x = 1;\n`, (fixtureRoot) => {
      expect(() => readCompilerNanoRecipe(fixtureRoot)).toThrow('Не закрыт TypeScript-блок');
    });
  });

  it('длинный fence позволяет template literal со строкой из трёх backticks', () => {
    const recipe = ['const value = `', '```', '`;', 'export { value };'].join('\n');
    const markdown = [COMPILER_NANO_RECIPE_MARKER, '````typescript', recipe, '````', ''].join('\n');
    withFixtureDocs(markdown, (fixtureRoot) => {
      expect(readCompilerNanoRecipe(fixtureRoot)).toBe(recipe);
    });
  });

  it('оба proof-consumer привязывают build input прямо к docs owner и ловят прежний ложноположительный mutant', () => {
    const consumers = [
      { path: 'scripts/compiler-acceptance.mjs', binding: 'LOWERABLE' },
      { path: 'browser/fixtures/compile-artifacts.mjs', binding: 'NANO_FIXTURE' },
    ];

    for (const { path, binding } of consumers) {
      const source = readFileSync(join(root, path), 'utf8');
      assertDirectRecipeOwner(source, binding);

      const exact = `const ${binding} = readCompilerNanoRecipe(ROOT);`;
      const mutant = source.replace(
        exact,
        `readCompilerNanoRecipe(ROOT);\nconst ${binding} = ['duplicated', 'fixture'].join('\\n');`,
      );
      expect(mutant).not.toBe(source);
      expect(() => assertDirectRecipeOwner(mutant, binding)).toThrow('больше не получает docs-рецепт напрямую');
    }
  });
});
