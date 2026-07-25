/**
 * docs-export-coverage.test.ts — каждый публичный runtime-экспорт назван на
 * СВОЕЙ странице документации.
 *
 * ЗАЧЕМ. Дрейф-гейты пакета проверяют СТРУКТУРУ (есть ли страница у субпутя,
 * совпадают ли числа) и ПРИМЕРЫ (компилируются ли сниппеты), но ни один не
 * спрашивал самого простого: а описан ли вообще экспорт, который мы отгружаем?
 * Пробел не гипотетический — он реализовался в тот же день, когда был добавлен
 * гвард `isMotionParamError`: символ уехал в поставку и в `docs/errors.md`, но
 * на reference-странице своего субпутя (`./animate`) не появился. Один из 185
 * экспортов оказался «отгружен и не документирован», и заметить это можно было
 * только вручную.
 *
 * Проверка намеренно СЛАБАЯ по форме и СИЛЬНАЯ по охвату: требуется лишь
 * упоминание имени как отдельного слова на назначенной странице. Более строгое
 * («у каждого экспорта свой заголовок с сигнатурой») быстро выродилось бы в
 * борьбу с разметкой; задача этого гейта — ловить ЗАБЫТЫЕ символы, а не
 * оценивать качество текста.
 *
 * Источник правды — api-manifest.json, который генерируется из САМОЙ ПОСТАВКИ
 * (`pnpm manifest` читает dist), поэтому список экспортов здесь не реплика.
 *
 * Mutation proof: удалить упоминание любого экспорта со страницы его субпутя →
 * RED с точным адресом «субпуть → символ → файл».
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Subpath {
  readonly subpath: string;
  readonly runtimeExports?: readonly string[];
  readonly docs?: string;
}

const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'api-manifest.json'), 'utf8'),
) as { subpaths: readonly Subpath[] };

/** Имя как отдельное слово: `animate` не засчитывается за `animateWaapi`. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

describe('документация покрывает публичную поверхность', () => {
  it('у каждого субпутя есть существующая страница', () => {
    const broken = manifest.subpaths
      .filter((s) => s.docs === undefined || !existsSync(resolve(repoRoot, s.docs)))
      .map((s) => `${s.subpath} → ${s.docs ?? '(не назначена)'}`);
    expect(broken, `субпути без страницы:\n${broken.join('\n')}`).toEqual([]);
  });

  it('каждый runtime-экспорт назван на странице своего субпутя', () => {
    const undocumented: string[] = [];
    let checked = 0;
    for (const entry of manifest.subpaths) {
      if (entry.docs === undefined) continue;
      const page = readFileSync(resolve(repoRoot, entry.docs), 'utf8');
      for (const name of entry.runtimeExports ?? []) {
        checked++;
        if (!mentions(page, name)) {
          undocumented.push(`${entry.subpath} → ${name}   (${entry.docs})`);
        }
      }
    }
    // Охват — часть утверждения: гейт, который ничего не проверил, зелен.
    expect(checked).toBeGreaterThanOrEqual(180);
    expect(
      undocumented,
      `отгружены, но не описаны на своей странице:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });
});
