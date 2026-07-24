#!/usr/bin/env node
/**
 * check-docs-examples.mjs — компиляционный смоук примеров документации (#91).
 *
 * КОНВЕНЦИЯ ФЕНСОВ: ```typescript — ПОЛНЫЙ компилируемый пример (проверяется
 * здесь); ```ts — листинг сигнатуры/фрагмент (не компилируется). Каждый
 * ```typescript типочекается как САМОСТОЯТЕЛЬНЫЙ модуль против деклараций
 * свежего dist (paths-маппинг @labpics/motion/* → dist/*), strict + DOM.
 *
 * Пропускаются (с подсчётом в отчёте):
 *   - фенсы с импортами вне @labpics/motion (сниппеты «до» из миграций,
 *     фреймворк-примеры адаптеров) — их зависимости не являются частью пакета;
 *   - фенсы, помеченные <!-- docs-example: skip --> строкой непосредственно
 *     перед фенсом (осознанные фрагменты; используйте скупо).
 *
 * Выход ≠ 0 при любой ошибке компиляции проверяемого сниппета.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = resolve(ROOT, '.docs-examples-tmp');

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.name.endsWith('.md')) yield full;
  }
}

/** Извлекает ts-фенсы: [{page, line, code, skipMarked}]. */
export function extractSnippets(page, text) {
  const lines = text.split('\n');
  const snippets = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```(typescript)\s*$/);
    if (!open) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !lines[end].startsWith('```')) end++;
    const code = lines.slice(start, end).join('\n');
    const skipMarked = /<!--\s*docs-example:\s*skip\s*-->/.test(lines[i - 1] ?? '');
    snippets.push({ page, line: start + 1, code, skipMarked });
    i = end;
  }
  return snippets;
}

/** Импортирует ли сниппет что-то вне пакета (тогда смоук его пропускает). */
export function hasForeignImport(code) {
  const sources = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return sources.some(
    (s) => !s.startsWith('@labpics/motion') && !s.startsWith('.'),
  );
}

const pages = [...walkMarkdown(resolve(ROOT, 'docs'))];
const all = pages.flatMap((page) =>
  extractSnippets(relative(ROOT, page), readFileSync(page, 'utf8')),
);
const checked = all.filter((s) => !s.skipMarked && !hasForeignImport(s.code));
const skipped = all.length - checked.length;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const manifest = [];
checked.forEach((snippet, index) => {
  const file = `snippet-${index}.ts`;
  // Каждый сниппет — отдельный модуль; экспорт гасит «unused»-шум только на
  // уровне модуля, сам код обязан быть полным (все идентификаторы объявлены).
  writeFileSync(join(TMP, file), snippet.code + '\nexport {};\n');
  manifest.push({ file, page: snippet.page, line: snippet.line });
});

writeFileSync(
  join(TMP, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ['es2022', 'dom'],
        baseUrl: '.',
        paths: {
          '@labpics/motion': [relative(TMP, resolve(ROOT, 'dist/index.d.ts'))],
          '@labpics/motion/*': [relative(TMP, resolve(ROOT, 'dist/*/index.d.ts'))],
        },
      },
      include: ['snippet-*.ts'],
    },
    null,
    2,
  ),
);

if (!existsSync(resolve(ROOT, 'dist/index.d.ts'))) {
  console.error('check-docs-examples: dist отсутствует — сначала pnpm build');
  process.exit(1);
}

try {
  execFileSync(
    resolve(ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', TMP],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  console.log(
    `check-docs-examples: PASS — ${checked.length} сниппетов скомпилированы` +
      ` (${skipped} пропущено: чужие импорты/skip-маркер), страниц: ${pages.length}`,
  );
  rmSync(TMP, { recursive: true, force: true });
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  // Маппим snippet-N.ts обратно в страницу/строку для читаемого отчёта.
  let readable = output;
  for (const { file, page, line } of manifest) {
    readable = readable.replaceAll(file, `${page}:${line} [${file}]`);
  }
  console.error(readable);
  console.error(
    `check-docs-examples: FAIL — исправьте примеры (артефакты в ${relative(ROOT, TMP)})`,
  );
  process.exit(1);
}
