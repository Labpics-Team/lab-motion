import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

/** Документация — исполняемый источник, без второй копии recipe в тесте. */
export async function buildKeyframeRecipe(root, out) {
  const text = readFileSync(resolve(root, 'docs/recipes.md'), 'utf8');
  const match = /<!-- animate-keyframe-recipe:start -->\s*```typescript\n([\s\S]*?)\n```\s*<!-- animate-keyframe-recipe:end -->/.exec(text);
  if (!match) throw new Error('keyframe recipe marker or executable body missing');
  await build({
    stdin: { contents: match[1], loader: 'ts', resolveDir: root },
    alias: { '@labpics/motion/animate': resolve(root, 'dist/animate/index.js') },
    outfile: resolve(out, 'keyframe-recipe.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022',
  });
}
