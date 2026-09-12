/**
 * Парный Node-стенд cold-cache/warm Surface compile и полного Vite transform.
 * Прогревает измеряемую границу; не делает browser/first-pixel утверждений.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertCheckoutUnchanged, assertFileHashesUnchanged, assertInstalledPackageTreesUnchanged,
  hashFileTree, prepareBenchmarkCheckout, readCheckoutState, sha256File,
} from '../bench/compare/provenance.mjs';
import {
  consumeSurface, runSurfaceCluster, summarizeSurfacePair, surfaceBurstVerifier,
  surfaceCalibrationAdmitted, surfaceInputs, surfaceProbeSource,
  surfaceProfiles, surfaceVerdict, SURFACE_CALIBRATION_IDS, SURFACE_PAIR_POLICY,
} from './bench-surface-support.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');

export function parseSurfaceBenchArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--calibrate-only') {
      assert(!options.calibrateOnly, 'surface bench: повтор --calibrate-only');
      options.calibrateOnly = true;
      continue;
    }
    assert(['--base', '--candidate', '--out'].includes(name), `surface bench: неизвестный аргумент ${name}`);
    const key = name.slice(2);
    assert(!options[key], `surface bench: повтор ${name}`);
    const value = args[++i];
    assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `surface bench: нет значения ${name}`);
    options[key] = path.resolve(value);
  }
  assert(options.base && options.out && (options.candidate || options.calibrateOnly),
    'Использование: --base CHECKOUT --candidate CHECKOUT --out NEW_DIRECTORY [--calibrate-only]');
  assert(!(options.calibrateOnly && options.candidate), 'surface bench: --calibrate-only не принимает candidate');
  return options;
}

function parserFor(root) {
  // Acorn принадлежит фактически установленному Terser; не выбирается случайный
  // похожий каталог из .pnpm. Версия и байты сохраняются в provenance.
  const require = createRequire(realpathSync(path.join(root, 'node_modules/terser/package.json')));
  const packageDirectory = path.dirname(require.resolve('acorn/package.json'));
  return { module: require.resolve('acorn'), parse: require('acorn').parse, packageDirectory };
}

async function operationFor(probe, profile, parse) {
  const module = await import(pathToFileURL(probe));
  const compiler = module.motionCompiler();
  const inputs = surfaceInputs(profile);
  const context = { parse: code => parse(code, { ecmaVersion: 2022, sourceType: 'module' }),
    warn(message) { throw new Error(`surface bench: неожиданный warning: ${message}`); } };
  const checksums = inputs.map(code => {
    const result = compiler.transform.call(context, code, 'consumer.js');
    assert.equal(result !== undefined, profile.lowered, 'surface bench: изменилась admission-топология');
    if (result) assert(result.code.includes('__labMotionSurface'), 'surface bench: lowering не состоялся');
    const checksum = consumeSurface(result, profile.mode === 'consume');
    assert(Number.isFinite(checksum));
    return checksum;
  });
  let cursor = 0;
  return { checksums, run: () => consumeSurface(compiler.transform.call(context,
    inputs[cursor++ % inputs.length], 'consumer.js'), profile.mode === 'consume') };
}

async function worker(config) {
  const manifest = JSON.parse(readFileSync(config.manifest, 'utf8'));
  assert.deepEqual(manifest.policy, SURFACE_PAIR_POLICY);
  assert.equal(sha256File(process.execPath), manifest.nodeExecutable);
  assertFileHashesUnchanged(manifest.probeHashes);
  const profile = surfaceProfiles().find(p => p.id === config.profile);
  assert(profile, 'surface bench: неизвестный worker profile');
  assert(['AA', 'double', 'candidate'].includes(config.comparison));
  const { parse } = await import(pathToFileURL(manifest.acorn.module));
  const other = config.comparison === 'candidate' ? manifest.probes.candidate : manifest.probes.equal;
  assert(other && other !== manifest.probes.base, 'surface bench: участникам нужны независимые module identities');
  const operations = [await operationFor(manifest.probes.base, profile, parse), await operationFor(other, profile, parse)];
  const clock = () => Array.from({ length: 64 }, () => {
    const start = process.hrtime.bigint();
    return Number(process.hrtime.bigint() - start);
  });
  const clockBeforeNs = clock();
  const resourceBefore = process.resourceUsage();
  const result = runSurfaceCluster(operations.map(op => op.run), profile, config.cluster, {
    verify: surfaceBurstVerifier(operations.map(op => op.checksums)),
    multipliers: config.comparison === 'double' ? [1, 2] : [1, 1],
  });
  const resourceAfter = process.resourceUsage();
  result.resources = { before: resourceBefore, after: resourceAfter };
  result.clock = { beforeNs: clockBeforeNs, afterNs: clock() }; // Не вычитается из latency.
  process.stdout.write(JSON.stringify(result) + '\n');
}

function installedTool(root, name) {
  const directory = realpathSync(path.join(root, 'node_modules', name));
  return { directory, version: JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).version,
    ...hashFileTree(directory) };
}

/** Одинаковые фазы: входы до build и фактический runtime после ОБЕИХ сборок.
 * pnpm может переписать абсолютные bin-shims общего node_modules при relocation.
 * Промежуточные snapshots сохраняются, но не смешиваются с settled-фазой. */
