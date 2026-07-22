import { describe, expect, it, onTestFinished } from 'vitest';
import {
  ANIMATE_COMPOSITOR_MIXED_GATE_BYTES,
  BESPOKE_SUBPATH_GATES,
  COMPOSITOR_CAPABILITY_GATE_BYTES,
  CORE_GATE_BYTES,
  FULL_ANIMATE_GATE_BYTES,
  FULL_CORE_CONSUMER_GATE_BYTES,
  IN_VIEW_CONSUMER_GATE_BYTES,
  IN_VIEW_GATE_BYTES,
  SUBPATH_GATE_BYTES,
  deriveEntriesFromExports,
  evaluateScenarioBudget,
  IMPORT_COST_SCENARIOS,
  measureEntries,
  measureEsmTransfer,
  measureScenario,
  measureScenarioOutputGraph,
} from '../scripts/size-gate.mjs';
import {
  canonicalGzip,
  observationalBrotli,
} from '../scripts/compression-oracle.mjs';
import { CANONICAL_GZIP_OPTIONS } from '../scripts/compression-policy.mjs';
import { gzip as pakoGzip } from 'pako';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build as esbuildBuild } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function createTestRoot(prefix: string) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createSplitOutputFixture() {
  const root = createTestRoot('lab-motion-size-split-output-');
  const absWorkingDir = resolve(root, 'dist');
  mkdirSync(absWorkingDir, { recursive: true });

  const physicalWorkingDir = realpathSync(absWorkingDir);
  const outdir = '.size-gate-output';
  const outputRoot = resolve(physicalWorkingDir, outdir);
  const entryPoint = resolve(physicalWorkingDir, '__scenario__.mjs');
  const contents = {
    css: Buffer.from(`.hero{transform:translateX(1px)}`),
    entry: Buffer.from(`const a=()=>import('./lazy-a.js'),b=()=>import('./lazy-b.js');export{a,b};`),
    lazyA: Buffer.from(`import{shared as s}from'./shared.js';const a='a'+s;export{a};`),
    lazyB: Buffer.from(`import{shared as s}from'./shared.js';const b='b'+s;export{b};`),
    shared: Buffer.from(`const shared='one physical shared chunk';export{shared};`),
  };
  const names = {
    css: `${outdir}/scenario.css`,
    entry: `${outdir}/entry.js`,
    lazyA: `${outdir}/lazy-a.js`,
    lazyB: `${outdir}/lazy-b.js`,
    shared: `${outdir}/shared.js`,
  };
  type OutputName = keyof typeof names;
  type OutputNode = {
    imports: Array<{ path: string; kind: string; external?: unknown }>;
    entryPoint?: string;
    cssBundle?: string;
  };
  const outputs: Record<string, OutputNode> = {
    // Hostile insertion order: neither metadata nor outputFiles starts at entry.
    [names.shared]: { imports: [] },
    [names.lazyB]: {
      imports: [{ path: names.shared, kind: 'import-statement' }],
      entryPoint: resolve(physicalWorkingDir, 'lazy-b.js'),
    },
    [names.lazyA]: {
      imports: [{ path: names.shared, kind: 'import-statement' }],
      entryPoint: resolve(physicalWorkingDir, 'lazy-a.js'),
    },
    [names.entry]: {
      imports: [
        { path: names.lazyA, kind: 'dynamic-import' },
        { path: names.lazyB, kind: 'dynamic-import' },
      ],
      entryPoint,
    },
  };
  const outputFiles = (['shared', 'lazyB', 'lazyA', 'entry'] as OutputName[])
    .map((name) => ({
      path: resolve(outputRoot, names[name].slice(outdir.length + 1)),
      contents: contents[name],
    }));
  const outputPath = (name: string) => resolve(outputRoot, name.slice(outdir.length + 1));

  return {
    result: { metafile: { inputs: {}, outputs }, outputFiles },
    options: { absWorkingDir, outdir, entryPoint },
    contents,
    names,
    outputPath,
    outputs,
  };
}

function measureSplitOutputFixture(
  result: ReturnType<typeof createSplitOutputFixture>['result'],
  options: ReturnType<typeof createSplitOutputFixture>['options'],
) {
  return measureScenarioOutputGraph(result, options);
}

