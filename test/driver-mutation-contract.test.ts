import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type MutationConfig = {
  mutate?: string[];
  thresholds?: { break?: number };
  vitest?: { configFile?: string };
};

describe('driver mutation admission contract', () => {
  it('keeps the whole driver in a bounded >=80% semantic mutation gate', async () => {
    const module = await import(`${pathToFileURL(resolve('stryker.driver.config.mjs')).href}?contract`);
    const config = module.default as MutationConfig;

    expect(config.mutate).toEqual(['src/driver.ts']);
    expect(config.thresholds?.break).toBeGreaterThanOrEqual(80);
    expect(config.vitest?.configFile).toBe('vitest.stryker.driver.config.ts');
  });

  it('keeps one PR CI SSOT while requiring driver mutation on every candidate', () => {
    const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const scheduled = readFileSync(resolve('.github/workflows/mutation.yml'), 'utf8');

    expect(ci).toContain('pnpm exec stryker run stryker.driver.config.mjs');
    expect(scheduled).not.toMatch(/\npull_request:/);
    expect(scheduled).toContain('schedule:');
    expect(scheduled).toContain('workflow_dispatch:');
    expect(scheduled).toContain('pnpm exec stryker run stryker.driver.config.mjs');
    expect(scheduled).toContain('needs: [core, driver]');
    expect(scheduled).toContain('timeout-minutes: 120');
  });
});
