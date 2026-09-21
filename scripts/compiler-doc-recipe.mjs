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
export function readCompilerNanoRecipe(root) {
  const docs = readFileSync(join(root, 'docs/compiler.md'), 'utf8');
  const parts = docs.split(COMPILER_NANO_RECIPE_MARKER);
  if (parts.length !== 2) {
    throw new Error(`Ожидается ровно один ${COMPILER_NANO_RECIPE_MARKER}`);
  }

  const opening = /^\s*(`{3,})typescript[ \t]*\r?\n/.exec(parts[1]);
  if (!opening) {
    throw new Error(`Нет исполнимого TypeScript после ${COMPILER_NANO_RECIPE_MARKER}`);
  }

  const body = parts[1].slice(opening[0].length);
  const fenceLength = opening[1].length;
  const closing = new RegExp('^`{' + fenceLength + ',}[ \\t]*\\r?$', 'm').exec(body);
  if (!closing) {
    throw new Error(`Не закрыт TypeScript-блок после ${COMPILER_NANO_RECIPE_MARKER}`);
  }

  return body.slice(0, closing.index).replace(/\r?\n$/, '');
}