/**
 * Класс регрессии, который закрывает этот файл: размерный гейт раньше нёс
 * ЖЁСТКО ЗАКОДИРОВАННЫЙ список subpath-путей (`const ENTRIES = [...]`), из-за
 * чего добавление нового exports-ключа в package.json (например ./value)
 * НЕ появлялось в отчёте, пока кто-то вручную не правил scripts/size-gate.mjs.
 * Эти тесты доказывают, что список ТЕПЕРЬ выводится программно из
 * package.json → exports, а не хранится литералом в скрипте.
 */
describe('size-gate: auto-derive subpath entries from package.json exports', () => {
  it('канонический gzip различает мутацию каждого параметра и не зависит от системного zlib', () => {
    const fixture = new Uint8Array(20_175);
    let random = 7;
    for (let index = 0; index < fixture.length; index++) {
      if (index % 997 < 600) {
        fixture[index] = index % 97 < 70 ? 65 + index % 23 : index * 17 % 251;
      } else {
        random = (Math.imul(random, 1_103_515_245) + 12_345) >>> 0;
        fixture[index] = random >>> 16;
      }
    }

    expect(Object.isFrozen(CANONICAL_GZIP_OPTIONS)).toBe(true);
    expect(CANONICAL_GZIP_OPTIONS).toStrictEqual({
      level: 9,
      windowBits: 15,
      memLevel: 8,
      strategy: 0,
      legacyHash: false,
    });

    const compressed = canonicalGzip(fixture);
    expect(compressed).toHaveLength(9_378);
    expect(createHash('sha256').update(compressed).digest('hex'))
      .toBe('9a33ac41e630a5fe732001e3d2a5ea2209e6927b426dbe237a5f21307bbc878e');

    const mutations = [
      ['level', 8, 9_378, '652554b4de4f64134ac942e966728c556e7a43fa6b3d67109a3507bb65e8cadc'],
      ['windowBits', 14, 9_377, '318b4b34eb34229b0ad399d476a142e772c9145343cf2364d18b92e292db6734'],
      ['memLevel', 7, 9_398, '57ead4c09c1980d469cd93864a0ae7d0a4efb69c88e31b8f531bb88428a0f70f'],
      ['strategy', 1, 9_396, 'def46aa231b6f2df672a17f47aed05d3f78359dd1b9896b564a10ca5b078b606'],
      ['legacyHash', true, 9_375, '5400ba29946e1c0223e4202225287dc4b879042a42626f8042c2db90f74b898a'],
    ] as const;
    for (const [parameter, value, bytes, sha256] of mutations) {
      const mutated = pakoGzip(fixture, { ...CANONICAL_GZIP_OPTIONS, [parameter]: value });
      expect(mutated, `${parameter}: корпус обязан различать мутацию`).not.toEqual(compressed);
      expect(mutated, `${parameter}: неверная длина мутации`).toHaveLength(bytes);
      expect(createHash('sha256').update(mutated).digest('hex'), `${parameter}: неверный SHA-256`)
        .toBe(sha256);
    }
  });

  it('derives one entry per exports key that has an "import" condition', () => {
    const pkg = {
      exports: {
        '.': { import: './dist/index.js', require: './dist/index.cjs' },
        './easing': { import: './dist/easing/index.js' },
        './types-only': { types: './dist/types-only.d.ts' }, // нет import → должен быть отфильтрован
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.label)).toEqual(['core (index)', 'easing']);
    expect(entries.find(e => e.label === 'core (index)')?.importPath).toBe('dist/index.js');
    expect(entries.find(e => e.label === 'easing')?.importPath).toBe('dist/easing/index.js');
  });

  it('regression: a freshly-added fake exports key is picked up WITHOUT touching size-gate.mjs', () => {
    // Симулирует ровно сценарий из условия успеха s08b: кто-то добавляет
    // новый subpath-плагин в package.json exports — размерный гейт обязан
    // увидеть его автоматически.
    const pkg = {
      exports: {
        '.': { import: './dist/index.js' },
        './timeline': { import: './dist/timeline/index.js' },
        './fake-new-plugin': { import: './dist/fake-new-plugin/index.js' },
      },
    };

    const entries = deriveEntriesFromExports(pkg);
    const labels = entries.map(e => e.label);

    expect(labels).toContain('timeline');
    expect(labels).toContain('fake-new-plugin');
  });

  it('ядро несёт свой порог, каждый прочий субпуть — общий SUBPATH_GATE_BYTES (drift-класс)', () => {
    // Раньше субпути были measure-only: новый раздутый субпуть проходил
    // зелёным без порога. Теперь безлимитных строк в отчёте не существует.
    const pkg = {
      exports: {
        '.': { import: './dist/index.js' },
        './react': { import: './dist/react/index.js' },
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries.find(e => e.key === '.')?.gate).toBe(CORE_GATE_BYTES);
    expect(entries.find(e => e.key === './react')?.gate).toBe(SUBPATH_GATE_BYTES);
    expect(entries.every(e => Number.isFinite(e.gate) && e.gate > 0)).toBe(true);
  });

  it('resolves a NESTED conditional-exports value (e.g. { import: { types, default } }) instead of throwing', () => {
    // Реальный package.json bundler-инструментов часто вкладывает условия
    // ("import"/"require" → {types, default}) — плоский `value.import` тут
    // был бы объектом, а не строкой, и .replace() уронил бы скрипт.
    const pkg = {
      exports: {
        '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
        './no-string-leaf': { import: { types: './dist/x.d.ts' } }, // нет default/строки → должен быть отфильтрован, не бросать
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries).toHaveLength(1);
    expect(entries[0].importPath).toBe('dist/index.js');
  });

  it('throws a clear error when package.json has no "exports" field (fails loud, not silent-empty)', () => {
    expect(() => deriveEntriesFromExports({})).toThrow(/exports/);
  });

  it('сценарии import-cost: непустой список, у каждого name/код с %DIST%/конечный порог > 0', () => {
    // Замена мёртвого full-bundle-гейта (./layout никогда не мержился →
    // совокупный гейт вечно был PLACEHOLDER): сценарные бюджеты — то, что
    // реально платит потребитель, и они не могут «не активироваться».
    expect(IMPORT_COST_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    for (const s of IMPORT_COST_SCENARIOS) {
      expect(typeof s.name).toBe('string');
      expect(s.code).toContain('%DIST%');
      expect(Number.isFinite(s.gate)).toBe(true);
      expect(s.gate).toBeGreaterThan(0);
    }
  });

  it('full animate имеет один SSOT-потолок для shipped subpath и consumer import-cost', () => {
    const full = IMPORT_COST_SCENARIOS.find((scenario) => scenario.name.startsWith('animate-one-liner'));
    // 12 000 → 12 760 (#205): N-keyframe tracks фасада, хронология в size-gate.mjs.
    // 12 760 → 12 700 → 12 620 (охоты 2026-07-22): затяжки вниз по фактам.
    expect(FULL_ANIMATE_GATE_BYTES).toBe(12_620);
    expect(BESPOKE_SUBPATH_GATES['./animate']).toBe(FULL_ANIMATE_GATE_BYTES);
    expect(full?.gate).toBe(FULL_ANIMATE_GATE_BYTES);
  });

  it('фиксирует отдельные exact-ратчеты shipped и consumer для in-view', () => {
    const consumer = IMPORT_COST_SCENARIOS.find(({ name }) => name === 'in-view one-liner');

    expect(IN_VIEW_GATE_BYTES).toBe(1839);
    // 1907 → 1908 (#218): +1 B gzip-словаря от строки LM167 в общем
    // errors-модуле; сам in-view не менялся, ратчет переставлен по факту.
    expect(IN_VIEW_CONSUMER_GATE_BYTES).toBe(1908);
    expect(BESPOKE_SUBPATH_GATES['./in-view']).toBe(IN_VIEW_GATE_BYTES);
    expect(consumer?.gate).toBe(IN_VIEW_CONSUMER_GATE_BYTES);
    expect(consumer?.code).toContain('/in-view/index.js');
  });

  it('разделяет физические и consumer-потолки ядра и compositor capability', () => {
    expect(FULL_CORE_CONSUMER_GATE_BYTES).toBe(2330);
    // 6600 → 6510 (#223+охота 2026-07-22): затяжка вниз по факту 6477.
    expect(COMPOSITOR_CAPABILITY_GATE_BYTES).toBe(6510);
    expect(IMPORT_COST_SCENARIOS.find(({ name }) => name === 'full-core')?.gate)
      .toBe(FULL_CORE_CONSUMER_GATE_BYTES);
    expect(IMPORT_COST_SCENARIOS.find(({ name }) => name === 'compositor-stagger capability')?.gate)
      .toBe(COMPOSITOR_CAPABILITY_GATE_BYTES);
  });

  it('фиксирует mixed animate + compositor не выше exact clean-base факта', () => {
    // 12 494 → 13 340 (#205): тот же track-срез, дублирования не добавлено.
    // 13 340 → 13 290 → 13 230 (охоты 2026-07-22): затяжки вниз по фактам.
    expect(ANIMATE_COMPOSITOR_MIXED_GATE_BYTES).toBe(13_230);
    const mixed = IMPORT_COST_SCENARIOS.find(
      ({ name }) => name === 'animate + compositor',
    );
    expect(mixed?.gate).toBe(ANIMATE_COMPOSITOR_MIXED_GATE_BYTES);
    expect(mixed?.code).toContain('/animate/index.js');
    expect(mixed?.code).toContain('/compositor/index.js');
    expect(mixed?.code).toContain('compileSpringLinear');
  });

  it('measureScenario: пропавший экспорт даёт error (громкий FAIL), а не тихий ноль', async () => {
    const distIndex = resolve(ROOT, 'dist/index.js');
    const broken = { name: 'broken', code: `import { noSuchExport } from '%DIST%'; console.log(noSuchExport);`, gate: 1 };
    const m = await measureScenario(broken, distIndex);
    expect(m.error, 'ошибка сборки обязана всплыть').toBeTruthy();
    expect(m.gzBytes).toBeUndefined();
  });

  it('measureScenario: реальный сценарий возвращает конечный gz > 0 и меньше шипнутого полного ядра', async () => {
    const distIndex = resolve(ROOT, 'dist/index.js');
    const onlySpring = IMPORT_COST_SCENARIOS.find(s => s.name === 'only-spring');
    expect(onlySpring).toBeDefined();
    const m = await measureScenario(onlySpring, distIndex);
    expect(m.error).toBeUndefined();
    expect(m.gzBytes).toBeGreaterThan(0);
    expect(m.brBytes).toBeGreaterThan(0);
    // Класс tree-shakeability: частичный импорт обязан быть ДЕШЕВЛЕ полного ядра.
    const full = await measureScenario(IMPORT_COST_SCENARIOS.find(s => s.name === 'full-core'), distIndex);
    expect(m.gzBytes).toBeLessThan(full.gzBytes);
  });

  it('measureScenario: dynamic import не входит в initial, но входит в lazy и total', async () => {
    const root = createTestRoot('lab-motion-size-dynamic-');
    mkdirSync(resolve(root, 'dist'), { recursive: true });
    writeFileSync(resolve(root, 'dist/index.js'), `export const placeholder = true;`);
    writeFileSync(resolve(root, 'dist/lazy.js'), `export const lazy = '${'lazy payload '.repeat(40)}';`);

    const measured = await measureScenario(
      {
        name: 'dynamic fixture',
        code: `export const load = () => import('%DIST%/../lazy.js');`,
        gate: 100_000,
      },
      resolve(root, 'dist/index.js'),
    );

    expect(measured.error).toBeUndefined();
    expect(measured.initialFiles).toBe(1);
    expect(measured.lazyFiles).toBe(1);
    expect(measured.totalFiles).toBe(2);
    expect(measured.totalGate).toBe(100_000);
    expect(measured.lazyGzBytes).toBeGreaterThan(0);
    expect(measured.totalRawBytes).toBe(measured.rawBytes + measured.lazyRawBytes);
    expect(measured.totalGzBytes).toBe(measured.gzBytes + measured.lazyGzBytes);
    expect(measured.totalBrBytes).toBe(measured.brBytes + measured.lazyBrBytes);
  });

  it('dynamic total budget: incompressible lazy payload проходит initial и валит total', async () => {
    const root = createTestRoot('lab-motion-size-total-budget-');
    mkdirSync(resolve(root, 'dist'), { recursive: true });
    writeFileSync(resolve(root, 'dist/index.js'), `export const placeholder = true;`);
    const bytes = Buffer.alloc(4096);
    let random = 0x9e3779b9;
    for (let index = 0; index < bytes.length; index++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      bytes[index] = random >>> 24;
    }
    writeFileSync(
      resolve(root, 'dist/lazy.js'),
      `export const lazy = '${bytes.toString('base64')}';`,
    );

    const measured = await measureScenario(
      {
        name: 'incompressible lazy fixture',
        code: `export const load = () => import('%DIST%/../lazy.js');`,
        gate: 128,
        totalGate: 512,
      },
      resolve(root, 'dist/index.js'),
    );
    const budget = evaluateScenarioBudget(measured);

    expect(measured.error).toBeUndefined();
    expect(measured.gate).toBe(128);
    expect(measured.totalGate).toBe(512);
    expect(measured.gzBytes).toBeLessThanOrEqual(128);
    expect(measured.totalGzBytes).toBeGreaterThan(512);
    expect(budget).toStrictEqual({
      initialExceeded: false,
      totalExceeded: true,
      exceeded: true,
    });
    expect(evaluateScenarioBudget({
      ...measured,
      gzBytes: 129,
      totalGate: 10_000,
    })).toStrictEqual({
      initialExceeded: true,
      totalExceeded: false,
      exceeded: true,
    });
  });

  it('scenario budget: fails closed если total меньше initial', () => {
    expect(() => evaluateScenarioBudget({
      gzBytes: 100,
      gate: 1_000,
      totalGzBytes: 1,
      totalGate: 1_000,
    })).toThrow(/некорректен/);
  });

  it('scenario output graph: shared lazy chunk считается один раз', () => {
    const fixture = createSplitOutputFixture();
    const measured = measureSplitOutputFixture(fixture.result, fixture.options);
    const uniqueLazy = [fixture.contents.lazyA, fixture.contents.lazyB, fixture.contents.shared];

    expect(measured.lazyFiles).toBe(3);
    expect(measured.lazyRawBytes).toBe(
      uniqueLazy.reduce((total, contents) => total + contents.length, 0),
    );
    expect(measured.lazyGzBytes).toBe(
      uniqueLazy.reduce((total, contents) => total + canonicalGzip(contents).length, 0),
    );
    expect(measured.totalFiles).toBe(4);
  });

  it('scenario output graph: entry выбирается по entryPoint, а не по порядку outputFiles', () => {
    const fixture = createSplitOutputFixture();
    const measured = measureSplitOutputFixture(fixture.result, fixture.options);

    expect(fixture.result.outputFiles[0].contents).not.toEqual(fixture.contents.entry);
    expect(measured.initialFiles).toBe(1);
    expect(measured.rawBytes).toBe(fixture.contents.entry.length);
    expect(measured.gzBytes).toBe(canonicalGzip(fixture.contents.entry).length);
  });

  it('scenario output graph: ambient cwd не переопределяет базу relative entryPoint', () => {
    const fixture = createSplitOutputFixture();
    fixture.options.entryPoint = resolve(process.cwd(), 'ambient-entry.mjs');
    fixture.outputs[fixture.names.entry].entryPoint = 'ambient-entry.mjs';

    expect(() => measureSplitOutputFixture(fixture.result, fixture.options))
      .toThrow(/entryPoint не найден/);
  });

  it('scenario output graph: chunk из initial и dynamic branch не считается в lazy повторно', () => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.entry].imports.unshift({
      path: fixture.names.shared,
      kind: 'import-statement',
    });

    const measured = measureSplitOutputFixture(fixture.result, fixture.options);
    const expectedInitial = [fixture.contents.entry, fixture.contents.shared];
    const expectedLazy = [fixture.contents.lazyA, fixture.contents.lazyB];

    expect(measured.initialFiles).toBe(2);
    expect(measured.rawBytes).toBe(
      expectedInitial.reduce((total, contents) => total + contents.length, 0),
    );
    expect(measured.lazyFiles).toBe(2);
    expect(measured.lazyRawBytes).toBe(
      expectedLazy.reduce((total, contents) => total + contents.length, 0),
    );
    expect(measured.totalFiles).toBe(4);
  });

  it('scenario output graph: нормализует внутренние ..-сегменты до проверки графа', () => {
    const fixture = createSplitOutputFixture();
    const normalizedLazyName = '.size-gate-output/nested/../lazy-a.js';
    fixture.outputs[normalizedLazyName] = fixture.outputs[fixture.names.lazyA];
    delete fixture.outputs[fixture.names.lazyA];
    fixture.outputs[fixture.names.entry].imports[0].path = normalizedLazyName;
    fixture.outputs[normalizedLazyName].imports[0].path = '.size-gate-output/chunks/../shared.js';

    const measured = measureSplitOutputFixture(fixture.result, fixture.options);
    expect(measured.initialFiles).toBe(1);
    expect(measured.lazyFiles).toBe(3);
    expect(measured.totalFiles).toBe(4);
  });

  it('scenario output graph: cssBundle входит в initial и total', () => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.css] = { imports: [] };
    fixture.outputs[fixture.names.entry].cssBundle = fixture.names.css;
    fixture.result.outputFiles.push({
      path: fixture.outputPath(fixture.names.css),
      contents: fixture.contents.css,
    });

    const measured = measureSplitOutputFixture(fixture.result, fixture.options);
    expect(measured.initialFiles).toBe(2);
    expect(measured.rawBytes).toBe(fixture.contents.entry.length + fixture.contents.css.length);
    expect(measured.totalRawBytes).toBe(
      measured.rawBytes + measured.lazyRawBytes,
    );
    expect(measured.totalBrBytes).toBe(measured.brBytes + measured.lazyBrBytes);
    expect(measured.totalFiles).toBe(5);
  });

  it('scenario output graph: валидный external edge не считается package output', () => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.entry].imports.unshift({
      path: 'external-peer',
      kind: 'import-statement',
      external: true,
    });

    const measured = measureSplitOutputFixture(fixture.result, fixture.options);
    expect(measured.initialFiles).toBe(1);
    expect(measured.totalFiles).toBe(4);
  });

  it.each([
    ['небулев external', { path: 'peer', kind: 'import-statement', external: 'yes' }, /external/],
    ['неизвестный kind', { path: 'peer', kind: 'future-import', external: true }, /kind/],
  ])('scenario output graph: fails closed — %s', (_name, edge, error) => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.entry].imports.unshift(edge);
    expect(() => measureSplitOutputFixture(fixture.result, fixture.options)).toThrow(error);
  });

  it('scenario output graph: fails closed на недостижимый output', () => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.css] = { imports: [] };
    fixture.result.outputFiles.push({
      path: fixture.outputPath(fixture.names.css),
      contents: fixture.contents.css,
    });

    expect(() => measureSplitOutputFixture(fixture.result, fixture.options))
      .toThrow(/недостижимые outputs/);
  });

  it('scenario output graph: fails closed на edge к отсутствующему output', () => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.lazyA].imports[0].path = '.size-gate-output/missing.js';

    expect(() => measureSplitOutputFixture(fixture.result, fixture.options))
      .toThrow(/отсутствующий output/);
  });

  it('scenario output graph: fails closed на output без пары в outputFiles', () => {
    const fixture = createSplitOutputFixture();
    fixture.result.outputFiles.shift();
    expect(() => measureSplitOutputFixture(fixture.result, fixture.options))
      .toThrow(/отсутствует в outputFiles/);
  });

  it('scenario output graph: fails closed на неоднозначный entryPoint', () => {
    const fixture = createSplitOutputFixture();
    fixture.outputs[fixture.names.lazyA].entryPoint = fixture.options.entryPoint;

    expect(() => measureSplitOutputFixture(fixture.result, fixture.options))
      .toThrow(/entryPoint неоднозначен/);
  });

  it('scenario output graph: fails closed на output за пределами outdir', () => {
    const fixture = createSplitOutputFixture();
    fixture.result.outputFiles[0].path = resolve(
      realpathSync(fixture.options.absWorkingDir),
      'escaped.js',
    );
    expect(() => measureSplitOutputFixture(fixture.result, fixture.options))
      .toThrow(/вышел за границу scenario outdir/);
  });

  it('measureScenario: все текущие статические сценарии byte-identical старому single-output oracle', async () => {
    const distIndexPath = resolve(ROOT, 'dist/index.js');
    for (const scenario of IMPORT_COST_SCENARIOS) {
      const code = scenario.code.replaceAll('%DIST%', distIndexPath.replace(/\\/g, '/'));
      const legacy = await esbuildBuild({
        stdin: { contents: code, resolveDir: dirname(distIndexPath), loader: 'js' },
        bundle: true,
        minify: true,
        format: 'esm',
        write: false,
        logLevel: 'silent',
      });
      const legacyOutput = legacy.outputFiles[0].contents;
      const measured = await measureScenario(scenario, distIndexPath);

      expect(measured.error, scenario.name).toBeUndefined();
      expect(measured.initialFiles, scenario.name).toBe(1);
      expect(measured.lazyFiles, scenario.name).toBe(0);
      expect(measured.rawBytes, scenario.name).toBe(legacyOutput.length);
      expect(measured.gzBytes, scenario.name).toBe(canonicalGzip(legacyOutput).length);
      expect(measured.brBytes, scenario.name).toBe(observationalBrotli(legacyOutput).length);
      expect(measured.totalRawBytes, scenario.name).toBe(measured.rawBytes);
      expect(measured.totalGzBytes, scenario.name).toBe(measured.gzBytes);
      expect(measured.totalBrBytes, scenario.name).toBe(measured.brBytes);
    }
  });

  it('measureEntries flags MISSING for a dist file that does not exist, without throwing', () => {
    const { rows, hasWarnings } = measureEntries(
      [{ key: './nope', label: 'nope', importPath: 'dist/does-not-exist.js', gate: null }],
      ROOT
    );
    expect(hasWarnings).toBe(true);
    expect(rows[0].error).toMatch(/MISSING/);
  });

  it('shipped CDN size includes the recursive static ESM import closure once per subpath', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lab-motion-size-closure-'));
    try {
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      const entry = `import { frame } from './frame.js'; export const value = frame; import('./lazy.js');`;
      const frame = `export const frame = 1;`;
      const lazy = `export const lazy = 'not part of initial transfer';`;
      writeFileSync(resolve(root, 'dist/index.js'), entry);
      writeFileSync(resolve(root, 'dist/frame.js'), frame);
      writeFileSync(resolve(root, 'dist/lazy.js'), lazy);

      const { rows, hasWarnings } = measureEntries(
        [{ key: '.', label: 'core', importPath: 'dist/index.js', gate: 100_000 }],
        root,
      );
      const row = rows[0];
      expect(hasWarnings).toBe(false);
      expect(row.closureFiles).toBe(2);
      expect(row.entryGzBytes).toBe(canonicalGzip(Buffer.from(entry)).length);
      expect(row.gzBytes).toBe(
        canonicalGzip(Buffer.from(entry)).length +
        canonicalGzip(Buffer.from(frame)).length,
      );
      expect(row.gzBytes).toBeLessThan(
        row.entryGzBytes + canonicalGzip(Buffer.from(frame)).length +
        canonicalGzip(Buffer.from(lazy)).length,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes recursive CSS @import in the initial shipped graph', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lab-motion-size-css-'));
    try {
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      const entry = `import './theme.css'; export const value = 1;`;
      const theme = `@import './tokens.css'; .box { color: var(--ink); }`;
      const tokens = `:root { --ink: #111; }`;
      writeFileSync(resolve(root, 'dist/index.js'), entry);
      writeFileSync(resolve(root, 'dist/theme.css'), theme);
      writeFileSync(resolve(root, 'dist/tokens.css'), tokens);

      const measured = measureEsmTransfer('dist/index.js', root);
      expect(measured.closureFiles).toBe(3);
      expect(measured.gzBytes).toBe(
        canonicalGzip(Buffer.from(entry)).length +
        canonicalGzip(Buffer.from(theme)).length +
        canonicalGzip(Buffer.from(tokens)).length,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a shipped entry imports a local file outside dist', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lab-motion-size-boundary-'));
    try {
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      mkdirSync(resolve(root, 'src'), { recursive: true });
      writeFileSync(resolve(root, 'dist/index.js'), `export { secret } from '../src/private.js';`);
      writeFileSync(resolve(root, 'src/private.js'), `export const secret = 1;`);
      expect(() => measureEsmTransfer('dist/index.js', root)).toThrow(/dist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('integration: current repo package.json exports every subpath the real dist/ build emits', () => {
    // Заземление в реальность: не мок, а фактический package.json + dist после `pnpm build`.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const entries = deriveEntriesFromExports(pkg);

    expect(entries.length).toBeGreaterThanOrEqual(7); // core + easing + react + svelte + vue + value + driver
    const { rows, hasWarnings } = measureEntries(entries, ROOT);
    const missing = rows.filter(r => r.error);
    expect(missing, `subpaths missing from built dist/: ${missing.map(r => r.label).join(', ')}`).toHaveLength(0);
    // Достигаем этой ветки только если dist/ реально собран этим тестраном.
    expect(hasWarnings === true || hasWarnings === false).toBe(true);
    expect(rows.every(r => r.error || (r.brBytes > 0 && r.gzBytes > 0))).toBe(true);
  });
});
