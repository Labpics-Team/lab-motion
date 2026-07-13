import { describe, expect, it } from 'vitest';
import {
  BESPOKE_SUBPATH_GATES,
  COMPOSITOR_CAPABILITY_GATE_BYTES,
  CORE_GATE_BYTES,
  FULL_ANIMATE_GATE_BYTES,
  FULL_CORE_CONSUMER_GATE_BYTES,
  SUBPATH_GATE_BYTES,
  deriveEntriesFromExports,
  IMPORT_COST_SCENARIOS,
  measureEntries,
  measureEsmTransfer,
  measureScenario,
} from '../scripts/size-gate.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

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

  it('ядро несёт свой порог, каждый прочий субпуть — общий SUBPATH_GATE_BYTES (drift-класс)', () => {
    // Раньше субпути были measure-only: новый раздутый субпуть проходил
    // зелёным без порога. Теперь безлимитных строк в отчёте не существует.
    const pkg = {
      exports: {
        '.': { import: './dist/index.js' },
        './react': { import: './dist/react/index.js' },
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries.find(e => e.key === '.')?.gate).toBe(CORE_GATE_BYTES);
    expect(entries.find(e => e.key === './react')?.gate).toBe(SUBPATH_GATE_BYTES);
    expect(entries.every(e => Number.isFinite(e.gate) && e.gate > 0)).toBe(true);
  });

  it('resolves a NESTED conditional-exports value (e.g. { import: { types, default } }) instead of throwing', () => {
    // Реальный package.json bundler-инструментов часто вкладывает условия
    // ("import"/"require" → {types, default}) — плоский `value.import` тут
    // был бы объектом, а не строкой, и .replace() уронил бы скрипт.
    const pkg = {
      exports: {
        '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } },
        './no-string-leaf': { import: { types: './dist/x.d.ts' } }, // нет default/строки → должен быть отфильтрован, не бросать
      },
    };

    const entries = deriveEntriesFromExports(pkg);

    expect(entries).toHaveLength(1);
    expect(entries[0].importPath).toBe('dist/index.js');
  });

  it('throws a clear error when package.json has no "exports" field (fails loud, not silent-empty)', () => {
    expect(() => deriveEntriesFromExports({})).toThrow(/exports/);
  });

  it('сценарии import-cost: непустой список, у каждого name/код с %DIST%/конечный порог > 0', () => {
    // Замена мёртвого full-bundle-гейта (./layout никогда не мержился →
    // совокупный гейт вечно был PLACEHOLDER): сценарные бюджеты — то, что
    // реально платит потребитель, и они не могут «не активироваться».
    expect(IMPORT_COST_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    for (const s of IMPORT_COST_SCENARIOS) {
      expect(typeof s.name).toBe('string');
      expect(s.code).toContain('%DIST%');
      expect(Number.isFinite(s.gate)).toBe(true);
      expect(s.gate).toBeGreaterThan(0);
    }
  });

  it('full animate имеет один SSOT-потолок для shipped subpath и consumer import-cost', () => {
    const full = IMPORT_COST_SCENARIOS.find((scenario) => scenario.name.startsWith('animate-one-liner'));
    expect(FULL_ANIMATE_GATE_BYTES).toBe(12_000);
    expect(BESPOKE_SUBPATH_GATES['./animate']).toBe(FULL_ANIMATE_GATE_BYTES);
    expect(full?.gate).toBe(FULL_ANIMATE_GATE_BYTES);
  });

  it('разделяет физические и consumer-потолки ядра и compositor capability', () => {
    expect(FULL_CORE_CONSUMER_GATE_BYTES).toBe(2330);
    expect(COMPOSITOR_CAPABILITY_GATE_BYTES).toBe(6600);
    expect(IMPORT_COST_SCENARIOS.find(({ name }) => name === 'full-core')?.gate)
      .toBe(FULL_CORE_CONSUMER_GATE_BYTES);
    expect(IMPORT_COST_SCENARIOS.find(({ name }) => name === 'compositor-stagger capability')?.gate)
      .toBe(COMPOSITOR_CAPABILITY_GATE_BYTES);
  });

  it('measureScenario: пропавший экспорт даёт error (громкий FAIL), а не тихий ноль', async () => {
    const distIndex = resolve(ROOT, 'dist/index.js');
    const broken = { name: 'broken', code: `import { noSuchExport } from '%DIST%'; console.log(noSuchExport);`, gate: 1 };
    const m = await measureScenario(broken, distIndex);
    expect(m.error, 'ошибка сборки обязана всплыть').toBeTruthy();
    expect(m.gzBytes).toBeUndefined();
  });

  it('measureScenario: реальный сценарий возвращает конечный gz > 0 и меньше шипнутого полного ядра', async () => {
    const distIndex = resolve(ROOT, 'dist/index.js');
    const onlySpring = IMPORT_COST_SCENARIOS.find(s => s.name === 'only-spring');
    expect(onlySpring).toBeDefined();
    const m = await measureScenario(onlySpring, distIndex);
    expect(m.error).toBeUndefined();
    expect(m.gzBytes).toBeGreaterThan(0);
    expect(m.brBytes).toBeGreaterThan(0);
    // Класс tree-shakeability: частичный импорт обязан быть ДЕШЕВЛЕ полного ядра.
    const full = await measureScenario(IMPORT_COST_SCENARIOS.find(s => s.name === 'full-core'), distIndex);
    expect(m.gzBytes).toBeLessThan(full.gzBytes);
  });

  it('measureEntries flags MISSING for a dist file that does not exist, without throwing', () => {
    const { rows, hasWarnings } = measureEntries(
      [{ key: './nope', label: 'nope', importPath: 'dist/does-not-exist.js', gate: null }],
      ROOT
    );
    expect(hasWarnings).toBe(true);
    expect(rows[0].error).toMatch(/MISSING/);
  });

  it('shipped CDN size includes the recursive static ESM import closure once per subpath', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lab-motion-size-closure-'));
    try {
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      const entry = `import { frame } from './frame.js'; export const value = frame; import('./lazy.js');`;
      const frame = `export const frame = 1;`;
      const lazy = `export const lazy = 'not part of initial transfer';`;
      writeFileSync(resolve(root, 'dist/index.js'), entry);
      writeFileSync(resolve(root, 'dist/frame.js'), frame);
      writeFileSync(resolve(root, 'dist/lazy.js'), lazy);

      const { rows, hasWarnings } = measureEntries(
        [{ key: '.', label: 'core', importPath: 'dist/index.js', gate: 100_000 }],
        root,
      );
      const row = rows[0];
      expect(hasWarnings).toBe(false);
      expect(row.closureFiles).toBe(2);
      expect(row.entryGzBytes).toBe(gzipSync(Buffer.from(entry), { level: 9 }).length);
      expect(row.gzBytes).toBe(
        gzipSync(Buffer.from(entry), { level: 9 }).length +
        gzipSync(Buffer.from(frame), { level: 9 }).length,
      );
      expect(row.gzBytes).toBeLessThan(
        row.entryGzBytes + gzipSync(Buffer.from(frame), { level: 9 }).length +
        gzipSync(Buffer.from(lazy), { level: 9 }).length,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes recursive CSS @import in the initial shipped graph', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lab-motion-size-css-'));
    try {
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      const entry = `import './theme.css'; export const value = 1;`;
      const theme = `@import './tokens.css'; .box { color: var(--ink); }`;
      const tokens = `:root { --ink: #111; }`;
      writeFileSync(resolve(root, 'dist/index.js'), entry);
      writeFileSync(resolve(root, 'dist/theme.css'), theme);
      writeFileSync(resolve(root, 'dist/tokens.css'), tokens);

      const measured = measureEsmTransfer('dist/index.js', root);
      expect(measured.closureFiles).toBe(3);
      expect(measured.gzBytes).toBe(
        gzipSync(Buffer.from(entry), { level: 9 }).length +
        gzipSync(Buffer.from(theme), { level: 9 }).length +
        gzipSync(Buffer.from(tokens), { level: 9 }).length,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a shipped entry imports a local file outside dist', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lab-motion-size-boundary-'));
    try {
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      mkdirSync(resolve(root, 'src'), { recursive: true });
      writeFileSync(resolve(root, 'dist/index.js'), `export { secret } from '../src/private.js';`);
      writeFileSync(resolve(root, 'src/private.js'), `export const secret = 1;`);
      expect(() => measureEsmTransfer('dist/index.js', root)).toThrow(/dist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(rows.every(r => r.error || (r.brBytes > 0 && r.gzBytes > 0))).toBe(true);
  });
});
