/**
 * support/dist-required.ts — «в CI пропуск запрещён».
 *
 * Четыре гейта поставки читают СОБРАННЫЙ dist: zero-dep (внешние импорты во всех
 * отгружаемых файлах), SSR-импорт всех 41 субпутя, ловля ошибок через границы
 * субпутей и свежесть публикуемого size-compare. На чистом чекауте без `pnpm build` их
 * нечего проверять, поэтому они объявлены через `describe.runIf(distReady)`.
 *
 * У этой конструкции есть ровно один опасный режим: если шаг сборки в CI
 * когда-нибудь уедет ниже прогона тестов, переименуется или тихо не создаст
 * dist — все четыре гейта станут ЗЕЛЁНЫМИ, не проверив ничего. Это тот же
 * класс, который аудит 2026-07-25 находил снова и снова: «гейт зелёный по
 * построению». Локально пропуск законен, в CI — нет.
 *
 * Отсюда правило: локально `distReady()` разрешает пропуск, а под CI отсутствие
 * dist обязано валить прогон с внятной причиной, а не молчать.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Признак сборки: корневой ESM-вход поставки. */
export function distExists(): boolean {
  return existsSync(resolve(repoRoot, 'dist/index.js'));
}

/**
 * Можно ли пропустить dist-зависимый набор. Под CI — нельзя: бросаем на этапе
 * сбора файла, поэтому прогон падает целиком, а не «проходит» пустым.
 */
export function distReady(): boolean {
  if (distExists()) return true;
  if (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false') {
    throw new Error(
      'dist отсутствует под CI: гейты поставки (zero-dep, SSR, границы субпутей, ' +
      'size-compare) были бы пропущены молча. Шаг «Build» обязан идти до Vitest.',
    );
  }
  return false;
}
