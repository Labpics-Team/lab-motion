import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  for (const name of ['docs', 'test', 'scripts']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'src', 'motion', 'index.ts'), 'export {};\n');
  writeFileSync(join(root, 'docs', 'NAMING.md'), '# Имена\n\n## Известные отступления\n\nНет.\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    description: `${BINDINGS.length} framework bindings`, exports,
  }));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['add', '.'], { cwd: root });
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


describe('Полнота проверки репозитория', () => {
  it.each([
    'const url = "https://example.invalid"; const css = "--foreign-color";',
    'const marker = "/*"; const css = "--foreign-color"; const end = "*/";',
    String.raw`const css = "\u002d\u002dforeign-color";`,
    'const css = `value: ${"--foreign-color"}`;',
  ])('обнаруживает CSS-имя в синтаксисе TypeScript: %s', (source) => {
    const { root } = workspace();
    try {
      writeFileSync(join(root, 'src/motion/index.ts'), source);
      expect(auditRepo(root).errors).toContainEqual(expect.stringContaining('--foreign-color'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('не принимает комментарии и регулярные выражения за CSS-строки', () => {
    const { root } = workspace();
    try {
      writeFileSync(join(root, 'src/motion/index.ts'), [
        '// "--not-a-property"', 'const pattern = /--not-a-property/;',
        'const url = "https://example.invalid"; const css = "--lab-motion-test";',
      ].join('\n'));
      expect(auditRepo(root).errors).toEqual([]);
      expect(auditRepo(root).inv.labMotionVars).toContainEqual({
        name: '--lab-motion-test', files: ['src/motion/index.ts'],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['test', 'scripts'])('не выдаёт полный инвентарь после потери %s', (name) => {
    const { root } = workspace();
    try {
      rmSync(join(root, name), { recursive: true });
      expect(() => auditRepo(root)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('отвергает ссылку на исходник за пределами дерева', () => {
    const { root } = workspace();
    const external = mkdtempSync(join(tmpdir(), 'motion-external-'));
    try {
      writeFileSync(join(external, 'source.ts'), 'export {};\n');
      symlinkSync(join(external, 'source.ts'), join(root, 'src/linked.ts'));
      expect(() => auditRepo(root)).toThrow(/symlink|ссылк/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it.each(['plans/next.txt', 'docs/next.md'])('отклоняет tracked рабочую запись %s', (file) => {
    const { root } = workspace();
    try {
      mkdirSync(join(root, file.split('/')[0]), { recursive: true });
      writeFileSync(join(root, file), '---\ntrack: motion\nrevision: 1\nowns: [runtime]\n---\n');
      execFileSync('git', ['add', '--', file], { cwd: root });
      expect(auditRepo(root).errors).toContainEqual(expect.stringContaining(file));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('разрешает продуктовый справочник о runtime-планах и текстовые данные', () => {
    const { root } = workspace();
    try {
      mkdirSync(join(root, 'docs/contracts/plans'), { recursive: true });
      writeFileSync(join(root, 'docs/contracts/plans/runtime.md'), '# Runtime plans\nA compiled trajectory.\n');
      writeFileSync(join(root, 'test/samples.txt'), '0 1 2\n');
      execFileSync('git', ['add', '--', 'docs', 'test'], { cwd: root });
      expect(auditRepo(root).errors).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe('Границы синтаксического инвентаря', () => {
  it('отклоняет повреждённый исходник вместо частичного AST', () => {
    const { root } = workspace();
    try {
      writeFileSync(join(root, 'src/motion/index.ts'), 'const value = "unfinished');
      expect(() => auditRepo(root)).toThrow(/source|index.ts|literal/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('не включает незакоммиченный отчёт измерения в документацию продукта', () => {
    const { root } = workspace();
    try {
      writeFileSync(join(root, 'docs/local-measurement.md'), '**Status:** COMPLETE\n**Branch:** experiment\n');
      expect(auditRepo(root).errors).toEqual([]);
      execFileSync('git', ['add', '--', 'docs/local-measurement.md'], { cwd: root });
      expect(auditRepo(root).errors).toContainEqual(expect.stringContaining('docs/local-measurement.md'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
