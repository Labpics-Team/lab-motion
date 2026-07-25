/**
 * emit-declarations.mjs — по-файловый эмит деклараций через
 * ts.transpileDeclaration (без чекера): O(файла) по памяти, устраняет класс
 * heap-обрывов DTS-бандлинга. Верность гарантирована контрактом
 * `isolatedDeclarations` (tsconfig) + гейтом `pnpm typecheck`: каждый экспорт
 * аннотирован явно, поэтому одинокий файл транспилируется в тот же d.ts, что
 * выдал бы полный чекер.
 *
 * Формат ОДИН: <path>.d.ts. Парная эмиссия <path>.d.cts снята вместе с
 * CJS-веткой поставки (2026-07-25): пакет больше не возит одно и то же
 * дважды, а `require()` с Node 22.12 читает ESM сам и получает ТОТ ЖЕ
 * экземпляр модуля — то есть отдельные типы под require описывали бы файл,
 * которого нет.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

const SRC = 'src';
const OUT = 'dist';

const OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  verbatimModuleSyntax: false,
  isolatedDeclarations: true,
};


function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.name.endsWith('.ts')) yield file;
  }
}

let emitted = 0;
const failures = [];
for (const file of walk(SRC)) {
  const source = readFileSync(file, 'utf8');
  const result = ts.transpileDeclaration(source, {
    compilerOptions: OPTIONS,
    fileName: file,
    reportDiagnostics: true,
  });
  if (result.diagnostics !== undefined && result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics) {
      failures.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
    continue;
  }
  const declaration = result.outputText;
  if (declaration.trim() === '') {
    failures.push(`${file}: пустая декларация`);
    continue;
  }
  const base = join(OUT, relative(SRC, file)).replace(/\.ts$/, '');
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.d.ts`, declaration);
  emitted++;
}

if (failures.length > 0) {
  console.error('emit-declarations: FAIL');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log(`emit-declarations: OK — ${emitted} файлов (d.ts)`);
