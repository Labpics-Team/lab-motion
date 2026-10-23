/**
 * Ограниченный эксперимент над копиями уже опубликованных root-файлов.
 * Это измерение, не shipping-политика и не проверка семантики минификатора.
 *
 * node bench/root-compression-experiment.mjs BASELINE CANDIDATE NEW_OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.equal(args.length, 3, 'Нужны BASELINE CANDIDATE NEW_OUTPUT_DIR');
const [baseline, candidate] = args.slice(0, 2).map(path => realpathSync(resolve(path)));
const requested = resolve(args[2]);
// Родитель уже существует (в CI это RUNNER_TEMP); не пишем через скрытый symlink в checkout.
const work = join(realpathSync(dirname(requested)), basename(requested));
const requireCandidate = createRequire(join(candidate, 'package.json'));
const { minify } = requireCandidate('terser');
const { canonicalGzip, observationalBrotli } = await import(pathToFileURL(join(candidate, 'scripts/compression-oracle.mjs')));
const { CANONICAL_GZIP_OPTIONS } = await import(pathToFileURL(join(candidate, 'scripts/compression-policy.mjs')));
const { measureEsmTransfer, deriveEntriesFromExports } = await import(pathToFileURL(join(candidate, 'scripts/size-gate.mjs')));
const { hashFileTree, sha256File, sha256Bytes } = await import(pathToFileURL(join(candidate, 'bench/compare/provenance.mjs')));
const consumerScript = join(candidate, 'bench/consumer-size.mjs');
const sourcePackage = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
const rootGate = deriveEntriesFromExports(sourcePackage).find(entry => entry.key === '.')?.gate;
assert.ok(Number.isFinite(rootGate), 'Не найден действующий shipped-root budget');

function inside(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

for (const root of [baseline, candidate]) {
  assert.ok(!inside(root, work) && !inside(work, root), 'OUTPUT не должен пересекаться с исходным пакетом');
}
assert.ok(!existsSync(work), 'Каталог эксперимента уже существует: ' + work);

function assertRegularTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) assertRegularTree(file);
    else assert.ok(entry.isFile(), 'dist должен содержать обычные файлы: ' + file);
  }
}

function snapshot(root) {
  const dist = join(root, 'dist');
  assertRegularTree(dist);
  return { packageJsonSha256: sha256File(join(root, 'package.json')), dist: hashFileTree(dist) };
}

function packageFile(root, target) {
  assert.equal(typeof target, 'string', 'Не найден runtime target в package.json');
  assert.ok(target.startsWith('./dist/'), 'Runtime target должен принадлежать dist');
  const file = realpathSync(resolve(root, target));
  assert.ok(inside(realpathSync(join(root, 'dist')), file), 'Runtime target вышел за dist');
  return file;
}

function rootTargets(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const targets = {
    esm: pkg.exports?.['.']?.import?.default,
    cjs: pkg.exports?.['.']?.require?.default,
  };
  for (const target of Object.values(targets)) packageFile(root, target);
  assert.notEqual(targets.esm, targets.cjs, 'ESM и CJS должны быть отдельными файлами');
  return targets;
}

function bytes(file) {
  const raw = readFileSync(file);
  return {
    sha256: sha256Bytes(raw), rawBytes: raw.length,
    gzBytes: canonicalGzip(raw).length, brBytes: observationalBrotli(raw).length,
  };
}

function installedPackage(name) {
  let packageFile;
  try { packageFile = requireCandidate.resolve(name + '/package.json'); }
  catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    packageFile = (requireCandidate.resolve.paths(name) ?? [])
      .map(path => join(path, name, 'package.json')).find(path => existsSync(path));
    assert.ok(packageFile, 'Не найден package.json для ' + name);
  }
  packageFile = realpathSync(packageFile);
  const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
  assert.equal(metadata.name, name);
  return { version: metadata.version, packageJsonSha256: sha256File(packageFile), ...hashFileTree(dirname(packageFile)) };
}

function toolchainIdentity() {
  return {
    node: process.version, versions: process.versions, platform: process.platform, arch: process.arch,
    nodeExecutableSha256: sha256File(realpathSync(process.execPath)), execArgv: process.execArgv,
    terser: { ...installedPackage('terser'), entrySha256: sha256File(requireCandidate.resolve('terser')) },
    gzip: { package: 'pako', ...installedPackage('pako'), options: CANONICAL_GZIP_OPTIONS },
    brotli: { implementation: 'node:zlib', quality: 11, version: process.versions.brotli },
    scripts: Object.fromEntries([
      'scripts/size-gate.mjs', 'scripts/compression-oracle.mjs', 'scripts/compression-policy.mjs',
      'bench/consumer-size.mjs', 'bench/compare/provenance.mjs',
    ].map(path => [path, sha256File(join(candidate, path))])),
    experimentSha256: sha256File(fileURLToPath(import.meta.url)),
  };
}

function clonePackage(source, label) {
  const root = join(work, 'packages', label);
  mkdirSync(root, { recursive: true });
  copyFileSync(join(source, 'package.json'), join(root, 'package.json'));
  cpSync(join(source, 'dist'), join(root, 'dist'), { recursive: true, errorOnExist: true, force: false });
  // Каждый consumer использует один candidate oracle и один установленный toolchain.
  cpSync(join(candidate, 'scripts'), join(root, 'scripts'), { recursive: true, errorOnExist: true, force: false });
  mkdirSync(join(root, 'bench/compare'), { recursive: true });
  copyFileSync(join(candidate, 'bench/compare/provenance.mjs'), join(root, 'bench/compare/provenance.mjs'));
  symlinkSync(join(candidate, 'node_modules'), join(root, 'node_modules'), 'dir');
  assert.deepEqual(snapshot(root), snapshot(source), 'Копия package.json/dist отличается от входа');
  return root;
}

function nonRootIdentity(root) {
  const excluded = new Set(Object.values(rootTargets(root)).map(target => packageFile(root, target)));
  return hashFileTree(join(root, 'dist'), file => !excluded.has(file));
}

function frameFiles(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.fromEntries(['import', 'require'].map(format => {
    const target = pkg.imports?.['#frame']?.[format];
    return [format, { target, ...bytes(packageFile(root, target)) }];
  }));
}

function change(before, after) {
  return Object.fromEntries(['rawBytes', 'gzBytes', 'brBytes'].map(key => [key, {
    deltaBytes: after[key] - before[key],
    reductionPercent: before[key] === 0 ? null : (1 - after[key] / before[key]) * 100,
  }]));
}

function optionsFor(kind, esm) {
  // Каждый вызов получает новые nested objects: Terser дописывает свои options.
  return kind === 'p6' ? {
    module: esm, compress: { passes: 6, pure_getters: true }, mangle: true,
    format: { preserve_annotations: true, ascii_only: false },
  } : {
    module: esm, compress: false, mangle: false,
    format: { preserve_annotations: true, ascii_only: true },
  };
}

async function transform(root, kind) {
  const steps = {};
  for (const [format, target] of Object.entries(rootTargets(root))) {
    const file = packageFile(root, target);
    const before = bytes(file);
    const options = optionsFor(kind, format === 'esm');
    const recordedOptions = structuredClone(options);
    const result = await minify(readFileSync(file, 'utf8'), options);
    assert.equal(typeof result.code, 'string', 'Terser не вернул JavaScript');
    writeFileSync(file, result.code);
    steps[format] = { target, options: recordedOptions, input: before, output: bytes(file) };
  }
  return steps;
}

function saveRootFiles(root, label) {
  for (const target of Object.values(rootTargets(root))) {
    const output = join(work, 'root-output', label, target.slice(2));
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(packageFile(root, target), output);
  }
}

const before = { baseline: snapshot(baseline), candidate: snapshot(candidate) };
const toolchain = toolchainIdentity();
const report = {
  schemaVersion: 1, measuredAt: new Date().toISOString(), measurementOnly: true,
  semanticValidationRun: false,
  boundaries: {
    esm: 'existing measureEsmTransfer: initial static closure; each file compressed separately',
    cjs: 'root file only; no claim about the CJS dependency closure',
    consumers: 'existing consumer-size.mjs: all eight imports, initial/lazy/total; one candidate toolchain',
  },
  revisions: { baseline: process.env.MOTION_BASELINE_SHA ?? null, candidate: process.env.GITHUB_SHA ?? null },
  shippedRootGzipBudget: rootGate,
  inputBefore: before, toolchain, variants: {},
};
mkdirSync(join(work, 'reports'), { recursive: true });
function saveReport() {
  writeFileSync(join(work, 'reports/experiment.json'), JSON.stringify(report, null, 2) + '\n');
}

let baselineCopy;
let consumerToolchain;
async function measure(root, label, transformation = null) {
  const identity = snapshot(root);
  const targets = rootTargets(root);
  const files = Object.fromEntries(Object.entries(targets).map(([format, target]) => [format, {
    target, ...bytes(packageFile(root, target)),
  }]));
  const shippedEsm = measureEsmTransfer(targets.esm, root);
  assert.equal(shippedEsm.entryRawBytes, files.esm.rawBytes);
  assert.equal(shippedEsm.entryGzBytes, files.esm.gzBytes);
  assert.equal(shippedEsm.entryBrBytes, files.esm.brBytes);
  const nonRootDist = nonRootIdentity(root);
  const sharedFrame = frameFiles(root);
  assert.deepEqual(nonRootDist, nonRootIdentity(candidate), 'Изменился не-root dist');
  assert.deepEqual(sharedFrame, frameFiles(candidate), 'Изменился общий frame');
  const consumerPath = join(work, 'reports', 'consumer-' + label + '.json');
  execFileSync(process.execPath, [consumerScript, baselineCopy, root, consumerPath], { stdio: 'inherit' });
  const consumers = JSON.parse(readFileSync(consumerPath, 'utf8'));
  assert.equal(consumers.results.length, 8, 'Нужны все восемь consumer-сценариев');
  assert.equal(consumers.verification.artifactsUnchanged, true);
  assert.equal(consumers.verification.toolchainUnchanged, true);
  assert.equal(consumers.verification.samePublicExports, true);
  if (consumerToolchain) assert.deepEqual(consumers.toolchain, consumerToolchain, 'Consumer toolchain изменился между вариантами');
  else consumerToolchain = consumers.toolchain;
  assert.deepEqual(snapshot(root), identity, 'Измерение изменило временный пакет');
  saveRootFiles(root, label);
  const row = {
    identity, transformation, files, shippedEsm, nonRootDist, sharedFrame,
    shippedRootBudget: { limit: rootGate, exceeded: shippedEsm.gzBytes > rootGate, excessBytes: Math.max(0, shippedEsm.gzBytes - rootGate) },
    consumers: {
      report: 'consumer-' + label + '.json', sha256: sha256File(consumerPath),
      compilerProfile: consumers.compilerProfile, verification: consumers.verification,
      results: consumers.results,
    },
  };
  const control = report.variants.control;
  if (control) row.changeFromControl = {
    shippedEsm: change(control.shippedEsm, shippedEsm),
    rootEsm: change(control.files.esm, files.esm), rootCjs: change(control.files.cjs, files.cjs),
  };
  report.variants[label] = row;
  saveReport();
  console.log(label + ': shipped root gzip ' + shippedEsm.gzBytes + ' B, Brotli ' + shippedEsm.brBytes
    + ' B; budget excess ' + row.shippedRootBudget.excessBytes + ' B');
}

try {
  baselineCopy = clonePackage(baseline, 'baseline');
  const control = clonePackage(candidate, 'control');
  saveRootFiles(baselineCopy, 'baseline');
  report.baselineShippedEsm = measureEsmTransfer(rootTargets(baselineCopy).esm, baselineCopy);
  await measure(control, 'control');
  const p6 = clonePackage(candidate, 'p6');
  await measure(p6, 'p6', await transform(p6, 'p6'));
  // Второй вариант отличается от p6 только AST parse/print с ascii_only.
  const ascii = clonePackage(p6, 'p6-ascii');
  await measure(ascii, 'p6-ascii', await transform(ascii, 'ascii'));
  report.completed = true;
} catch (error) {
  report.completed = false;
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  try {
    report.inputAfter = { baseline: snapshot(baseline), candidate: snapshot(candidate) };
    assert.deepEqual(report.inputAfter, before, 'Исходные package.json/dist изменились');
    assert.deepEqual(toolchainIdentity(), toolchain, 'Исходный toolchain/oracle изменился');
    report.verification = { sourceArtifactsUnchanged: true, toolchainUnchanged: true };
  } catch (error) {
    report.verificationError = { name: error.name, message: error.message };
    report.completed = false;
    process.exitCode = 1;
    console.error(error);
  }
  saveReport();
  requireCandidate('esbuild').stop();
}
