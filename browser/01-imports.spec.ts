/**
 * 01-imports.spec.ts — матрица #102, пункт (1): импорт ВСЕХ browser-субпутей
 * СОБРАННОГО dist в реальной странице БЕЗ side-effects.
 *
 * Проверяется ровно то, чего не видит node/jsdom-сьют: что ESM-модуль,
 * загруженный движком браузера, (а) не бросает на import; (б) не трогает DOM
 * (SSR-safe инвариант — ни одной записи в document на верхнем уровне); (в) не
 * протекает в глобалы (window не прирастает ключами); (г) отдаёт непустой набор
 * экспортов. Список субпутей выводится из package.json — новый субпуть попадает
 * в проверку автоматически.
 */

import { browserSubpathUrls, expect, test } from './fixtures/harness';

test('все browser-субпути импортируются без side-effects и с непустым API', async ({ page }) => {
  const targets = browserSubpathUrls();

  const result = await page.evaluate(async (subpaths: { subpath: string; url: string }[]) => {
    const bodyBefore = document.body.innerHTML;
    const childrenBefore = document.documentElement.childElementCount;
    const globalsBefore = new Set(Object.keys(globalThis));
    const styleAttrsBefore = document.documentElement.getAttribute('style');

    const report: {
      subpath: string;
      url: string;
      ok: boolean;
      keys: number;
      error: string | null;
    }[] = [];

    for (const { subpath, url } of subpaths) {
      try {
        const mod = (await import(url)) as Record<string, unknown>;
        report.push({ subpath, url, ok: true, keys: Object.keys(mod).length, error: null });
      } catch (error) {
        report.push({
          subpath,
          url,
          ok: false,
          keys: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Side-effect-детекторы: любой сдвиг DOM/глобалов на import — регресс SSR-safe.
    const addedGlobals = Object.keys(globalThis).filter((k) => !globalsBefore.has(k));

    return {
      report,
      domMutated: document.body.innerHTML !== bodyBefore,
      childrenMutated: document.documentElement.childElementCount !== childrenBefore,
      styleMutated: document.documentElement.getAttribute('style') !== styleAttrsBefore,
      addedGlobals,
    };
  }, targets);

  // (а) ни один субпуть не бросил и (г) каждый отдал непустой API.
  const failed = result.report.filter((r) => !r.ok);
  expect(failed, `субпути с ошибкой import: ${JSON.stringify(failed)}`).toEqual([]);
  const empty = result.report.filter((r) => r.keys === 0);
  expect(empty, `субпути с пустым API: ${JSON.stringify(empty)}`).toEqual([]);
  expect(result.report.length).toBeGreaterThan(20);

  // (б) DOM не тронут импортом.
  expect(result.domMutated).toBe(false);
  expect(result.childrenMutated).toBe(false);
  expect(result.styleMutated).toBe(false);

  // (в) глобалы не протекли (webpack/vite-подобные загрузчики не в счёт: их нет).
  expect(result.addedGlobals, `протёкшие глобалы: ${result.addedGlobals.join(', ')}`).toEqual([]);
});
