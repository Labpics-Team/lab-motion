import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('README: публичная поверхность', () => {
  it('каждый импорт из примеров существует в package exports', () => {
    const imports = [...readme.matchAll(/from ['"](@labpics\/motion(?:\/[^'"]+)?)['"]/g)]
      .map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);

    for (const name of imports) {
      const subpath = name === '@labpics/motion'
        ? '.'
        : `./${name.slice('@labpics/motion/'.length)}`;
      expect(pkg.exports).toHaveProperty(subpath);
    }
  });

  it('не копирует динамический инвентарь и таблицы размеров в стартовую страницу', () => {
    expect(readme).not.toMatch(/Корневой экспорт \+ \d+/);
    expect(readme).not.toContain('полная таблица всех');
    expect(readme).toContain('pnpm size');
  });
});
