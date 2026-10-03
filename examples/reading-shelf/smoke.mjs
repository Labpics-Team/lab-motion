import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'networkidle' });
  const cards = page.locator('[data-id]');
  if (await cards.count() !== 4) throw new Error('Исходная коллекция не показана');
  await page.locator('[data-id="b"] [data-move="previous"]').click();
  if (await cards.first().getAttribute('data-id') !== 'b') throw new Error('Перестановка не сохранилась');
  await page.waitForTimeout(600);
  const grip = page.locator('[data-id="b"] [data-grip]');
  const target = page.locator('[data-id="d"]');
  const from = await grip.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error('Карточки не измерены');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  if (await cards.last().getAttribute('data-id') !== 'b') throw new Error('Pointer перестановка не сохранилась');
  await page.locator('#filter').selectOption('queue');
  if (await cards.count() !== 2) throw new Error('Фильтр не применён');
  await page.locator('[data-id="d"] [data-grip]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  if (await cards.first().getAttribute('data-id') !== 'd') throw new Error('Клавиатурная перестановка не сохранилась');
  if (await page.evaluate(() => document.activeElement?.closest('[data-id]')?.getAttribute('data-id')) !== 'd') throw new Error('Фокус потерян');
  await page.keyboard.press('Escape');
  await page.locator('#direction').click();
  if (await page.locator('#shelf').getAttribute('dir') !== 'rtl') throw new Error('RTL не включился');
  await page.locator('#motion').click();
  if (await page.locator('#motion').getAttribute('aria-pressed') !== 'true') throw new Error('Режим без движения не включился');
  await page.locator('#filter').selectOption('done');
  await page.locator('[data-id="c"] [data-remove]').click();
  if (!await page.locator('#empty').isVisible()) throw new Error('Пустое состояние не показано');
  await page.locator('#filter').selectOption('all');
  await page.locator('#new-title').fill('Новая книга');
  await page.locator('#add-form button').click();
  if (!await page.getByRole('heading', { name: 'Новая книга' }).isVisible()) throw new Error('Добавление не показано');
  if (errors.length) throw new Error(`Ошибки страницы: ${errors.join('; ')}`);
  process.stdout.write('Reading shelf smoke: PASS\n');
} finally {
  await browser.close();
}
