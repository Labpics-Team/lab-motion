import { expect, test } from '@playwright/test';

const SHOWCASE = '/site/dist/index.html';

test('forced reduced motion creates no native preview animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(SHOWCASE);

  await page.locator('[data-action="toggle-motion"]').click();

  const animations = await page.locator('[data-preview], [data-stagger-item]').evaluateAll((items) =>
    items.flatMap((item) => item.getAnimations().map((animation) => ({
      constructor: animation.constructor.name,
      playState: animation.playState,
    }))),
  );
  expect(animations).toEqual([]);
});
