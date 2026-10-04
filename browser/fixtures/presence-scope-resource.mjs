import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { packScopeRecipePackage } from './scope-recipes.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

/** RESOURCE consumes the same full archive as the existing browser consumers. */
export async function buildPresenceScopeResource(root, out, tmp, suppliedTarball) {
  const { packageRoot, receipt } = packScopeRecipePackage(root, tmp, suppliedTarball);
  const entry = join(tmp, 'resource-owners-entry.ts');
  writeFileSync(entry, `
    export { createPresenceTransition } from '@labpics/motion/presence';
    export { createAnimateScope } from '@labpics/motion/animate';
  `);
  const bundle = join(out, 'presence-scope-resource.js');
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: bundle,
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', metafile: true });
  const inputs = Object.keys(result.metafile.inputs).map(path => resolve(root, path));
  const motionInputs = inputs.filter(path => path.startsWith(packageRoot + sep));
  if (!motionInputs.length || inputs.some(path => path.startsWith(join(root, 'dist') + sep)
      || path.startsWith(join(root, 'src') + sep))) {
    throw new Error('presence-scope-resource: bundle bypassed the actual tarball');
  }
  const resultReceipt = { ...receipt,
    schema: 'presence-scope-resource-package-v1',
    motionInputSha256: Object.fromEntries(motionInputs.sort().map(path =>
      [relative(packageRoot, path).split(sep).join('/'), hash(readFileSync(path))])),
    bundleSha256: hash(readFileSync(bundle)),
  };
  writeFileSync(join(out, 'presence-scope-resource.package.json'), JSON.stringify(resultReceipt, null, 2) + '\n');
  return resultReceipt;
}
