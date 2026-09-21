import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/harness';

const PLAYGROUND = '/browser/fixtures/compiler-playground.html';

function watchRuntimeFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => failures.push(`requestfailed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`http ${response.status()}: ${response.url()}`);
  });
  return failures;
}

function opacity(page: Page): Promise<number> {
  return page.locator('[data-preview="compiler-object"]').evaluate((element) =>
    Number(getComputedStyle(element).opacity),
  );
}

test('literal docs recipe is a runnable compiled playground', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(PLAYGROUND);

  const target = page.locator('[data-preview="compiler-object"]');
  const status = page.locator('[data-compiler-status]');
  await expect(page.getByRole('button', { name: 'Run recipe' })).toBeVisible();
  await expect(status).toHaveText('ready');
  expect(await opacity(page)).toBeCloseTo(1, 3);

  await page.getByRole('button', { name: 'Run recipe' }).click();
  await expect(status).toHaveText(/running|complete/);
  await expect.poll(() => opacity(page)).toBeCloseTo(0.5, 3);
  await expect(status).toHaveText('complete');
  expect(await target.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(failures).toEqual([]);
});

test('playground executes the same recipe under reduced motion', async ({ page }) => {
  const failures = watchRuntimeFailures(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(PLAYGROUND);

  const target = page.locator('[data-preview="compiler-object"]');
  const status = page.locator('[data-compiler-status]');
  await page.getByRole('button', { name: 'Run recipe' }).click();
  await expect(status).toHaveText(/running|complete/);
  await expect.poll(() => opacity(page)).toBeCloseTo(0.5, 3);
  await expect(status).toHaveText('complete');
  expect(await target.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(failures).toEqual([]);
});
