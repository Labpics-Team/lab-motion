import { createServer } from 'vite';
import { chromium, firefox, webkit } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(new URL('./.artifacts/package.json', import.meta.url)));
const installedBytes = readFileSync(new URL('./node_modules/@labpics/motion/package.json', import.meta.url));
const installed = JSON.parse(installedBytes);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const digest = createHash('sha256').update(installedBytes).digest('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveDigest = hash(readFileSync(new URL('./.artifacts/package.tgz', import.meta.url)));
const projectionDigest = hash(readFileSync(new URL('./node_modules/@labpics/motion/dist/projection/index.js', import.meta.url)));
if (receipt.source !== head || receipt.sourceDirty !== false || receipt.manifestSha256 !== digest ||
    receipt.package !== installed.name || receipt.version !== installed.version ||
    receipt.archiveSha256 !== archiveDigest || receipt.projectionSha256 !== projectionDigest) {
  throw new Error('Пример не связан с установленным архивом');
}
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
      await page.evaluate(() => {
        window.__cardMeasures = 0;
        const measure = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.matches('[data-id]')) window.__cardMeasures++;
          return measure.call(this);
        };
      });
      await page.waitForFunction(() => document.querySelector('[data-id="light"]').style.transform !== '', null, { timeout: 5_000 });
      await page.evaluate(() => { window.__cardMeasures = 0; });
      await page.setViewportSize({ width: 390, height: 760 });
      await page.waitForFunction(() => window.__cardMeasures > 0, null, { timeout: 5_000 });
      if (await page.evaluate(() => window.__cardMeasures) === 0) throw new Error(`${name}: размер изменился во время полёта без нового замера цели`);
      await page.keyboard.press('Escape');
      await light.locator('[data-open]').click();
      await page.waitForFunction(() => document.querySelector('[data-id="light"]').style.transform !== '', null, { timeout: 5_000 });
      await page.evaluate(() => { window.__cardMeasures = 0; });
      await light.locator('textarea').evaluate(el => { el.style.height = '220px'; });
      await page.waitForFunction(() => window.__cardMeasures > 0, null, { timeout: 5_000 });
      if (await page.evaluate(() => window.__cardMeasures) === 0) throw new Error(`${name}: изменение контента во время полёта не обновило цель`);
      await page.waitForFunction(() => document.querySelector('[data-id="light"]').style.transform === '', null, { timeout: 5_000 });
      if (await light.evaluate(el => el.style.transform !== '')) throw new Error(`${name}: изменённая геометрия не завершила полёт`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: горизонтальный переполненный экран`);
      await page.keyboard.press('Escape');
      await light.locator('[data-open]').click();
      await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('pageshow'));
        window.__cardMeasures = 0;
      });
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.__cardMeasures = 0; window.dispatchEvent(new Event('resize')); });
      await page.waitForFunction(() => window.__cardMeasures > 0, null, { timeout: 5_000 });
      if (await page.evaluate(() => window.__cardMeasures) === 0) throw new Error(`${name}: возврат после pagehide отключил изменение цели`);
      await page.locator('#motion').click();
      if (await page.locator('#motion').getAttribute('aria-pressed') !== 'true') throw new Error(`${name}: контроль движения не включился`);
      if (await light.evaluate(el => el.style.transform !== '')) throw new Error(`${name}: движение не остановлено`);
      await light.locator('[data-open]').click();
      await page.setViewportSize({ width: 1040, height: 800 });
      await page.locator('#direction').selectOption('rtl');
      if (await page.locator('#gallery').getAttribute('dir') !== 'rtl') throw new Error(`${name}: направление не изменилось`);
      const positions = await page.locator('[data-id="space"], [data-id="color"]').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().x));
      if (!(positions[0] > positions[1])) throw new Error(`${name}: RTL не поменял геометрию карточек`);
      await page.keyboard.press('Escape');
      if (!(await light.locator('[data-open]').evaluate(el => el === document.activeElement))) throw new Error(`${name}: RTL нарушил возврат фокуса`);
      await light.locator('[data-open]').click();
      if (await light.evaluate(el => el.style.transform !== '')) throw new Error(`${name}: режим без движения создал полёт`);
      const reducedPage = await browser.newPage({ reducedMotion: 'reduce' });
      await reducedPage.goto(url);
      await reducedPage.locator('[data-id="light"] [data-open]').click();
      if (await reducedPage.locator('[data-id="light"]').evaluate(el => el.style.transform !== '')) throw new Error(`${name}: системное снижение движения проигнорировано`);
      await reducedPage.close();
      console.log(`${name}: PASS`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
