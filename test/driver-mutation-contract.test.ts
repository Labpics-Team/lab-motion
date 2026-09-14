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

  it('runs the bounded gate on relevant PRs while keeping the broad core scheduled', () => {
    const workflow = readFileSync(resolve('.github/workflows/mutation.yml'), 'utf8');

    expect(workflow).toMatch(/pull_request:\s*\n\s+paths:/);
    expect(workflow).toContain('"src/driver.ts"');
    expect(workflow).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).toContain('pnpm exec stryker run stryker.driver.config.mjs');
    expect(workflow).toContain('needs: [core, driver]');
  });
});
