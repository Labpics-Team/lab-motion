/** Исходные модули, публичные субпути и CSS-литералы для проверки документации. */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

/** Канонический реестр фреймворк-биндингов (имя фреймворка = имя субпути). */
export const BINDINGS = [
  'angular',
  'lit',
  'preact',
  'qwik',
  'react',
  'solid',
  'svelte',
  'vue',
  'wc',
];

/** Генерируемое/чужое — не инвентарь. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'reports', '.stryker-tmp']);

/** Полный обход объявленного корня; недоступное дерево не означает пустое. */
export function walk(dir) {
  const files = [];
  function visit(directory) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error('symlink in source tree: ' + directory);
    if (!info.isDirectory()) throw new Error('not a source directory: ' + directory);
    for (const name of readdirSync(directory).sort()) {
      const filename = join(directory, name);
      const entry = lstatSync(filename);
      if (entry.isSymbolicLink()) throw new Error('symlink in source tree: ' + filename);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(filename);
      } else if (entry.isFile()) {
        files.push(relative(dir, filename).replaceAll('\\', '/'));
      } else {
        throw new Error('not a regular source file: ' + filename);
      }
    }
  }
  visit(dir);
  return files.sort();
}

/** Синтаксические литералы: URL, escapes и комментарии разбирает TypeScript. */
export function stringLiterals(code, filename = 'source.ts') {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, false);
  // The pinned compiler exposes parse diagnostics before type checking.
  // A recovered, malformed AST must not certify absence of a CSS literal.
  for (const diagnostic of source.parseDiagnostics) {
    throw new Error(filename + ': ' + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  const literals = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    if (ts.isTemplateExpression(node)) {
      literals.push(node.head.text);
      for (const span of node.templateSpans) literals.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return literals;
}

/** Экспорт-субпути из package.json: ['.', './a11y', …]. */
export function exportSubpaths(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.keys(pkg.exports ?? {}).sort();
}

/**
 * Литералы CSS-кастом-свойств в src.
 * @returns {{ name: string, files: string[] }[]} уникальные имена + где встречены.
 */
export function cssVarLiterals(root = ROOT) {
  const byName = new Map();
  const src = join(root, 'src');
  for (const f of walk(src)) {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(f)) continue;
    const code = readFileSync(join(src, f), 'utf8');
    for (const lit of stringLiterals(code, f)) {
      for (const m of lit.matchAll(/(?<![\w-])--[a-z][\w-]*/g)) {
        const name = m[0];
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name).add(`src/${f}`);
      }
    }
  }
  return [...byName.entries()]
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Файлы src|test|scripts|docs вне закона имён.
 * Закон: kebab-case стема; докам-канонам в docs/*.md разрешён КАПС-стем
 * (например, `NAMING.md` и `RELEASES.md`).
 */
export function nonKebabFiles(root = ROOT) {
  const bad = [];
  for (const top of ['src', 'test', 'scripts', 'docs']) {
    for (const f of walk(join(root, top))) {
      const base = f.split('/').pop();
      const stem = base.replace(/\.[^.]+(\.[^.]+)?$/, '');
      const law =
        top === 'docs' && base.endsWith('.md')
          ? /^([a-z0-9]+(-[a-z0-9]+)*|[A-Z]+(-[A-Z]+)*)$/
          : /^[a-z0-9]+(-[a-z0-9]+)*$/;
      if (!law.test(stem)) bad.push(`${top}/${f}`);
    }
  }
  return bad.sort();
}

/** Полный инвентарь одним объектом (факты для доки и гейта). */
export function collectInventory(root = ROOT) {
  const subpaths = exportSubpaths(root);
  const bindings = BINDINGS.filter((b) => subpaths.includes(`./${b}`));
  const cssVars = cssVarLiterals(root);
  const labMotionVars = cssVars.filter((v) => v.name.startsWith('--lab-motion-'));
  const alienVars = cssVars.filter((v) => !v.name.startsWith('--lab-motion-'));
  const nonKebab = nonKebabFiles(root);
  return { subpaths, bindings, cssVars, labMotionVars, alienVars, nonKebab };
}

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCLI) {
  const inv = collectInventory(ROOT);
  console.info(
    `naming-inventory: субпутей ${inv.subpaths.length}, ` +
      `биндингов ${inv.bindings.length}, ` +
      `литералов --lab-motion-* ${inv.labMotionVars.length}, ` +
      `вне --lab-motion-* ${inv.alienVars.length}, ` +
      `файлов вне kebab ${inv.nonKebab.length}`,
  );
  console.info(JSON.stringify(inv, null, 2));
}
