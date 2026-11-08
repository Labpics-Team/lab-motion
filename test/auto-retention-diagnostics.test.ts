import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { expect, test } from 'vitest';

const source = readFileSync(new URL('../browser/13-auto-retention.spec.ts', import.meta.url), 'utf8');

// Исполняется настоящий failure-wrapper спеки с подменённым page, не Firefox/GC.
async function witness(primary?: Error, diagnosticFailure = false, publicationFailure = false, input = source) {
  let scenario: ((input: unknown) => Promise<void>) | undefined;
  const register = Object.assign((name: string, callback: typeof scenario) => {
    if (name.startsWith('retained controls')) scenario = callback;
  }, { use() {} });
  let evaluations = 0;
  let collections = 0;
  const annotations: Array<{ type: string; description: string }> = [];
  const page = {
    async evaluate(callback: () => unknown) {
      evaluations++;
      if (evaluations === 1) return; // setup импортирует actual dist: здесь не исполняется.
      if (evaluations === 4 && diagnosticFailure) throw new Error('private-diagnostic');
      return callback();
    },
    async requestGC() { collections++; },
  };
  const output = transpileModule(input.replace(/^import .*;\n/gm, ''), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(output, {
    test: register,
    expect: { poll: (callback: () => Promise<unknown>) => ({
      async toBe() { await callback(); if (primary) throw primary; },
    }) },
    setTimeout,
    console: {
      log(value: string) {
        if (publicationFailure) throw new Error('private-publication');
        annotations.push({ type: 'auto-retention', description: value.slice('auto-retention: '.length) });
      },
    },
    window: {
      __autoParent: { deref: () => ({}) },
      __autoChild: { deref: () => undefined },
      __autoSentinel: { deref: () => undefined },
    },
  });
  if (!scenario) throw new Error('Не найдена исходная спека.');
  let observed: unknown;
  try {
    await scenario({ page });
  } catch (error) { observed = error; }
  return { evaluations, collections, annotations, observed };
}

test('healthy wrapper не читает диагностику и сохраняет один исходный GC', async () => {
  const result = await witness();
  expect(result).toEqual({ evaluations: 3, collections: 1, annotations: [], observed: undefined });
});

test('исходный FAIL сохраняется после единственной closed boolean выборки', async () => {
  const primary = new Error('private-primary');
  const result = await witness(primary);
  expect(result.observed).toBe(primary);
  expect([result.evaluations, result.collections]).toEqual([4, 1]);
  expect(result.annotations).toEqual([{
    type: 'auto-retention',
    description: '{"parentRetained":true,"childRetained":false,"sentinelRetained":false}',
  }]);
});

test('отказ диагностического чтения даёт null, не заменяя первичный FAIL', async () => {
  const primary = new Error('private-primary');
  const result = await witness(primary, true);
  expect(result.observed).toBe(primary);
  expect([result.evaluations, result.collections]).toEqual([4, 1]);
  expect(result.annotations[0]?.description).toBe('{"parentRetained":null,"childRetained":null,"sentinelRetained":null}');
});

test('отказ публикации сохраняет идентичность исходного assertion', async () => {
  const primary = new Error('private-primary');
  const result = await witness(primary, false, true);
  expect(result.observed).toBe(primary);
  expect(result.annotations).toEqual([]);
});

test('wrapper witness обнаруживает потерю primary, лишний GC и возврат target', async () => {
  const primary = new Error('private-primary');
  const lost = await witness(primary, false, false, source.replace('throw primary;', 'return;'));
  expect(lost.observed).not.toBe(primary);
  const extra = await witness(primary, false, false, source.replace('diagnostic = await page.evaluate(', 'await page.requestGC(); diagnostic = await page.evaluate('));
  expect(extra.collections).toBe(2);
  const target = await witness(primary, false, false, source.replace('parentRetained: retained.__autoParent.deref() !== undefined,', 'parentRetained: retained.__autoParent.deref(),'));
  expect(target.annotations[0]?.description).not.toBe('{"parentRetained":true,"childRetained":false,"sentinelRetained":false}');
});

test('sentinel не добавляет strong target/closure и не входит в pass poll', () => {
  expect(source).toContain("retained.__autoSentinel = new WeakRef(document.createElement('div'));");
  const pass = source.slice(source.indexOf('    await expectCollected(page'), source.indexOf('  } catch (primary)'));
  expect(pass).not.toContain('Sentinel');
  expect(pass).toContain('retained.__autoParent.deref() !== undefined ||');
  expect(pass).toContain('retained.__autoChild.deref() !== undefined;');
  const failure = source.slice(source.indexOf('  } catch (primary)'), source.indexOf("test('reentrant disconnect"));
  expect(failure).not.toMatch(/requestGC|setTimeout|waitForTimeout|evaluateHandle|\.message|\.stack/);
  expect(failure.match(/await page.evaluate\(/g)).toHaveLength(1);
  expect(failure).toContain('throw primary;');
});
