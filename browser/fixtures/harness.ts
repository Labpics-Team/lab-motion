/**
 * harness.ts — общая Playwright-фикстура browser conformance.
 *
 * Каждая спека грузит СОБРАННЫЙ dist (ESM) в реальную страницу: `page` уже
 * навигирован на harness.html (origin по http от zero-dep server.mjs), поэтому
 * в `page.evaluate` работает `await import('/dist/<subpath>/index.js')` — грузится
 * ровно тот артефакт, что уедет потребителю, со всеми внутренними относительными
 * import'ами нетронутыми.
 *
 * Фикстура НЕ добавляет ни таймингов, ни глобалов: детерминизм и семплирование —
 * забота самих спек (Animation.currentTime, инжектируемые requestFrame/now/setTimer).
 */

import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HARNESS_PATH = '/browser/fixtures/harness.html';

/** Субпути с ОБЯЗАТЕЛЬНЫМ peer-фреймворком: в голом браузере без peer их import
 *  провалится по дизайну (peer не установлен) — вне зоны browser-conformance. */
const PEER_BINDING_SUBPATHS = new Set([
  './react',
  './svelte',
  './vue',
  './lit',
  './solid',
  './preact',
  './angular',
  './qwik',
]);

/**
 * Все НЕ-peer субпути пакета как http-пути к dist ESM ('/dist/<x>/index.js').
 * Список выводится из package.json#exports — новый субпуть попадает в матрицу
 * импорта автоматически (класс дрифта «забыли субпуть» закрыт).
 */
export function browserSubpathUrls(): { subpath: string; url: string }[] {
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as {
    exports: Record<string, { import: string }>;
  };
  const out: { subpath: string; url: string }[] = [];
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (PEER_BINDING_SUBPATHS.has(key)) continue;
    // exports[key].import = './dist/<x>/index.js' → http-путь '/dist/<x>/index.js'.
    const rel = value.import.replace(/^\.\//, '/');
    out.push({ subpath: key, url: rel });
  }
  return out;
}

/** test с `page`, уже открытым на harness.html (origin http от server.mjs). */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.goto(HARNESS_PATH);
    await use(page);
  },
});

export { expect };
