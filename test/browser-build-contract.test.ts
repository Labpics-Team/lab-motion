import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import browserConfig from '../playwright.config.js';

it('browser verification consumes the library without a documentation build', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/browser.yml', import.meta.url), 'utf8'));
  const commands = workflow.jobs.conformance.steps.flatMap((step: { run?: string }) => step.run ? [step.run] : []);
  const build = commands.indexOf('pnpm build');
  const browser = commands.findIndex((command: string) => command.startsWith('pnpm exec playwright test'));
  expect(build).toBeGreaterThanOrEqual(0);
  expect(browser).toBeGreaterThan(build);
  expect(commands.some((command: string) => /(?:site|docs):/.test(command))).toBe(false);
  const server = browserConfig.webServer;
  expect(server).not.toBeInstanceOf(Array);
  if (!server || Array.isArray(server) || !server.url) throw new Error('Browser server URL is required');
  expect(new URL(server.url).pathname).toBe('/dist/index.js');
  expect(existsSync(new URL('../dist/index.js', import.meta.url))).toBe(true);
});
