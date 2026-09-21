import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_COMPILER_TRACE,
  parseCompilerTrace,
  validateCompilerTrace,
} from '../scripts/compiler-trace-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/compiler-acceptance.mjs', import.meta.url));
const builtCompiler = fileURLToPath(new URL('../dist/compiler/vite/index.js', import.meta.url));
const brokenScript = fileURLToPath(new URL('../scripts/.compiler-acceptance-trace-test.mjs', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(scriptPath = script) {
  return spawnSync(process.execPath, [scriptPath, '--trace'], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cloneTrace() {
  return EXPECTED_COMPILER_TRACE.map((record) => ({ ...record }));
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

    const records = parseCompilerTrace(result.stdout);
    expect(() => validateCompilerTrace(records)).not.toThrow();
    expect(records).toEqual(EXPECTED_COMPILER_TRACE);
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
    expect(parseCompilerTrace(result.stdout)).toEqual([]);
  });

  it('отвергает потерю записи и подмену owner/path/refusal', () => {
    const missing = cloneTrace().slice(1);
    expect(() => validateCompilerTrace(missing)).toThrow();

    const owner = cloneTrace();
    owner[0]!.owner = '@labpics/motion/nano';
    expect(() => validateCompilerTrace(owner)).toThrow();

    const path = cloneTrace();
    path[2]!.path = 'dist/animate/index.js';
    expect(() => validateCompilerTrace(path)).toThrow();

    const refusal = cloneTrace();
    refusal[4]!.refusal = null;
    expect(() => validateCompilerTrace(refusal)).toThrow();
  });
});
