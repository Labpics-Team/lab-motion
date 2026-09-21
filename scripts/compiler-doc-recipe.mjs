import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMPILER_NANO_RECIPE_MARKER = '<!-- compiler-nano-recipe -->';

/**
 * Возвращает буквальный compiler-рецепт из документации.
 * Документация — единственный владелец входа; acceptance и browser proof
 * обязаны собирать именно эти байты, а не поддерживать свои копии fixture.
 */
export function readCompilerNanoRecipe(root) {
  const docs = readFileSync(join(root, 'docs/compiler.md'), 'utf8');
  const parts = docs.split(COMPILER_NANO_RECIPE_MARKER);
  if (parts.length !== 2) {
    throw new Error(`Ожидается ровно один ${COMPILER_NANO_RECIPE_MARKER}`);
  }
  const match = parts[1].match(/^\s*```typescript\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`Нет исполнимого TypeScript после ${COMPILER_NANO_RECIPE_MARKER}`);
  }
  return match[1];
}
