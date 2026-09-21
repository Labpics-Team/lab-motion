import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { COMPILER_NANO_RECIPE_MARKER, readCompilerNanoRecipe } from '../scripts/compiler-doc-recipe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/compiler-acceptance.mjs', import.meta.url));
const browserCompilerSetup = fileURLToPath(new URL('../browser/fixtures/compile-artifacts.mjs', import.meta.url));
const browserPlayground = fileURLToPath(new URL('../browser/fixtures/compiler-playground.html', import.meta.url));
const builtCompiler = fileURLToPath(new URL('../dist/compiler/vite/index.js', import.meta.url));
const brokenScript = fileURLToPath(new URL('../scripts/.compiler-acceptance-trace-test.mjs', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const tracePrefix = 'tooling-trace ';
const traceKeys = ['execution', 'goal', 'id', 'owner', 'path', 'refusal', 'schemaVersion'] as const;
const traceSchemaVersion = 1 as const;

type TraceRecord = {
  schemaVersion: typeof traceSchemaVersion;
  id: string;
  goal: string;
  owner: string;
  path: string;
  execution: 'compiled' | 'runtime';
  refusal: string | null;
};

const expectedTrace: TraceRecord[] = [
  {
    schemaVersion: traceSchemaVersion,
    id: 'nano-static',
    goal: 'static opacity=0.5',
    owner: '@labpics/motion/compiler/runtime',
    path: 'dist/compiler/runtime/index.js',
    execution: 'compiled',
    refusal: null,
  },
  {
    schemaVersion: traceSchemaVersion,
    id: 'nano-dynamic',
    goal: 'dynamic opacity',
    owner: '@labpics/motion/nano',
    path: 'dist/nano/index.js',
    execution: 'runtime',
    refusal: 'opacity is not build-known',
  },
  {
    schemaVersion: traceSchemaVersion,
    id: 'surface-static',
    goal: "static width [240,360], layout='project'",
    owner: '@labpics/motion/compiler/surface',
    path: 'dist/compiler/surface/index.js',
    execution: 'compiled',
    refusal: null,
  },
  {
    schemaVersion: traceSchemaVersion,
    id: 'surface-dynamic',
    goal: "dynamic width endpoint, layout='project'",
    owner: '@labpics/motion/animate',
    path: 'dist/animate/index.js',
    execution: 'runtime',
    refusal: 'endpoint is not build-known',
  },
  {
    schemaVersion: traceSchemaVersion,
    id: 'surface-on-frame',
    goal: "static width, layout='project', onFrame",
    owner: '@labpics/motion/animate',
    path: 'dist/animate/index.js',
    execution: 'runtime',
    refusal: 'onFrame requires runtime observation',
  },
];

function run(scriptPath = script) {
  return spawnSync(process.execPath, [scriptPath, '--trace'], {
    cwd: root,
    encoding: 'utf8',
  });
}

function parseTrace(stdout: string): TraceRecord[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(tracePrefix))
    .map((line) => JSON.parse(line.slice(tracePrefix.length)) as TraceRecord);
}

function validateTrace(records: TraceRecord[]): void {
  expect(records).toHaveLength(expectedTrace.length);
  expect(new Set(records.map(({ id }) => id)).size).toBe(expectedTrace.length);
  for (const record of records) {
    expect(Object.keys(record).sort()).toEqual([...traceKeys].sort());
  }
  expect(records).toEqual(expectedTrace);
}

function cloneTrace(): TraceRecord[] {
  return expectedTrace.map((record) => ({ ...record }));
}

beforeAll(() => {
  if (existsSync(builtCompiler)) return;
  const build = spawnSync(pnpm, ['build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(`не удалось собрать dist для trace-контракта:\n${build.stdout}\n${build.stderr}`);
  }
});

afterEach(() => {
  rmSync(brokenScript, { force: true });
});

describe('compiler tooling trace', () => {
  it('использует один буквальный docs-рецепт в acceptance, browser proof и playground', () => {
    const recipe = readCompilerNanoRecipe(root);
    expect(recipe).toContain("from '@labpics/motion/nano'");
    expect(recipe).toContain('opacity: 0.5');

    for (const consumer of [script, browserCompilerSetup]) {
      const source = readFileSync(consumer, 'utf8');
      expect(source).toContain('readCompilerNanoRecipe');
      expect(source).not.toContain("export function play(el) { return animate(el, { opacity: 0.5 }); }");
    }

    const playground = readFileSync(browserPlayground, 'utf8');
    expect(playground).toContain("from '../.artifacts/compiled.js'");
    expect(playground).not.toContain("from '@labpics/motion/nano'");
    expect(playground).not.toContain('animate(');
  });

  it('не включает playground/trace в публикуемый production package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files.some((entry) => entry === 'browser' || entry.startsWith('browser/'))).toBe(false);
    expect(pkg.files.some((entry) => entry === 'scripts' || entry.startsWith('scripts/'))).toBe(false);
  });

  it('fail-closed отвергает неоднозначный docs-рецепт', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'lab-motion-compiler-recipe-'));
    try {
      mkdirSync(join(fixtureRoot, 'docs'));
      writeFileSync(
        join(fixtureRoot, 'docs/compiler.md'),
        `${COMPILER_NANO_RECIPE_MARKER}\n\`\`\`typescript\nexport const first = 1;\n\`\`\`\n${COMPILER_NANO_RECIPE_MARKER}\n\`\`\`typescript\nexport const second = 2;\n\`\`\`\n`,
      );
      expect(() => readCompilerNanoRecipe(fixtureRoot)).toThrow('Ожидается ровно один');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('описывает ровно пять фактически собранных путей', () => {
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    validateTrace(parseTrace(result.stdout));
  });

  it('не печатает trace, если compiler acceptance не стартовал', () => {
    const source = readFileSync(script, 'utf8');
    const changed = source.replace(
      "const DIST = resolve(ROOT, 'dist');",
      "const DIST = resolve(ROOT, '.compiler-trace-missing-dist');",
    );
    expect(changed).not.toBe(source);
    writeFileSync(brokenScript, changed);

    const result = run(brokenScript);
    expect(result.status).not.toBe(0);
    expect(parseTrace(result.stdout)).toEqual([]);
  });

  it('не печатает trace при неоднозначном owner фактически собранного результата', () => {
    const source = readFileSync(script, 'utf8');
    const original = "recordTrace('nano-static', 'static opacity=0.5', compiled);";
    const changed = source.replace(
      original,
      "recordTrace('nano-static', 'static opacity=0.5', { ...compiled, modules: [...compiled.modules, NANO_MODULE] });",
    );
    expect(changed).not.toBe(source);
    writeFileSync(brokenScript, changed);

    const result = run(brokenScript);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ожидался один owner, получено 2');
    expect(parseTrace(result.stdout)).toEqual([]);
  });

  it('отвергает потерю записи и подмену owner/path/refusal', () => {
    expect(() => validateTrace(cloneTrace().slice(1))).toThrow();

    const owner = cloneTrace();
    owner[0]!.owner = '@labpics/motion/nano';
    expect(() => validateTrace(owner)).toThrow();

    const path = cloneTrace();
    path[2]!.path = 'dist/animate/index.js';
    expect(() => validateTrace(path)).toThrow();

    const refusal = cloneTrace();
    refusal[4]!.refusal = null;
    expect(() => validateTrace(refusal)).toThrow();

    const schema = cloneTrace();
    schema[0]!.schemaVersion = 2 as typeof traceSchemaVersion;
    expect(() => validateTrace(schema)).toThrow();
  });
});
