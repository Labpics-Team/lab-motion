import { expect, test } from '@playwright/test';

const SHOWCASE = '/site/dist/index.html';

const nativeAnimations = () => document.getAnimations().map((animation) => ({
  constructor: animation.constructor.name,
  playState: animation.playState,
}));

test.describe.configure({ retries: 0 });

test('forced reduced motion creates no native animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(SHOWCASE);

  await page.locator('[data-action="toggle-motion"]').click();

  expect(await page.evaluate(nativeAnimations)).toEqual([]);
});

