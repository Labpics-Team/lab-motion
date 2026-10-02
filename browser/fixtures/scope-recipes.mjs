/** Исполняемые примеры берутся из docs/recipes.md, не копируются в стенд. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { build, version as esbuildVersion } from 'esbuild';
import { reorderRecipe } from './reorder-recipe.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Пакуем полный publish manifest; никакие source/dist aliases не участвуют. */
export function packScopeRecipePackage(root, directory) {
  mkdirSync(directory, { recursive: true });
  // Ближайший package boundary исключает self-reference исходного checkout:
  // без него bare import внутри root разрешается назад в root/dist.
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'scope-recipes-consumer', private: true, type: 'module' }));
  const destination = process.platform === 'win32' ? `"${directory}"` : directory;
  const [receipt] = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32' }));
  const tarball = join(directory, receipt.filename);
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (receipt.integrity !== integrity) throw new Error('scope-recipes: tarball integrity расходится с npm receipt');
  const packageRoot = join(directory, 'node_modules', '@labpics', 'motion');
  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', packageRoot, '--strip-components=1'], { timeout: 120_000 });
  const manifest = readFileSync(join(packageRoot, 'package.json'));
  const pkg = JSON.parse(manifest);
  const cookbook = readFileSync(join(packageRoot, 'docs/recipes.md'));
  if (!cookbook.equals(readFileSync(join(root, 'docs/recipes.md')))) {
    throw new Error('scope-recipes: cookbook изменился между pack и readback');
  }
  return { packageRoot, receipt: {
    schema: 'scope-recipes-package-v1', package: { name: pkg.name, version: pkg.version },
    tarball: { filename: receipt.filename, sha256: hash(bytes), integrity },
    manifest: { sha256: hash(manifest), fileCount: receipt.files.length },
    recipesSha256: hash(cookbook), runtime: { node: process.version, esbuild: esbuildVersion },
  } };
}

export function writeScopeRecipeSources(root, directory) {
  const book = readFileSync(join(root, 'docs/recipes.md'), 'utf8');
  for (const [id, file] of [['animate-scope-vanilla', 'card-motion.ts'],
    ['animate-scope-react', 'react-card.ts'], ['animate-scope-solid', 'solid-card.ts'],
    ['compositor-sheet', 'compositor-sheet.ts'], ['compositor-pager', 'compositor-pager.ts'],
    ['presence-dialog', 'presence-dialog.ts']]) {
    const marker = `<!-- recipe:${id} -->`;
    const parts = book.split(marker);
    if (parts.length !== 2) throw new Error(`Ожидается ровно один ${marker}`);
    const match = parts[1].match(/^\s*```typescript\r?\n([\s\S]*?)\r?\n```/);
    if (!match) throw new Error(`Нет исполнимого TypeScript после ${marker}`);
    writeFileSync(join(directory, file), match[1]);
  }
  writeFileSync(join(directory, 'reorder-component.ts'), reorderRecipe(root));
}

export async function buildScopeRecipes(root, out, tmp) {
  const { packageRoot, receipt } = packScopeRecipePackage(root, tmp);
  writeScopeRecipeSources(packageRoot, tmp);
  const entry = join(tmp, 'scope-entry.ts');
  writeFileSync(entry, `
    import { createElement, StrictMode, Profiler } from 'react';
    import { createRoot, hydrateRoot } from 'react-dom/client';
    import { render } from 'solid-js/web';
    import { ScopedCard } from './react-card.js';
    import { SolidScopedCard } from './solid-card.js';
    export { mountCardMotion } from './card-motion.js';
    export { mountCompositorSheet } from './compositor-sheet.js';
    export { mountCompositorPager } from './compositor-pager.js';
    export { bindAnimatedDialog } from './presence-dialog.js';
    export { mountReorder } from './reorder-component.js';
    export { CompositorSpring } from '@labpics/motion/compositor';
    export { captureSmart } from '@labpics/motion/smart';
    export { createPresenceTransition } from '@labpics/motion/presence';
    export { animate } from '@labpics/motion/animate';
    export { createReorder } from '@labpics/motion/behaviors/reorder';
    export function mountReact(container, hydrate = false) {
      let commits = 0;
      const element = createElement(StrictMode, null,
        createElement(Profiler, {id: 'scope', onRender: () => { commits++; }}, createElement(ScopedCard)));
      const root = hydrate ? hydrateRoot(container, element) : createRoot(container);
      if (!hydrate) root.render(element);
      return { destroy: () => root.unmount(), commits: () => commits };
    }
    export function mountSolid(container) { return render(SolidScopedCard, container); }
  `);
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: join(out, 'scope-recipes.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
    metafile: true,
    // StrictMode rehearsal работает только в development React. Это среда
    // проверки lifecycle, не размерный/performance benchmark production.
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const inputs = Object.keys(result.metafile.inputs).map(path => resolve(root, path));
  const motionInputs = inputs.filter(path => path.startsWith(packageRoot + sep));
  if (!motionInputs.length || inputs.some(path => path.startsWith(join(root, 'dist') + sep)
      || path.startsWith(join(root, 'src') + sep))) {
    throw new Error('scope-recipes: сборка обошла actual tarball');
  }
  const serverEntry = join(tmp, 'scope-ssr-entry.ts');
  const serverBundle = join(tmp, 'scope-ssr.cjs');
  writeFileSync(serverEntry, `
    import { createElement } from 'react';
    import { renderToString } from 'react-dom/server';
    import { ScopedCard } from './react-card.js';
    if (typeof document !== 'undefined') throw new Error('SSR fixture получил DOM');
    process.stdout.write(renderToString(createElement(ScopedCard)));
  `);
  const serverResult = await build({ absWorkingDir: root, entryPoints: [serverEntry], outfile: serverBundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const serverInputs = Object.keys(serverResult.metafile.inputs).map(path => resolve(root, path));
  if (!serverInputs.some(path => path.startsWith(packageRoot + sep))
      || serverInputs.some(path => path.startsWith(join(root, 'dist') + sep) || path.startsWith(join(root, 'src') + sep))) {
    throw new Error('scope-recipes: SSR сборка обошла actual tarball');
  }
  const serverHtml = execFileSync(process.execPath, [serverBundle], { encoding: 'utf8', timeout: 30_000 });
  writeFileSync(join(out, 'scope-react.ssr.html'), serverHtml);
  writeFileSync(join(out, 'scope-recipes.package.json'), JSON.stringify({ ...receipt,
    motionInputs: motionInputs.map(path => relative(packageRoot, path).split(sep).join('/')).sort(),
    bundleSha256: hash(readFileSync(join(out, 'scope-recipes.js'))),
    ssrHtmlSha256: hash(serverHtml),
    ssrMotionInputs: serverInputs.filter(path => path.startsWith(packageRoot + sep))
      .map(path => relative(packageRoot, path).split(sep).join('/')).sort(),
  }, null, 2) + '\n');
}
