/**
 * Страж свежести dist: часть unit-набора читает собранные артефакты
 * (zero-dep-smoke, release-artifact/metadata, *-package, easing-subpath-smoke),
 * и устаревший dist делает их прогон ложью — зелёной или красной не о том
 * дереве. CI строит перед тестами и проходит страж даром; локально страж
 * заменяет тихую ложь явным «пересобери».
 *
 * Эвристика — mtime: новейший исходник сборки (src/**, tsup.config.ts,
 * package.json) не должен быть моложе старейшего entry в dist. git-операции
 * освежают mtime исходников без смены содержимого — возможен ложный сигнал,
 * цена которого один pnpm build; обратная ошибка (молчание про stale) стоит
 * ложного вердикта целого прогона. Асимметрия — за стража.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function newestMtime(dir: string, into: { at: number; file: string }): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newestMtime(path, into);
    } else if (entry.isFile()) {
      const at = statSync(path).mtimeMs;
      if (at > into.at) {
        into.at = at;
        into.file = path;
      }
    }
  }
}

describe('dist: свежесть собранных артефактов', () => {
  it('dist существует и не старше исходников сборки', () => {
    const dist = join(ROOT, 'dist');
    expect(
      existsSync(join(dist, 'index.js')),
      'dist отсутствует: тесты артефактов читают сборку — выполните pnpm build',
    ).toBe(true);

    const source = { at: 0, file: '' };
    newestMtime(join(ROOT, 'src'), source);
    for (const file of ['tsup.config.ts', 'package.json']) {
      const at = statSync(join(ROOT, file)).mtimeMs;
      if (at > source.at) {
        source.at = at;
        source.file = join(ROOT, file);
      }
    }

    // Старейший entry: устаревание ЛЮБОГО опубликованного входа — уже ложь.
    let oldest = Number.POSITIVE_INFINITY;
    let oldestFile = '';
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name === 'index.js') {
          const at = statSync(path).mtimeMs;
          if (at < oldest) {
            oldest = at;
            oldestFile = path;
          }
        }
      }
    };
    visit(dist);

    expect(
      oldest >= source.at,
      `dist старше исходников: ${source.file} новее ${oldestFile} — выполните pnpm build`,
    ).toBe(true);
  });
});
