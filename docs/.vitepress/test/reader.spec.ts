import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

// The same Markdown is served online and included in the package.
test('every packaged documentation page is readable', async ({ page }) => {
  const pages: string[] = pkg.files.filter((file: string) => file.startsWith('docs/'));
  for (const file of pages) {
    const response = await page.goto(file.slice(5).replace(/\.md$/, '.html'));
    expect(response?.status(), file).toBe(200);
    await expect(page.getByRole('main'), file).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }), file).toBeVisible();
  }
});

test('start, read and navigate without runtime failures', async ({ page, baseURL }, info) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) failures.push(request.url());
  });
  await page.goto('');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru-RU');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Анимация для интерфейсов.');
  await page.screenshot({ path: info.outputPath('home.png'), fullPage: true });
  await page.getByRole('link', { name: 'Начать', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Начало работы[\s\u200b]*$/);
  await expect(page.locator('main')).toContainText('pnpm add @labpics/motion');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('guide.png'), fullPage: true });
  await page.locator('main').getByRole('link', { name: 'Полный API' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^API[\s\u200b]*$/);
  expect(failures).toEqual([]);
});

test('search finds an API and returns to the reader', async ({ page }) => {
  await page.goto('getting-started.html');
  await page.getByRole('button', { name: 'Поиск по документации', exact: true }).click();
  const search = page.locator('.VPLocalSearchBox');
  await search.locator('input').fill('MotionValue');
  const results = search.locator('a[href]');
  await expect(results.first()).toBeVisible();
  const destination = await results.first().getAttribute('href');
  await results.first().click();
  await expect(page).toHaveURL(new URL(destination!, page.url()).href);
  await expect(search).toBeHidden();
  await expect(page.locator('main')).toContainText('MotionValue');
  // SPA history changes do not update the browser's :target state.
  const targetId = decodeURIComponent(new URL(destination!, page.url()).hash.slice(1));
  expect(targetId).not.toBe('');
  await expect(page.locator(`[id=${JSON.stringify(targetId)}]`)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Поиск по документации', exact: true })).not.toBeFocused();
});

test('content remains available with JavaScript disabled', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(new URL('getting-started.html', baseURL).href);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Начало работы[\s\u200b]*$/);
    await expect(page.locator('main')).toContainText('motion.dispose()');
    await page.locator('main').getByRole('link', { name: 'Полный API' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^API[\s\u200b]*$/);
  } finally {
    await context.close();
  }
});

test('dark and reduced-motion preferences keep the page usable', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('getting-started.html');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Начало работы[\s\u200b]*$/);
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('guide-dark.png'), fullPage: true });
});

for (const [opening, dismissal] of [
  ['button', 'Escape'], ['shortcut', 'Escape'], ['button', 'pointer'],
] as const) {
  test(`${opening} search restores focus after ${dismissal}`, async ({ page }) => {
    await page.goto('getting-started.html');
    const button = page.getByRole('button', { name: 'Поиск по документации', exact: true });
    const origin = opening === 'button'
      ? button
      : page.locator('main').getByRole('link', { name: 'Полный API', exact: true });
    await origin.focus();
    await page.keyboard.press(opening === 'button' ? 'Enter' : 'Control+k');
    const search = page.locator('.VPLocalSearchBox');
    await expect(search.locator('input')).toBeFocused();
    await page.keyboard.type('MotionValue');
    await expect(search.locator('a[href]').first()).toBeVisible();
    if (dismissal === 'Escape') {
      await page.keyboard.press('Escape');
    } else {
      const close = search.getByRole('button', { name: 'Закрыть поиск', exact: true });
      if (await close.isVisible()) await close.click();
      else await search.locator('.backdrop').click({ position: { x: 4, y: 4 } });
    }
    await expect(search).toBeHidden();
    await expect(origin).toBeFocused();
  });
}

test('section navigation works on desktop and mobile', async ({ page }) => {
  await page.goto('getting-started.html');
  const sidebar = page.locator('.VPSidebar');
  const menu = page.getByRole('button', { name: 'Разделы', exact: true });
  if (await menu.isVisible()) await menu.click();
  await expect(sidebar.getByRole('link', { name: 'Рецепты', exact: true })).toBeInViewport();
  await sidebar.getByRole('link', { name: 'Рецепты', exact: true }).click();
  await expect(page).toHaveURL(/recipes\.html$/);
  await expect(page.getByRole('main')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
