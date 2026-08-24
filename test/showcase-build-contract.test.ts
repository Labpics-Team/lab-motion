import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showcase = readFileSync(
  new URL('../site/src/scripts/showcase.js', import.meta.url),
  'utf8',
);
const viteConfig = readFileSync(
  new URL('../site/vite.config.mjs', import.meta.url),
  'utf8',
);
const siteHtml = readFileSync(
  new URL('../site/index.html', import.meta.url),
  'utf8',
);
const browserWorkflow = readFileSync(
  new URL('../.github/workflows/browser.yml', import.meta.url),
  'utf8',
);
const playwrightConfig = readFileSync(
  new URL('../playwright.config.ts', import.meta.url),
  'utf8',
);
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('showcase build contract', () => {
  it('consumes the public animate export instead of an internal dist path', () => {
    expect(showcase).toContain("from '@labpics/motion/animate'");
    expect(showcase).not.toContain('dist/animate/index.js');
  });

  it('builds the public package before compiling the static consumer', () => {
    expect(pkg.scripts['site:build']).toBe('pnpm build && vite build --config site/vite.config.mjs site');
    expect(pkg.scripts['site:build']).not.toContain('/site/dist');
    expect(viteConfig).toContain("base: './'");
    expect(viteConfig).toContain('modulePreload: { polyfill: false }');
    expect(pkg.devDependencies.astro).toBeUndefined();
  });

  it('produces the showcase artifact before browser conformance runs', () => {
    const producer = browserWorkflow.indexOf('run: pnpm site:build');
    const consumer = browserWorkflow.indexOf('run: pnpm exec playwright test');

    expect(producer).toBeGreaterThan(-1);
    expect(consumer).toBeGreaterThan(producer);
  });

  it('readiness proves the built showcase route is available', () => {
    expect(playwrightConfig).toContain("url: `${BASE_URL}/site/dist/index.html`");
    expect(playwrightConfig).not.toContain("url: `${BASE_URL}/browser/fixtures/harness.html`");
  });

  it('keeps the zero-connect CSP compatible with the generated bootstrap', () => {
    expect(siteHtml).toContain("connect-src 'none'");
    expect(viteConfig).toContain('modulePreload: { polyfill: false }');
  });
});
