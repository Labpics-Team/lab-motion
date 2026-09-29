import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

/** Один исходник прикладного примера: документация является исполняемым consumer. */
export function reorderRecipe(root) {
  const text = readFileSync(resolve(root, 'docs/recipes.md'), 'utf8');
  const section = text.split('<!-- reorder-component-recipe:start -->')[1]?.split('<!-- reorder-component-recipe:end -->')[0];
  const source = section?.match(/```typescript\n([\s\S]*?)\n```/)?.[1];
  if (!source) throw new Error('reorder recipe is missing');
  return source;
}
export async function buildReorderRecipe(root, out) {
  await build({ stdin: { contents: reorderRecipe(root), loader: 'ts', resolveDir: root },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    outfile: resolve(out, 'reorder-recipe.js') });
}
