import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { measureScenarioOutputGraph } from '../../scripts/size-gate.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Буквальный UI-код документации собирается и из установленного пакета. */
export function compositorFollowRecipes(root) {
  const text = readFileSync(resolve(root, 'docs/recipes.md'), 'utf8').replaceAll('\r\n', '\n');
  const section = text.split('<!-- compositor-follow-recipes:start -->')[1]
    ?.split('<!-- compositor-follow-recipes:end -->')[0];
  const source = section?.match(/```typescript\n([\s\S]*?)\n```/)?.[1];
  if (!source) throw new Error('compositor follow recipes are missing');
  return source;
}

export async function buildCompositorFollowRecipes(root, out, consumerRoot = root, diagnosticObserver = false) {
  const packageRoot = realpathSync(root);
  const absWorkingDir = realpathSync(consumerRoot);
  const entryPoint = resolve(absWorkingDir, 'compositor-follow-recipes.ts');
  const outdir = resolve(out);
  const literalSource = compositorFollowRecipes(packageRoot);
  const importHead = 'import { createCompositorFollow,';
  if (diagnosticObserver && literalSource.split(importHead).length !== 2) {
    throw new Error('diagnostic observer requires one explicit compositor follow import');
  }
  const source = diagnosticObserver
    ? literalSource.replace(importHead, 'import { createCompositorFollow as createUnobservedCompositorFollow,') + `
function createCompositorFollow(...args: Parameters<typeof createUnobservedCompositorFollow>) {
  return globalThis.followProbe.observe(createUnobservedCompositorFollow(...args));
}
`
    : literalSource;
  const result = await build({
    absWorkingDir,
    stdin: { contents: source, loader: 'ts', resolveDir: absWorkingDir, sourcefile: entryPoint },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, splitting: true, metafile: true, write: false,
    outdir, entryNames: 'compositor-follow-recipes',
  });
  const inputs = Object.keys(result.metafile.inputs).map((path) => resolve(absWorkingDir, path));
  for (const input of inputs) {
    if (input !== entryPoint && !input.startsWith(packageRoot + sep)) {
      throw new Error('recipe dependency escaped installed package: ' + input);
    }
  }
  const measurement = measureScenarioOutputGraph(result, { absWorkingDir, outdir, entryPoint });
  const outputs = result.outputFiles.map((file) => {
    writeFileSync(file.path, file.contents);
    return { file: relative(outdir, file.path).split(sep).join('/'), sha256: sha256(file.contents) };
  });
  return {
    documentSha256: sha256(readFileSync(resolve(packageRoot, 'docs/recipes.md'))),
    sourceSha256: sha256(source),
    ...(diagnosticObserver ? { diagnostic: {
      kind: 'public-boundary-observer', literalSourceSha256: sha256(literalSource),
    } } : {}),
    packageInputs: inputs.filter((input) => input !== entryPoint)
      .map((input) => relative(packageRoot, input).split(sep).join('/')).sort(),
    outputs, measurement,
  };
}

/** Тот же tgz обслуживает package checks и реальные browser journeys. */
export async function buildPackagedCompositorFollowRecipes(root, out, suppliedTarball) {
  const windows = process.platform === 'win32';
  const run = (args, cwd) => {
    // cmd запускает .cmd-shim; кавычки сохраняют пробелы, expansion запрещён.
    const commandArgs = windows ? args.map((arg) => {
      if (/[\"%!\r\n]/.test(arg)) throw new Error('unsupported cmd argument in recipe package path');
      return '\"' + arg + '\"';
    }) : args;
    return execFileSync(windows ? 'pnpm.cmd' : 'pnpm', commandArgs, {
      cwd, shell: windows, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'motion-follow-package-'));
  try {
    const tarball = resolve(out, 'compositor-follow-package.tgz');
    if (suppliedTarball) {
      if (!suppliedTarball.endsWith('.tgz')) throw new Error('supplied recipe package must be a tgz');
      copyFileSync(resolve(suppliedTarball), tarball);
    } else {
      run(['pack', '--pack-destination', work], root);
      const archives = readdirSync(work).filter((name) => name.endsWith('.tgz'));
      if (archives.length !== 1) throw new Error('expected one packed recipe candidate');
      copyFileSync(join(work, archives[0]), tarball);
    }
    const consumer = join(work, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'motion-follow-consumer', private: true, type: 'module', packageManager: pkg.packageManager,
    }));
    run(['add', '--ignore-scripts', '--offline', '--config.auto-install-peers=false',
      '--store-dir', join(work, 'store'), tarball], consumer);
    const installed = resolve(consumer, 'node_modules', ...pkg.name.split('/'));
    const shipped = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (shipped.name !== pkg.name || shipped.version !== pkg.version) {
      throw new Error('packed recipe identity differs from the candidate');
    }
    // Временная диагностика WebKit; удалить после различения второго release.
    const recipe = await buildCompositorFollowRecipes(installed, out, consumer, true);
    const receipt = {
      package: shipped.name + '@' + shipped.version,
      tarball: { file: basename(tarball), sha256: sha256(readFileSync(tarball)) },
      ...recipe,
    };
    writeFileSync(resolve(out, 'compositor-follow-package.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