export function prepareSurfaceCheckouts(roots, {
  prepare = root => prepareBenchmarkCheckout({ root, benchDirectory: root, requireClean: true,
    requiredDist: ['dist/compiler/vite/index.js'], requiredRootPackages: ['typescript', 'esbuild', 'pako', 'tsup'] }),
  capture = root => Object.fromEntries(['terser', 'typescript', 'esbuild', 'pako', 'tsup']
    .map(name => [name, installedTool(root, name)])),
  record = () => {},
} = {}) {
  const state = { prepared: {}, beforeBuild: {}, afterBuild: {}, tools: {} };
  const same = (left, right, phase) => {
    assert.deepEqual(Object.keys(right).sort(), Object.keys(left).sort(), `surface bench: инструменты ${phase}`);
    for (const name of Object.keys(left)) {
      for (const field of ['version', 'files', 'sha256']) {
        assert.equal(left[name][field], right[name][field], `surface bench: ${name} ${field} ${phase}`);
      }
    }
  };
  try {
    for (const [side, root] of Object.entries(roots)) {
      if (!root) continue;
      state.beforeBuild[side] = capture(root);
      record({ phase: `before-${side}-build`, ...state });
      if (side === 'candidate') same(state.beforeBuild.base, state.beforeBuild.candidate, 'до build');
      state.prepared[side] = prepare(root);
      state.afterBuild[side] = capture(root);
      record({ phase: `after-${side}-build`, ...state });
    }
    for (const [side, root] of Object.entries(roots)) if (root) state.tools[side] = capture(root);
    record({ phase: 'settled', ...state });
    if (roots.candidate) same(state.tools.base, state.tools.candidate, 'после обеих сборок');
    return state;
  } catch (error) {
    record({ phase: 'INVALID', reason: String(error?.message ?? error), ...state });
    throw error;
  }
}

