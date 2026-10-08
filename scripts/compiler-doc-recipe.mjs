import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMPILER_NANO_RECIPE_MARKER = '<!-- compiler-nano-recipe -->';

/**
 * Возвращает буквальный compiler-рецепт из документации.
 * Документация — единственный владелец входа; acceptance и browser proof
 * обязаны собирать именно эти байты, а не поддерживать свои копии fixture.
 *
 * Fence допускает длину >= 3: если рецепт когда-нибудь содержит строку ```
 * внутри template literal, документация может использовать ```` без ложного
 * преждевременного закрытия блока.
 */
export const readCompilerNanoRecipe = root => readRecipe(root, COMPILER_NANO_RECIPE_MARKER);
export const readCompilerProjectRecipe = root => readRecipe(root, '<!-- compiler-project-recipe -->');

function readRecipe(root, marker) {
  const docs = readFileSync(join(root, 'docs/compiler.md'), 'utf8');
  const parts = docs.split(marker);
  if (parts.length !== 2) {
    throw new Error(`Ожидается ровно один ${marker}`);
  }

  const opening = /^\s*(`{3,})typescript[ \t]*\r?\n/.exec(parts[1]);
  if (!opening) {
    throw new Error(`Нет исполнимого TypeScript после ${marker}`);
  }

  const body = parts[1].slice(opening[0].length);
  const fenceLength = opening[1].length;
  const closing = new RegExp('^`{' + fenceLength + ',}[ \\t]*\\r?$', 'm').exec(body);
  if (!closing) {
    throw new Error(`Не закрыт TypeScript-блок после ${marker}`);
  }

  return body.slice(0, closing.index).replace(/\r?\n$/, '');
}
