import { createServer } from 'vite';
import { chromium, firefox, webkit } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const address = server.httpServer.address();
if (typeof address !== 'object' || address === null) throw new Error('Не найден адрес Vite');
const url = `http://127.0.0.1:${address.port}`;
try {
  for (const [name, browserType] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1040, height: 800 } });
      await page.goto(url);
      const light = page.locator('[data-id="light"]');
      const space = page.locator('[data-id="space"]');
      await light.locator('[data-open]').click();
      if (!(await light.locator('.detail').isVisible())) throw new Error(`${name}: подробности не открылись`);
      await light.locator('textarea').fill('Мой текст');
      await space.locator('[data-open]').click();
      if (!(await space.locator('.detail').isVisible())) throw new Error(`${name}: другое содержание не открылось`);
      await page.keyboard.press('Escape');
      if (await space.locator('.detail').isVisible()) throw new Error(`${name}: Escape не закрыл подробности`);
      if (!(await space.locator('[data-open]').evaluate(el => el === document.activeElement))) throw new Error(`${name}: фокус не восстановлен`);
      await light.locator('[data-open]').click();
      if (await light.locator('textarea').inputValue() !== 'Мой текст') throw new Error(`${name}: заметка потеряна`);
      await page.setViewportSize({ width: 390, height: 760 });
      await page.waitForTimeout(1200);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: горизонтальный переполненный экран`);
      await page.locator('#motion').click();
      if (await page.locator('#motion').getAttribute('aria-pressed') !== 'true') throw new Error(`${name}: контроль движения не включился`);
      await page.locator('#direction').selectOption('rtl');
      await page.keyboard.press('Escape');
      console.log(`${name}: PASS`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