async function execute(options) {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'surface bench: требуется Node 24');
  assert.equal(process.execArgv.length, 0, 'surface bench: runtime flags не допускаются');
  assert(!process.env.NODE_OPTIONS, 'surface bench: NODE_OPTIONS меняет измеряемый runtime');
  mkdirSync(options.out, { recursive: false }); // Нельзя затереть плохой run новым.
  const journal = path.join(options.out, 'raw.jsonl');
  const write = (file, value) => writeFileSync(path.join(options.out, file), JSON.stringify(value, null, 2));
  const roots = { base: realpathSync(options.base), candidate: options.calibrateOnly ? null : realpathSync(options.candidate) };
  const harnessState = readCheckoutState(ROOT);
  assert(!harnessState.dirty, 'surface bench: harness checkout должен быть clean');
  const trackedInputs = [SCRIPT, path.join(ROOT, 'scripts/bench-surface-support.mjs'),
    path.join(ROOT, 'bench/compare/methodology.mjs'), path.join(ROOT, 'bench/compare/provenance.mjs')];
  const harnessHashes = Object.fromEntries(trackedInputs.map(f => [f, { path: f, sha256: sha256File(f) }]));
  if (roots.candidate) {
    assert.equal(sha256File(path.join(roots.base, 'pnpm-lock.yaml')), sha256File(path.join(roots.candidate, 'pnpm-lock.yaml')),
      'surface bench: разные toolchain lock, нужен отдельный эксперимент');
  }
  const { prepared, beforeBuild, afterBuild, tools } = prepareSurfaceCheckouts(roots, {
    record: snapshot => write('provisioning.json', snapshot),
  });
  const require = createRequire(path.join(roots.base, 'package.json'));
  const ts = require('typescript');
  const probes = {};
  for (const [side, root] of Object.entries(roots)) {
    if (!root) continue;
    const source = readFileSync(path.join(root, 'dist/compiler/vite/index.js'), 'utf8');
    probes[side] = path.join(options.out, `${side}-probe.mjs`);
    writeFileSync(probes[side], surfaceProbeSource(source, ts));
  }
  probes.equal = path.join(options.out, 'equal-probe.mjs');
  writeFileSync(probes.equal, readFileSync(probes.base));
  const acorn = parserFor(roots.base);
  const manifest = { schema: 1, calibrateOnly: options.calibrateOnly === true, harnessState, policy: SURFACE_PAIR_POLICY, roots, prepared, tools, buildTools: { beforeBuild, afterBuild }, probes,
    nodeExecutable: sha256File(process.execPath), versions: process.versions,
    cpu: os.cpus()[0]?.model, platform: process.platform, arch: process.arch, kernel: os.release(),
    acorn: { module: acorn.module, packageDirectory: acorn.packageDirectory,
      packageTree: hashFileTree(acorn.packageDirectory), sha256: sha256File(acorn.module) }, harnessHashes,
    probeHashes: Object.fromEntries(Object.values(probes).map(f => [f, { path: f, sha256: sha256File(f) }])),
    profiles: surfaceProfiles(), phases: { warm: 'same-call-site-128-bursts', miss: '512-input-cycle; JIT warm; not application startup' } };
  const manifestFile = path.join(options.out, 'manifest.json');
  write('manifest.json', manifest);
  appendFileSync(journal, JSON.stringify({ type: 'manifest', sha256: sha256File(manifestFile) }) + '\n');
  const profiles = surfaceProfiles();
  const rows = [];
  let verdict = { status: 'UNPROVEN', reason: 'run не завершён' };
  async function compare(profile, comparison) {
    const records = [];
    for (let cluster = 0; cluster < SURFACE_PAIR_POLICY.clusters; cluster++) {
      const input = { manifest: manifestFile, profile: profile.id, comparison, cluster };
      const child = spawnSync(process.execPath, [SCRIPT, '_worker', JSON.stringify(input)], {
        encoding: 'utf8', timeout: SURFACE_PAIR_POLICY.workerTimeoutMs, maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(child.status, 0, `surface bench worker: ${child.error?.message ?? ''}\n${child.stderr}\n${child.stdout}`);
      const record = JSON.parse(child.stdout);
      assert.equal(record.cluster, cluster);
      assert.equal(record.profile, profile.id);
      records.push(record);
      appendFileSync(journal, JSON.stringify({ type: 'cluster', comparison, ...record }) + '\n');
    }
    const stats = summarizeSurfacePair(records, profile, comparison === 'double' ? [1, 2] : [1, 1]);
    const row = { profile: profile.id, comparison, stats };
    rows.push(row);
    write('summary.json', rows);
    console.log(JSON.stringify(row));
    return stats;
  }
  try {
    // Полное равенство публичного результата, а не только checksum/числа узлов.
    // Неподходящий source не превращается в быстрый no-op ни у одного участника.
    if (roots.candidate) {
      const base = await import(pathToFileURL(probes.base));
      const candidate = await import(pathToFileURL(probes.candidate));
      let checked = 0;
      const context = { parse: code => acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' }),
        warn(message) { throw new Error(`surface bench: ${message}`); } };
      const baseCompiler = base.motionCompiler();
      const candidateCompiler = candidate.motionCompiler();
      for (const profile of profiles.filter(p => p.mode === 'consume')) {
        for (const code of surfaceInputs(profile)) {
          const left = baseCompiler.transform.call(context, code, 'consumer.js');
          const right = candidateCompiler.transform.call(context, code, 'consumer.js');
          assert.equal(left !== undefined, profile.lowered);
          assert.deepEqual(right, left, 'surface bench: code/map не совпадают');
          checked++;
        }
      }
      write('semantics.json', { checked, equal: true });
    }
    const calibrationIds = SURFACE_CALIBRATION_IDS;
    const equalities = [];
    for (const id of calibrationIds) equalities.push(await compare(profiles.find(p => p.id === id), 'AA'));
    const positive = await compare(profiles.find(p => p.id === calibrationIds[0]), 'double');
    const calibrated = surfaceCalibrationAdmitted(equalities, positive);
    write('calibration.json', { calibrated, ids: calibrationIds, equalities, positive });
    if (calibrated && !options.calibrateOnly) {
      for (const profile of profiles) await compare(profile, 'candidate');
    }
    verdict = surfaceVerdict(rows, calibrated, options.calibrateOnly === true);
  } catch (error) {
    verdict = { status: 'INVALID', reason: String(error?.message ?? error) };
    throw error;
  } finally {
    for (const [side, root] of Object.entries(roots)) if (root) {
      assertCheckoutUnchanged(root, prepared[side]);
      assertInstalledPackageTreesUnchanged(root, Object.fromEntries(Object.entries(tools[side]).map(([name, value]) => [name, value])));
    }
    assert.deepEqual(readCheckoutState(ROOT), harnessState, 'surface bench: harness изменился');
    assertFileHashesUnchanged(harnessHashes);
    assertFileHashesUnchanged(manifest.probeHashes);
    assert.equal(sha256File(acorn.module), manifest.acorn.sha256);
    assert.deepEqual(hashFileTree(acorn.packageDirectory), manifest.acorn.packageTree);
    write('verdict.json', verdict);
    appendFileSync(journal, JSON.stringify({ type: 'end', verdict, completedComparisons: rows.length }) + '\n');
    write('raw.sha256.json', { sha256: sha256File(journal) });
  }
  if (verdict.status === 'UNPROVEN') process.exitCode = 2;
}

/** Пересчитывает вывод из полных raw-кластеров, не доверяя summary/verdict. */
export function replaySurfaceReport(directory) {
  const load = name => JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = load('manifest.json');
  assert.equal(manifest.schema, 1);
  assert.deepEqual(manifest.policy, SURFACE_PAIR_POLICY);
  assert.deepEqual(manifest.profiles, surfaceProfiles());
  assert.equal(typeof manifest.calibrateOnly, 'boolean');
  const journal = path.join(directory, 'raw.jsonl');
  assert.equal(sha256File(journal), load('raw.sha256.json').sha256);
  const records = readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records[0], { type: 'manifest', sha256: sha256File(manifestPath) });
  assert.equal(records.at(-1)?.type, 'end', 'surface bench: незавершённый raw journal');
  const rows = [];
  let cursor = 1;
  function group(id, comparison) {
    const profile = surfaceProfiles().find(p => p.id === id);
    const group = records.slice(cursor, cursor + SURFACE_PAIR_POLICY.clusters);
    assert(group.every(r => r.type === 'cluster' && r.comparison === comparison));
    const stats = summarizeSurfacePair(group, profile, comparison === 'double' ? [1, 2] : [1, 1]);
    rows.push({ profile: id, comparison, stats });
    cursor += SURFACE_PAIR_POLICY.clusters;
    return stats;
  }
  const equalities = SURFACE_CALIBRATION_IDS.map(id => group(id, 'AA'));
  const positive = group(SURFACE_CALIBRATION_IDS[0], 'double');
  const calibrated = surfaceCalibrationAdmitted(equalities, positive);
  if (calibrated && !manifest.calibrateOnly) {
    for (const profile of surfaceProfiles()) group(profile.id, 'candidate');
  }
  assert.equal(cursor, records.length - 1, 'surface bench: лишние либо недостающие observations');
  const verdict = surfaceVerdict(rows, calibrated, manifest.calibrateOnly);
  assert.deepEqual(load('summary.json'), rows, 'surface bench: summary расходится с raw');
  assert.deepEqual(load('verdict.json'), verdict, 'surface bench: verdict расходится с raw');
  assert.deepEqual(records.at(-1), { type: 'end', verdict, completedComparisons: rows.length });
  return verdict;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  if (process.argv[2] === '_worker') await worker(JSON.parse(process.argv[3]));
  else if (process.argv[2] === '--verify') {
    assert.equal(process.argv.length, 4, 'Использование: --verify REPORT_DIRECTORY');
    console.log(JSON.stringify(replaySurfaceReport(path.resolve(process.argv[3])), null, 2));
  } else await execute(parseSurfaceBenchArgs(process.argv.slice(2)));
}
