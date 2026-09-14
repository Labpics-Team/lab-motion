/** Исполняемые примеры берутся из docs/recipes.md, не копируются в стенд. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

export function writeScopeRecipeSources(root, directory) {
  const book = readFileSync(join(root, 'docs/recipes.md'), 'utf8');
  for (const [id, file] of [['vanilla', 'card-motion.ts'], ['react', 'react-card.ts'], ['solid', 'solid-card.ts']]) {
    const marker = `<!-- recipe:animate-scope-${id} -->`;
    const parts = book.split(marker);
    if (parts.length !== 2) throw new Error(`Ожидается ровно один ${marker}`);
    const match = parts[1].match(/^\s*```typescript\n([\s\S]*?)\n```/);
    if (!match) throw new Error(`Нет исполнимого TypeScript после ${marker}`);
    writeFileSync(join(directory, file), match[1]);
  }
}

export async function buildScopeRecipes(root, out, tmp) {
  writeScopeRecipeSources(root, tmp);
  const entry = join(tmp, 'scope-entry.ts');
  writeFileSync(entry, `
    import { createElement, StrictMode, Profiler } from 'react';
    import { createRoot } from 'react-dom/client';
    import { render } from 'solid-js/web';
    import { ScopedCard } from './react-card.js';
    import { SolidScopedCard } from './solid-card.js';
    export { mountCardMotion } from './card-motion.js';
    export function mountReact(container) {
      let commits = 0;
      const root = createRoot(container);
      root.render(createElement(StrictMode, null,
        createElement(Profiler, {id: 'scope', onRender: () => { commits++; }}, createElement(ScopedCard))));
      return { destroy: () => root.unmount(), commits: () => commits };
    }
    export function mountSolid(container) { return render(SolidScopedCard, container); }
  `);
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(out, 'scope-recipes.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    alias: { '@labpics/motion/animate': join(root, 'dist/animate/index.js') },
    // StrictMode rehearsal работает только в development React. Это среда
    // проверки lifecycle, не размерный/performance benchmark production.
    define: { 'process.env.NODE_ENV': '"development"' },
  });
}
