import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectInventory, ROOT } from '../scripts/naming-inventory.mjs';

describe('README: проверяемые факты публичной поверхности', () => {
  it('число exports выводится из package.json, а не живёт устаревающим литералом', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const { subpaths } = collectInventory(ROOT);
    const nestedSubpaths = subpaths.filter((subpath) => subpath !== '.').length;

    expect(readme).toContain(
      `Корневой экспорт + ${nestedSubpaths} субпутей (${subpaths.length} входов \`exports\` в`,
    );
  });

  it('не обещает вручную скопированную таблицу динамических размеров', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

    expect(readme).not.toContain('полная таблица всех');
    expect(readme).toContain('Актуальные числа не копируются в Markdown');
  });
});
