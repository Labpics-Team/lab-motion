/**
 * Цена корневых импортов после сборки потребителя одним toolchain.
 * Входы — уже собранные пакеты; этот скрипт не пересобирает и не меняет их.
 *
 * node bench/consumer-size.mjs BASELINE_PACKAGE CANDIDATE_PACKAGE OUTPUT.json
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.equal(args.length, 3, 'Нужны BASELINE_PACKAGE CANDIDATE_PACKAGE OUTPUT.json');
const roots = args.slice(0, 2).map(path => realpathSync(resolve(path)));
const output = resolve(args[2]);
assert.ok(!existsSync(output), 'Отчёт уже существует: ' + output);

const candidate = roots[1];
const requireCandidate = createRequire(join(candidate, 'package.json'));
const esbuild = requireCandidate('esbuild');
// Оба входа используют один существующий расчёт графа и один compression oracle.
const { measureScenarioOutputGraph } = await import(pathToFileURL(join(candidate, 'scripts/size-gate.mjs')));
const { hashFileTree, sha256File, sha256Bytes } = await import(pathToFileURL(join(candidate, 'bench/compare/provenance.mjs')));

const compilerProfile = {
  bundle: true,
  minify: true,
  treeShaking: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  tsconfigRaw: {},
  splitting: true,
  metafile: true,
  write: false,
  logLevel: 'silent',
};
const outdir = '__consumer_size_output__';
const entrySource = '__consumer_size_entry__.mjs';
const names = ['animate', 'sequence', 'scope', 'layout', 'value', 'playhead', 'MotionError'];
const scenarios = [...names, '*'];

function inside(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function assertRegularTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assertRegularTree(path);
    else assert.ok(entry.isFile(), 'В измеряемом dist нужен обычный файл: ' + path);
  }
}

function packageIdentity(root) {
  const packageFile = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  const target = pkg.exports?.['.']?.import?.default;
  assert.equal(typeof target, 'string', 'Нужен корневой exports.import.default');
  assert.ok(target.startsWith('./dist/'), 'Корневой ESM export должен принадлежать dist');
  const dist = realpathSync(join(root, 'dist'));
  const entry = realpathSync(resolve(root, target));
  assert.ok(inside(dist, entry), 'Корневой export вышел за dist');
  assert.ok(!inside(dist, output), 'Отчёт нельзя сохранять внутри измеряемого dist');
  assertRegularTree(dist);
  return {
    name: pkg.name,
    version: pkg.version,
    rootExport: target,
    packageJsonSha256: sha256File(packageFile),
    dist: hashFileTree(dist),
  };
}

function installedPackage(name, from = requireCandidate) {
  let packageFile;
  try {
    packageFile = realpathSync(from.resolve(name + '/package.json'));
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    // Закрытый exports не мешает закрепить дерево фактически выбранного пакета.
    const found = (from.resolve.paths(name) ?? [])
      .map(directory => join(directory, name, 'package.json')).find(file => existsSync(file));
    assert.ok(found, 'Не найден package.json для ' + name);
    packageFile = realpathSync(found);
  }
  const directory = dirname(packageFile);
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  assert.equal(pkg.name, name);
  return { directory, metadata: pkg, identity: { version: pkg.version, ...hashFileTree(directory) } };
}

function toolchainIdentity() {
  const compiler = installedPackage('esbuild');
  assert.equal(compiler.metadata.version, esbuild.version, 'esbuild API и package.json расходятся');
  const compilerRequire = createRequire(join(compiler.directory, 'package.json'));
  const nativePackages = {};
  for (const name of Object.keys(compiler.metadata.optionalDependencies ?? {}).sort()) {
    try {
      nativePackages[name] = installedPackage(name, compilerRequire).identity;
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  const gzip = installedPackage('pako');
  const oracle = [
    'scripts/size-gate.mjs',
    'scripts/compression-oracle.mjs',
    'scripts/compression-policy.mjs',
    'bench/compare/provenance.mjs',
  ];
  const override = process.env.ESBUILD_BINARY_PATH;
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    nodeExecutableSha256: sha256File(realpathSync(process.execPath)),
    esbuild: compiler.identity,
    nativePackages,
    ...(override ? { binaryOverride: { path: realpathSync(override), sha256: sha256File(override) } } : {}),
    gzip: { package: 'pako', ...gzip.identity },
    brotli: { implementation: 'node:zlib', quality: 11, version: process.versions.brotli },
    oracle: Object.fromEntries(oracle.map(path => [path, sha256File(join(candidate, path))])),
    scriptSha256: sha256File(fileURLToPath(import.meta.url)),
  };
}

async function measure(root, identity, name) {
  const entry = resolve(root, identity.rootExport).split(sep).join('/');
  const specifier = JSON.stringify(entry);
  const code = name === '*'
    ? 'export * from ' + specifier + ';'
    : 'import { ' + name + ' } from ' + specifier + '; export { ' + name + ' };';
  const entryPoint = resolve(root, entrySource);
  const built = await esbuild.build({
    ...compilerProfile,
    absWorkingDir: root,
    stdin: { contents: code, resolveDir: root, sourcefile: entryPoint, loader: 'js' },
    outdir,
  });
  const dist = realpathSync(join(root, 'dist'));
  for (const path of Object.keys(built.metafile.inputs)) {
    const absolute = resolve(root, path);
    if (absolute !== entryPoint)
      assert.ok(inside(dist, realpathSync(absolute)), 'Неучтённый внешний runtime input: ' + path);
  }
  for (const file of Object.values(built.metafile.outputs)) {
    assert.ok(file.imports.every(edge => !edge.external), 'Внешняя runtime-зависимость не учтена в весе');
  }
  const entryOutput = Object.values(built.metafile.outputs).filter(
    item => item.entryPoint && resolve(root, item.entryPoint) === entryPoint,
  );
  assert.equal(entryOutput.length, 1, 'У consumer должен быть один корневой output');
  const exports = [...entryOutput[0].exports].sort();
  if (name !== '*') assert.deepEqual(exports, [name]);
  const files = built.outputFiles.map(file => ({
    path: relative(resolve(root, outdir), file.path).split(sep).join('/'),
    sha256: sha256Bytes(file.contents),
    bytes: file.contents.byteLength,
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    ...measureScenarioOutputGraph(built, { absWorkingDir: root, outdir, entryPoint }),
    exports,
    outputSha256: sha256Bytes(Buffer.from(JSON.stringify(files))),
    files,
  };
}

function changes(baseline, candidate) {
  return Object.fromEntries([
    'rawBytes', 'gzBytes', 'brBytes',
    'lazyRawBytes', 'lazyGzBytes', 'lazyBrBytes',
    'totalRawBytes', 'totalGzBytes', 'totalBrBytes',
  ].map(key => [key, {
    deltaBytes: candidate[key] - baseline[key],
    candidateOverBaseline: baseline[key] === 0 ? null : candidate[key] / baseline[key],
    reductionPercent: baseline[key] === 0 ? null : (1 - candidate[key] / baseline[key]) * 100,
  }]));
}

try {
  const identities = roots.map(packageIdentity);
  const toolchain = toolchainIdentity();
  const results = [];
  for (const name of scenarios) {
    const baseline = await measure(roots[0], identities[0], name);
    const candidate = await measure(roots[1], identities[1], name);
    assert.deepEqual(candidate.exports, baseline.exports, 'Сравниваемые публичные exports различаются');
    results.push({ name: name === '*' ? 'full root' : 'root ' + name,
      baseline, candidate, change: changes(baseline, candidate) });
  }
  const after = roots.map(packageIdentity);
  assert.deepEqual(after, identities, 'Package metadata или dist изменились во время измерения');
  assert.deepEqual(toolchainIdentity(), toolchain, 'Toolchain или oracle изменились во время измерения');
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    measurement: 'production consumer import-cost',
    compilerProfile,
    compression: 'canonical gzip; Node Brotli quality 11; каждый output сжимается отдельно',
    baseline: identities[0],
    candidate: identities[1],
    toolchain,
    verification: { artifactsUnchanged: true, toolchainUnchanged: true, samePublicExports: true },
    results,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const row of results) console.log(row.name + ': gzip '
    + row.baseline.totalGzBytes + ' -> ' + row.candidate.totalGzBytes + ' B; Brotli '
    + row.baseline.totalBrBytes + ' -> ' + row.candidate.totalBrBytes + ' B');
  console.log('consumer-size: ' + output);
} finally {
  esbuild.stop();
}
