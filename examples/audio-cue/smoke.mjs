import { chromium, firefox, webkit } from '@playwright/test';

const name = process.env.MOTION_BROWSER ?? 'chromium';
const engine = { chromium, firefox, webkit }[name];
if (!engine) throw new Error(`Неизвестный браузер: ${name}`);
const browser = await engine.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:4180/', { waitUntil: 'networkidle' });
  const seek = page.locator('#seek');
  if (await page.locator('#cue-title').textContent() !== 'Вступление') throw new Error('Начальный фрагмент неверен');
  await page.locator('#quiet').click();
  for (const [at, expected] of [[142, 2], [145, 3]]) {
    await seek.evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); }, at);
    const visual = await page.locator('#cursor').evaluate(cursor => {
      const x = cursor.getBoundingClientRect().left + cursor.getBoundingClientRect().width / 2;
      return [...document.querySelectorAll('.segments span')].findIndex(segment => {
        const rect = segment.getBoundingClientRect(); return rect.left <= x && x <= rect.right;
      });
    });
    if (visual !== expected) throw new Error(`В ${at} с визуальный фрагмент ${visual}, ожидался ${expected}`);
  }
  await page.locator('#quiet').click();
  await seek.evaluate(element => { element.value = '0'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#next').click();
  if (await seek.inputValue() !== '40') throw new Error('Переход не установил границу фрагмента');
  await page.locator('#note').fill('Убрать паузу после первого слова');
  await page.locator('#next').click();
  await page.locator('#previous').click();
  if (await page.locator('#note').inputValue() !== 'Убрать паузу после первого слова') throw new Error('Заметка потеряна после смены фрагмента');
  await seek.focus(); await page.keyboard.press('ArrowRight');
  if (await seek.inputValue() !== '41' || !((await seek.getAttribute('aria-valuetext')) ?? '').startsWith('00:41')) throw new Error('Клавиатура не переместила курсор');
  await page.locator('#mark').click();
  if (await page.locator('#marks li').count() !== 1) throw new Error('Точка монтажа не сохранена');
  const range = await seek.boundingBox();
  if (!range) throw new Error('Шкала не измерена');
  await page.mouse.click(range.x + range.width * .75, range.y + range.height / 2);
  if (Number(await seek.inputValue()) < 100) throw new Error('Указатель не переместил курсор');
  await page.locator('#next').click();
  await page.locator('#marks li button').first().click();
  if (await seek.inputValue() !== '41' || !await page.locator('#marks li button').first().evaluate(e => e === document.activeElement)) throw new Error('Возврат к точке потерял положение или фокус');
  await page.locator('#direction').click();
  if (await seek.getAttribute('dir') !== 'rtl') throw new Error('RTL не применён');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator('#quiet').click();
  for (const [at, expected] of [[142, 2], [145, 3]]) {
    await seek.evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); }, at);
    const visual = await page.locator('#cursor').evaluate(cursor => {
      const x = cursor.getBoundingClientRect().left + cursor.getBoundingClientRect().width / 2;
      return [...document.querySelectorAll('.segments span')].findIndex(segment => {
        const rect = segment.getBoundingClientRect(); return rect.left <= x && x < rect.right;
      });
    });
    if (visual !== expected) throw new Error(`В RTL при ${at} с визуальный фрагмент ${visual}, ожидался ${expected}`);
  }
  await seek.focus(); await page.keyboard.press('Home');
  if (await seek.inputValue() !== '0') throw new Error('Начало шкалы недостижимо');
  const inside = await page.locator('#cursor').evaluate(e => {
    const cursor = e.getBoundingClientRect(), track = e.parentElement.getBoundingClientRect();
    return cursor.left >= track.left - 1 && cursor.right <= track.right + 1;
  });
  if (!inside) throw new Error('Курсор вышел из мобильной RTL шкалы');
  await page.locator('#next').click();
  if (await page.locator('#cursor').evaluate(e => e.getAnimations().length) !== 0) throw new Error('Ручной режим без движения анимировал курсор');
  await page.locator('#quiet').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#previous').click();
  if (await page.locator('#cursor').evaluate(e => e.getAnimations().length) !== 0) throw new Error('Системный reduced motion анимировал курсор');
  await page.locator('#marks li button').last().click();
  if (await page.locator('#marks li').count() || !await page.locator('#empty').isVisible()) throw new Error('Удаление точки не восстановило пустое состояние');
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.locator('#next').click();
  if (name === 'chromium') await page.screenshot({ path: 'examples/audio-cue/.artifacts/mobile.png', fullPage: true });
  if (errors.length) throw new Error(`Ошибки страницы: ${errors.join('; ')}`);
  process.stdout.write(`Audio cue smoke (${name}): PASS\n`);
} finally { await browser.close(); }
