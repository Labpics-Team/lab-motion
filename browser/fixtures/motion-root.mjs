import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packScopeRecipePackage } from './scope-recipes.mjs';

/** Root API и пример документации собираются из того же tarball, что остальные consumers. */
export async function buildMotionRoot(root, out, work, tarball) {
  const { packageRoot, receipt } = packScopeRecipePackage(root, work, tarball);
  const guide = readFileSync(join(packageRoot, 'docs/getting-started.md'), 'utf8');
  const example = /<!-- motion-component-example -->\s*```typescript\n([^]*?)\n```/.exec(guide)?.[1];
  if (!example) throw new Error('Нет примера root-компонента в установленном пакете');
  const entry = join(work, 'root.ts');
  writeFileSync(entry, `export { animate, scope, sequence, layout, value, MotionError } from '@labpics/motion';\n${example}\n`);
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', minify: true, write: false, metafile: true, absWorkingDir: work });
  const inputs = Object.keys(result.metafile.inputs).map(file => resolve(work, file));
  const prefix = resolve(packageRoot) + '/';
  if (!inputs.some(file => file.startsWith(prefix))) throw new Error('Root API не получен из tarball');
  if (inputs.some(file => file.startsWith(resolve(root, 'src') + '/') || file.startsWith(resolve(root, 'dist') + '/')))
    throw new Error('Сборка обошла установленный пакет');
  const bytes = result.outputFiles[0].contents;
  writeFileSync(join(out, 'motion-root.js'), bytes);
  writeFileSync(join(out, 'motion-root.package.json'), JSON.stringify({
    tarball: receipt.tarball, sourceSha256: createHash('sha256').update(example).digest('hex'),
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    modules: inputs.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length)),
  }, null, 2) + '\n');
  return receipt;
}
