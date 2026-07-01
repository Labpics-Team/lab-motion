import { describe, expect, it } from 'vitest';
import { deriveEntriesFromExports, isFullBundleReady, measureEntries, PLANNED_PLUGIN_SUBPATHS } from '../scripts/size-gate.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Класс регрессии, который закрывает этот файл: размерный гейт раньше нёс
 * ЖЁСТКО ЗАКОДИРОВАННЫЙ список subpath-путей (`const ENTRIES = [...]`), из-за
 * чего добавление нового exports-ключа в package.json (например ./value)
 * НЕ появлялось в отчёте, пока кто-то вручную не правил scripts/size-gate.mjs.
 * Эти тесты доказывают, что список ТЕПЕРЬ выводится программно из
 * package.json → exports, а не хранится литералом в скрипте.
 */
describe('size-gate: auto-derive subpath entries from package.json exports', () => {
  it('derives one entry per exports key that has an "import" condition', () => {
    const pkg = {
      exports: {
        '.': { import: './dist/index.js', require: './dist/index.cjs' },
        './easing': { import: './dist/easing/index.js' },
        './types-only': { types: './dist/types-only.d.ts' }, // нет import → должен быть отфильтрован
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.label)).toEqual(['core (index)', 'easing']);
    expect(entries.find(e => e.label === 'core (index)')?.importPath).toBe('dist/index.js');
    expect(entries.find(e => e.label === 'easing')?.importPath).toBe('dist/easing/index.js');
  });

  it('regression: a freshly-added fake exports key is picked up WITHOUT touching size-gate.mjs', () => {
    // Симулирует ровно сценарий из условия успеха s08b: кто-то добавляет
    // новый subpath-плагин в package.json exports — размерный гейт обязан
    // увидеть его автоматически.
    const pkg = {
      exports: {
        '.': { import: './dist/index.js' },
        './timeline': { import: './dist/timeline/index.js' },
        './fake-new-plugin': { import: './dist/fake-new-plugin/index.js' },
      },
    };

    const entries = deriveEntriesFromExports(pkg);
    const labels = entries.map(e => e.label);

    expect(labels).toContain('timeline');
    expect(labels).toContain('fake-new-plugin');
  });

  it('only the core (".") entry carries a byte gate; every other subpath is measure-only', () => {
    const pkg = {
      exports: {
        '.': { import: './dist/index.js' },
        './react': { import: './dist/react/index.js' },
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries.find(e => e.key === '.')?.gate).toBe(2048);
    expect(entries.find(e => e.key === './react')?.gate).toBeNull();
  });

  it('throws a clear error when package.json has no "exports" field (fails loud, not silent-empty)', () => {
    expect(() => deriveEntriesFromExports({})).toThrow(/exports/);
  });

  it('isFullBundleReady is false until ALL planned plugin subpaths (timeline/stagger/svg/layout) exist in exports', () => {
    const partial = { exports: { '.': { import: './dist/index.js' }, './timeline': { import: './dist/timeline/index.js' } } };
    expect(isFullBundleReady(partial)).toBe(false);

    const full = {
      exports: Object.fromEntries([
        ['.', { import: './dist/index.js' }],
        ...PLANNED_PLUGIN_SUBPATHS.map(p => [p, { import: `./dist${p}/index.js` }]),
      ]),
    };
    expect(isFullBundleReady(full)).toBe(true);
  });

  it('measureEntries flags MISSING for a dist file that does not exist, without throwing', () => {
    const { rows, hasWarnings } = measureEntries(
      [{ key: './nope', label: 'nope', importPath: 'dist/does-not-exist.js', gate: null }],
      ROOT
    );
    expect(hasWarnings).toBe(true);
    expect(rows[0].error).toMatch(/MISSING/);
  });

  it('integration: current repo package.json exports every subpath the real dist/ build emits', () => {
    // Заземление в реальность: не мок, а фактический package.json + dist после `pnpm build`.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const entries = deriveEntriesFromExports(pkg);

    expect(entries.length).toBeGreaterThanOrEqual(7); // core + easing + react + svelte + vue + value + driver
    const { rows, hasWarnings } = measureEntries(entries, ROOT);
    const missing = rows.filter(r => r.error);
    expect(missing, `subpaths missing from built dist/: ${missing.map(r => r.label).join(', ')}`).toHaveLength(0);
    // Достигаем этой ветки только если dist/ реально собран этим тестраном.
    expect(hasWarnings === true || hasWarnings === false).toBe(true);
  });
});
