/** Исполняемые примеры берутся из docs/recipes.md, не копируются в стенд. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { build, version as esbuildVersion } from 'esbuild';
import { reorderRecipe } from './reorder-recipe.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

// Исполняем CLI через Node на Windows: .cmd-shell не должен интерпретировать
// пробелы, кавычки или метасимволы пути временного consumer.
function npmPack(root, directory) {
  const windows = process.platform === 'win32';
  const shim = windows ? execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8' })
    .split(/\r?\n/).find(Boolean) : undefined;
  const cli = shim && join(dirname(shim), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (windows && (!cli || !existsSync(cli))) throw new Error('scope-recipes: npm CLI рядом с npm.cmd отсутствует');
  return JSON.parse(execFileSync(windows ? process.execPath : 'npm', [
    ...(windows ? [cli] : []), 'pack', '--ignore-scripts', '--json', '--pack-destination', directory,
  ], { cwd: root, encoding: 'utf8', timeout: 120_000 }));
}

function fileCount(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((count, entry) =>
    count + (entry.isDirectory() ? fileCount(join(directory, entry.name)) : entry.isFile() ? 1 : 0), 0);
}

/** Пакуем полный publish manifest; никакие source/dist aliases не участвуют. */
export function packScopeRecipePackage(root, directory, suppliedTarball) {
  mkdirSync(directory, { recursive: true });
  // Ближайший package boundary исключает self-reference исходного checkout:
  // без него bare import внутри root разрешается назад в root/dist.
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'scope-recipes-consumer', private: true, type: 'module' }));
  let packed;
  let tarball;
  if (suppliedTarball) {
    if (!suppliedTarball.endsWith('.tgz')) throw new Error('scope-recipes: supplied package must be a tgz');
    tarball = join(directory, 'supplied-package.tgz');
    copyFileSync(resolve(suppliedTarball), tarball);
  } else {
    const receipts = npmPack(root, directory);
    if (receipts.length !== 1) throw new Error('scope-recipes: expected one npm pack receipt');
    [packed] = receipts;
    if (!packed?.filename || basename(packed.filename) !== packed.filename) {
      throw new Error('scope-recipes: npm pack не вернул одно имя архива');
    }
    tarball = join(directory, packed.filename);
  }
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (packed && packed.integrity !== integrity) throw new Error('scope-recipes: tarball integrity расходится с npm receipt');
  const packageRoot = join(directory, 'node_modules', '@labpics', 'motion');
  rmSync(packageRoot, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', tarball, '-C', packageRoot, '--strip-components=1'], { timeout: 120_000 });
  const manifest = readFileSync(join(packageRoot, 'package.json'));
  const pkg = JSON.parse(manifest);
  const candidate = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== candidate.name || pkg.version !== candidate.version) {
    throw new Error('scope-recipes: packed identity differs from the candidate');
  }
  const cookbook = readFileSync(join(packageRoot, 'docs/recipes.md'));
  if (!cookbook.equals(readFileSync(join(root, 'docs/recipes.md')))) {
    throw new Error('scope-recipes: cookbook изменился между pack и readback');
  }
  return { packageRoot, tarball, receipt: {
    schema: 'scope-recipes-package-v1', package: { name: pkg.name, version: pkg.version },
    tarball: { filename: basename(tarball), sha256: hash(bytes), integrity },
    manifest: { sha256: hash(manifest), fileCount: fileCount(packageRoot) },
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

export async function buildScopeRecipes(root, out, tmp, suppliedTarball) {
  const { packageRoot, tarball, receipt } = packScopeRecipePackage(root, tmp, suppliedTarball);
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
  const archivedTarball = 'scope-recipes-package.tgz';
  copyFileSync(tarball, join(out, archivedTarball));
  const resultReceipt = { ...receipt,
    tarball: { ...receipt.tarball, file: archivedTarball },
    motionInputs: motionInputs.map(path => relative(packageRoot, path).split(sep).join('/')).sort(),
    motionInputSha256: Object.fromEntries(motionInputs.sort().map(path =>
      [relative(packageRoot, path).split(sep).join('/'), hash(readFileSync(path))])),
    bundleSha256: hash(readFileSync(join(out, 'scope-recipes.js'))),
    ssrHtmlSha256: hash(serverHtml),
    ssrMotionInputs: serverInputs.filter(path => path.startsWith(packageRoot + sep))
      .map(path => relative(packageRoot, path).split(sep).join('/')).sort(),
  };
  writeFileSync(join(out, 'scope-recipes.package.json'), JSON.stringify(resultReceipt, null, 2) + '\n');
  return resultReceipt;
}
