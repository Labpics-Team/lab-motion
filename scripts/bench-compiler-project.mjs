/** Сравнивает доставляемую сборку и подготовку модулей на одинаковом проекте. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { build, parseAstAsync } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [baselineArg, outputArg] = process.argv.slice(2);
assert.ok(baselineArg && outputArg, 'node scripts/bench-compiler-project.mjs BASELINE_PACKAGE OUTPUT.json');
assert.equal(typeof process.threadCpuUsage, 'function', 'Нужен Node с process.threadCpuUsage');
const baseline = resolve(baselineArg), output = resolve(outputArg);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function identity(path) {
  const files = ['package.json', 'dist/compiler/vite/index.js', 'dist/animate/index.js',
    'dist/nano/index.js', 'dist/compiler/runtime/index.js', 'dist/compiler/surface/index.js'];
  return Object.fromEntries(files.map(file => [file, digest(readFileSync(join(path, file)))]));
}
const identityBefore = { baseline: identity(baseline), candidate: identity(root) };
const factories = await Promise.all([baseline, root].map(async directory =>
  (await import(pathToFileURL(join(directory, 'dist/compiler/vite/index.js')).href)).motionCompiler));
const doc = readFileSync(join(root, 'docs/compiler.md'), 'utf8');
const source = /<!-- compiler-project-recipe -->\s*```typescript\n([^]*?)\n```/.exec(doc)?.[1];
assert.ok(source, 'Нет исполняемого примера проекта в документации');
const profile = Object.freeze({ modules: 64, definitions: [4, 64], pairs: 24, warmupPairs: 4,
  metric: 'полный transform: parse + plan + артефакт + source map + buildEnd',
  includes: 'каждая обработка начинается с нового экземпляра плагина',
  size: 'сумма gzip всех достижимых JS/CSS/data chunks, maps исключены' });
const work = mkdtempSync(join(tmpdir(), 'motion-project-'));
const report = { profile, node: process.version, v8: process.versions.v8, cpu: cpus()[0]?.model,
  identity: identityBefore, sourceSha256: digest(source), bundles: {}, transforms: [] };

async function consumer(directory, factory) {
  const entry = join(work, 'entry.ts'); writeFileSync(entry, source);
  const aliases = Object.fromEntries(['animate', 'nano', 'compiler/runtime', 'compiler/surface']
    .map(name => ['@labpics/motion/' + name, join(directory, 'dist', name, 'index.js')]));
  const result = await build({ root: work, configFile: false, logLevel: 'silent',
    plugins: [factory()], resolve: { alias: aliases },
    build: { write: false, target: 'es2022', minify: true, lib: { entry, formats: ['es'], fileName: 'project' } } });
  const generated = (Array.isArray(result) ? result[0] : result).output;
  const modules = [...new Set(generated.flatMap(item => item.type === 'chunk' ? Object.keys(item.modules) : []))];
  const files = generated.filter(item => !item.fileName.endsWith('.map')).map(item => {
    const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
    return { name: item.fileName, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: digest(bytes) };
  });
  const modulePrefix = join(directory, 'dist').replaceAll('\\', '/') + '/';
  return { files, gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    modules: modules.map(id => id.replaceAll('\\', '/')).filter(id => id.startsWith(modulePrefix)).map(id => id.slice(modulePrefix.length)) };
}
function moduleSource(index, definitions) {
  const width = 300 + (index % definitions) * 2;
  return `import { animate } from '@labpics/motion/animate';
export function open${index}(panel${index}) { animate(panel${index}, { width: [240, ${width}] }, { layout: 'project' }); }`;
}
async function transformProject(factory, definitions) {
  const compiler = factory(); let bytes = 0, mappings = 0;
  const cpu = process.threadCpuUsage(), clock = performance.now();
  for (let i = 0; i < profile.modules; i++) {
    const code = moduleSource(i, definitions), ast = await parseAstAsync(code);
    const result = compiler.transform.call({ parse: () => ast, warn(message) { throw new Error(message); } }, code, `/app/component-${i}.js`);
    assert.ok(result?.code.includes('__labMotionSurface('));
    bytes += result.code.length; mappings += result.map.mappings.length;
  }
  compiler.buildEnd?.();
  const used = process.threadCpuUsage(cpu);
  return { cpuUs: used.user + used.system, elapsedMs: performance.now() - clock, bytes, mappings, completed: profile.modules };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  report.bundles.baseline = await consumer(baseline, factories[0]);
  report.bundles.candidate = await consumer(root, factories[1]);
  assert.ok(report.bundles.baseline.modules.includes('animate/index.js'));
  assert.ok(report.bundles.baseline.modules.includes('nano/index.js'));
  assert.deepEqual([...report.bundles.candidate.modules].sort(), ['compiler/runtime/index.js', 'compiler/surface/index.js']);
  for (const definitions of profile.definitions) {
    // Полные планы обоих вариантов обязаны совпасть до измерения ускорения.
    const instances = factories.map(factory => factory());
    for (let i = 0; i < profile.modules; i++) {
      const code = moduleSource(i, definitions), ast = await parseAstAsync(code);
      const results = instances.map(compiler => compiler.transform.call({ parse: () => ast, warn(message) { throw new Error(message); } }, code, `/app/component-${i}.js`));
      assert.deepEqual(results[1], results[0]);
    }
    for (const compiler of instances) compiler.buildEnd?.();
    for (const control of ['AA', 'AB']) {
      const participants = [factories[0], control === 'AA' ? factories[0] : factories[1]];
      const pairs = [];
      for (let n = -profile.warmupPairs; n < profile.pairs; n++) {
        const results = [];
        for (const index of n % 2 ? [1, 0] : [0, 1]) results[index] = await transformProject(participants[index], definitions);
        assert.equal(results[0].bytes, results[1].bytes); assert.equal(results[0].mappings, results[1].mappings);
        if (n >= 0) pairs.push({ order: n % 2 ? 'candidate-base' : 'base-candidate', base: results[0], candidate: results[1] });
      }
      const cell = { definitions, control, baselineCpuUs: median(pairs.map(p => p.base.cpuUs)),
        candidateCpuUs: median(pairs.map(p => p.candidate.cpuUs)),
        cpuRatio: median(pairs.map(p => p.candidate.cpuUs / p.base.cpuUs)),
        wallRatio: median(pairs.map(p => p.candidate.elapsedMs / p.base.elapsedMs)), pairs };
      report.transforms.push(cell); console.log(JSON.stringify({ ...cell, pairs: undefined }));
    }
  }
  assert.deepEqual({ baseline: identity(baseline), candidate: identity(root) }, identityBefore);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally {
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ bundles: report.bundles, status: report.status }));
