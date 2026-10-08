import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { packScopeRecipePackage } from './scope-recipes.mjs';
import { readCompilerProjectRecipe } from '../../scripts/compiler-doc-recipe.mjs';

/** Один реальный пакет питает типы, сборку и исполняемый браузерный пример. */
export async function buildCompilerProject(root, out, work, suppliedTarball) {
  const { packageRoot, receipt } = packScopeRecipePackage(root, work, suppliedTarball);
  const source = readCompilerProjectRecipe(packageRoot);
  assert.equal(source, readCompilerProjectRecipe(root));
  const entry = join(work, 'project.ts'); writeFileSync(entry, source);
  const { motionCompiler } = await import(pathToFileURL(join(packageRoot, 'dist/compiler/vite/index.js')).href);
  mkdirSync(out, { recursive: true });
  const outputs = {};
  for (const compiled of [false, true]) {
    const result = await build({ root: work, configFile: false, logLevel: 'silent',
      plugins: compiled ? [motionCompiler()] : [],
      build: { write: false, minify: true, target: 'es2022', lib: { entry, formats: ['es'], fileName: 'project' } } });
    const output = (Array.isArray(result) ? result[0] : result).output;
    assert.equal(output.length, 1, 'Пример должен быть самодостаточным');
    const chunk = output[0]; assert.equal(chunk.type, 'chunk');
    const ids = Object.keys(chunk.modules).map(id => id.replaceAll('\\', '/'));
    const prefix = packageRoot.replaceAll('\\', '/') + '/';
    const packageIds = ids.filter(id => id.startsWith(prefix));
    assert.ok(packageIds.length > 0, 'Пакет не попал в граф потребителя');
    const sourcePrefixes = ['dist', 'src'].map(name => join(root, name).replaceAll('\\', '/') + '/');
    assert.ok(!ids.some(id => sourcePrefixes.some(prefix => id.startsWith(prefix))), 'Сборка обошла установленный пакет');
    const modules = packageIds.map(id => id.slice(prefix.length)).sort();
    if (compiled) {
      assert.deepEqual(modules, ['dist/compiler/runtime/index.js', 'dist/compiler/surface/index.js']);
      assert.ok(!/Math\.(?:exp|cos|sin|sqrt)/.test(chunk.code));
    } else {
      assert.ok(modules.includes('dist/animate/index.js') && modules.includes('dist/nano/index.js'));
    }
    const name = compiled ? 'compiled' : 'runtime';
    writeFileSync(join(out, `compiler-project-${name}.js`), chunk.code);
    outputs[name] = { gzipBytes: gzipSync(chunk.code).length, modules,
      sha256: createHash('sha256').update(chunk.code).digest('hex') };
  }
  const result = { tarball: receipt.tarball, sourceSha256: createHash('sha256').update(source).digest('hex'), outputs };
  writeFileSync(join(out, 'compiler-project.package.json'), JSON.stringify(result, null, 2) + '\n');
  return { ...result, entry };
}
