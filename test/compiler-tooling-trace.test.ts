import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/compiler-acceptance.mjs', import.meta.url));
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

function run(scriptPath = script, trace = true) {
  return spawnSync(process.execPath, trace ? [scriptPath, '--trace'] : [scriptPath], {
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
  it('описывает ровно пять фактически собранных путей', () => {
    const result = run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    validateTrace(parseTrace(result.stdout));
  });

  it('без --trace сохраняет обычный acceptance без диагностического вывода', () => {
    const result = run(script, false);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseTrace(result.stdout)).toEqual([]);
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

  it('не печатает trace при отсутствии owner фактически собранного результата', () => {
    const source = readFileSync(script, 'utf8');
    const original = "recordTrace('nano-static', 'static opacity=0.5', compiled);";
    const changed = source.replace(
      original,
      "recordTrace('nano-static', 'static opacity=0.5', { ...compiled, modules: ['unregistered/module.js'] });",
    );
    expect(changed).not.toBe(source);
    writeFileSync(brokenScript, changed);

    const result = run(brokenScript);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ожидался один owner, получено 0');
    expect(parseTrace(result.stdout)).toEqual([]);
  });

  it.each([
    ['отсутствующей', "recordTrace('nano-dynamic', 'dynamic opacity', control);"],
    ['пустой', "recordTrace('nano-dynamic', 'dynamic opacity', control, '');"],
  ])('не публикует runtime trace с %s причиной отказа', (_case, replacement) => {
    const source = readFileSync(script, 'utf8');
    const original = "recordTrace('nano-dynamic', 'dynamic opacity', control, 'opacity is not build-known');";
    const changed = source.replace(original, replacement);
    expect(changed).not.toBe(source);
    writeFileSync(brokenScript, changed);

    const result = run(brokenScript);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('runtime refusal обязателен и не может быть пустым');
    expect(parseTrace(result.stdout)).toEqual([]);
  });

  it('unit-контроль oracle отвергает потерю записи и подмену полей', () => {
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
