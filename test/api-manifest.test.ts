/**
 * #96 (срез) — дрейф-гейт машиночитаемого API-манифеста.
 *
 * Закон: манифест генерируется из фактов (exports ↔ dist ↔ docs), ручная копия
 * поверхности запрещена. Тест перегенерирует манифест в памяти и сравнивает с
 * закоммиченным по ВСЕМ полям, кроме shipped*Bytes (размеры актуализирует
 * pnpm build перед публикацией; их правда защищена отдельно pnpm size).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — генератор намеренно .mjs без деклараций (тот же класс, что size-gate)
import { buildManifest, renderLlms, DOCS_MAP } from '../scripts/api-manifest.mjs';

const ROOT = resolve(__dirname, '..');

interface ManifestSubpath {
  subpath: string;
  import: string;
  runtimeExports: string[];
  shippedGzBytes: number;
  shippedBrBytes: number;
  docs?: string;
  title?: string;
}
interface Manifest {
  schemaVersion: number;
  package: string;
  version: string;
  subpaths: ManifestSubpath[];
}

function stripSizes(manifest: Manifest): unknown {
  return {
    ...manifest,
    subpaths: manifest.subpaths.map(({ shippedGzBytes: _gz, shippedBrBytes: _br, ...rest }) => rest),
  };
}

const committed = JSON.parse(
  readFileSync(resolve(ROOT, 'api-manifest.json'), 'utf8'),
) as Manifest;

describe('api-manifest: exports ↔ manifest ↔ docs без дрейфа', () => {
  it('каждый package.json#exports субпуть представлен ровно один раз', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const expected = Object.keys(pkg.exports).sort();
    const actual = committed.subpaths.map((s) => s.subpath).sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('перегенерация совпадает с закоммиченным (кроме размеров — их правит build)', async () => {
    const fresh = (await buildManifest()) as Manifest;
    expect(stripSizes(fresh)).toEqual(stripSizes(committed));
  }, 120_000);

  it('каждая docs-страница существует и упоминает свой import-путь', () => {
    for (const s of committed.subpaths) {
      expect(s.docs, s.subpath).toBeDefined();
      const page = resolve(ROOT, s.docs!);
      expect(existsSync(page), `${s.docs} отсутствует`).toBe(true);
      const text = readFileSync(page, 'utf8');
      expect(text.includes(s.import), `${s.docs} не упоминает ${s.import}`).toBe(true);
    }
  });

  it('runtime-входы непусты; манифест не выдумывает экспортов у известных entry', () => {
    const byPath = new Map(committed.subpaths.map((s) => [s.subpath, s]));
    expect(byPath.get('./animate')!.runtimeExports).toContain('animate');
    expect(byPath.get('./nano')!.runtimeExports).toContain('animate');
    expect(byPath.get('./spring')!.runtimeExports).toEqual(
      expect.arrayContaining(['fromBounce', 'fromVisualDuration', 'fromPeak', 'fromOscillation', 'springAsEasing']),
    );
    expect(byPath.get('./compiler/vite')!.runtimeExports).toContain('motionCompiler');
    for (const s of committed.subpaths) {
      expect(s.runtimeExports.length, `${s.subpath}: пустой runtime`).toBeGreaterThan(0);
    }
  });

  it('llms.txt сгенерирован из манифеста, а не поддерживается вручную', () => {
    const llms = readFileSync(resolve(ROOT, 'llms.txt'), 'utf8');
    expect(llms).toBe(renderLlms(committed));
  });

  it('DOCS_MAP покрывает все субпути (нет забытых страниц)', () => {
    for (const s of committed.subpaths) {
      expect((DOCS_MAP as Record<string, string>)[s.subpath], s.subpath).toBeDefined();
    }
  });
});
