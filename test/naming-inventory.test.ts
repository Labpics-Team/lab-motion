import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditRepo, fileLawErrors } from '../scripts/check-docs-drift.mjs';
import { BINDINGS } from '../scripts/naming-inventory.mjs';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'motion-naming-'));
  const exports: Record<string, { import: { default: string } }> = {
    '.': { import: { default: './dist/motion/index.js' } },
  };
  for (const name of BINDINGS) {
    exports[`./${name}`] = { import: { default: `./dist/${name}/index.js` } };
    mkdirSync(join(root, 'src', name), { recursive: true });
    writeFileSync(join(root, 'src', name, 'index.ts'), 'export {};\n');
  }
  mkdirSync(join(root, 'src', 'motion'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'motion', 'index.ts'), 'export {};\n');
  writeFileSync(join(root, 'docs', 'NAMING.md'), '# Имена\n\n## Известные отступления\n\nНет.\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    description: `${BINDINGS.length} framework bindings`, exports,
  }));
  return { root, exports };
}

describe('Именование модулей', () => {
  it('подхватывает новый экспорт без правки документа', () => {
    const { root, exports } = workspace();
    try {
      expect(auditRepo(root).errors).toEqual([]);
      exports['./new-module'] = { import: { default: './dist/new-module/index.js' } };
      mkdirSync(join(root, 'src', 'new-module'));
      writeFileSync(join(root, 'src', 'new-module', 'index.ts'), 'export {};\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        description: `${BINDINGS.length} framework bindings`, exports,
      }));
      expect(auditRepo(root).errors).toEqual([]);

      unlinkSync(join(root, 'src', 'new-module', 'index.ts'));
      expect(auditRepo(root).errors).toContainEqual(expect.stringContaining('не разрешается в src'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('отклоняет устаревшее исключение из документации', () => {
    expect(fileLawErrors('`src/LegacyName.ts`', [])).toContainEqual(
      expect.stringContaining('src/LegacyName.ts'),
    );
  });

  it('отклоняет чужое CSS-имя без записи в отступлениях', () => {
    const { root } = workspace();
    try {
      writeFileSync(join(root, 'src', 'motion', 'index.ts'), "export const color = '--external-color';\n");
      expect(auditRepo(root).errors).toContainEqual(expect.stringContaining('--external-color'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
