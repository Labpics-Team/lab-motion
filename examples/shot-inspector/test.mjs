import { createServer } from 'vite';
import { chromium, firefox, webkit } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = JSON.parse(readFileSync(new URL('./.artifacts/package.json', import.meta.url)));
const installedBytes = readFileSync(new URL('./node_modules/@labpics/motion/package.json', import.meta.url));
const installed = JSON.parse(installedBytes);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (receipt.source !== head || receipt.sourceDirty !== false ||
    receipt.manifestSha256 !== hash(installedBytes) ||
    receipt.archiveSha256 !== hash(readFileSync(new URL('./.artifacts/package.tgz', import.meta.url))) ||
    receipt.projectionSha256 !== hash(readFileSync(new URL('./node_modules/@labpics/motion/dist/projection/index.js', import.meta.url))) ||
    receipt.package !== installed.name || receipt.version !== installed.version) {
  throw new Error('Пример не связан с установленным архивом текущего source');
}
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const address = server.httpServer.address();
if (typeof address !== 'object' || !address) throw new Error('Не найден адрес сервера');
const url = `http://127.0.0.1:${address.port}`;
try {
  for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1040, height: 800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      const first = page.locator('.shot[data-id="arrival"]');
      const second = page.locator('.shot[data-id="portrait"]');
      await first.locator('.open').click();
      if (!(await first.evaluate(el => el.parentElement?.id === 'inspector'))) throw new Error(`${name}: кадр не переместился в инспектор`);
      await page.waitForFunction(() => document.querySelector('.shot[data-id="arrival"]')?.style.transform !== '', null, { timeout: 5_000 });
      if (!(await first.locator('textarea').evaluate(el => el === document.activeElement))) throw new Error(`${name}: редактор не получил фокус`);
      await first.locator('textarea').fill('Подпись редактора');
      await second.locator('.open').click();
      if (!(await second.evaluate(el => el.parentElement?.id === 'inspector'))) throw new Error(`${name}: новый кадр не перехватил инспектор`);
      if (!(await first.evaluate(el => el.parentElement?.id === 'list'))) throw new Error(`${name}: прежний кадр не вернулся`);
      await page.keyboard.press('Escape');
      if (!(await second.locator('.open').evaluate(el => el === document.activeElement))) throw new Error(`${name}: фокус не вернулся к источнику`);
      await first.locator('.open').click();
      if (await first.locator('textarea').inputValue() !== 'Подпись редактора') throw new Error(`${name}: редактор потерял ввод`);
      await page.setViewportSize({ width: 390, height: 760 });
      await first.locator('textarea').evaluate(el => { el.style.height = '210px'; });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.shot')).every(el => el.style.transform === ''), null, { timeout: 5_000 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: узкий экран переполнен`);
      await page.locator('#direction').selectOption('rtl');
      if (await page.locator('#workspace').getAttribute('dir') !== 'rtl') throw new Error(`${name}: RTL не включился`);
      await page.keyboard.press('Escape');
      if (!(await first.locator('.open').evaluate(el => el === document.activeElement))) throw new Error(`${name}: RTL нарушил возврат фокуса`);
      await page.locator('#motion').click();
      await first.locator('.open').click();
      if (await first.evaluate(el => el.style.transform !== '')) throw new Error(`${name}: контроль без движения создал transform`);
      const reduced = await browser.newPage({ reducedMotion: 'reduce' });
      await reduced.goto(url);
      await reduced.locator('.shot[data-id="arrival"] .open').click();
      if (await reduced.locator('.shot[data-id="arrival"]').evaluate(el => el.style.transform !== '')) throw new Error(`${name}: системное снижение движения проигнорировано`);
      await reduced.close();
      if (errors.length) throw new Error(`${name}: ошибки страницы: ${errors.join('; ')}`);
      console.log(`${name}: PASS`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
