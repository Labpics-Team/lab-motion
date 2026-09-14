import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('публичные witnesses различают восемь неверных binding-реализаций и здоровый контроль', () => {
  const output = execFileSync(process.execPath, [resolve('scripts/check-binding-mutations.mjs')], {
    encoding: 'utf8', timeout: 90_000,
  });
  const report = JSON.parse(output);
  expect(report.records.map((item: { name: string }) => item.name)).toEqual([
    'restart-unchanged', 'mutable-goal', 'aliased-goal', 'partial-cleanup',
    'cancel-successor', 'overwrite-destroy', 'recursive-project', 'read-after-revoke',
  ]);
  expect(report.records.every((item: { killed: boolean }) => item.killed)).toBe(true);
  expect(report.baselineTests).toBeGreaterThan(0);
  expect(report.restoredTests).toBe(report.baselineTests);
  console.log('binding mutation receipt', output.trim());
}, 100_000);
