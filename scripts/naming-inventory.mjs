#!/usr/bin/env node
/**
 * naming-inventory — фактический нейминг-инвентарь lab-motion.
 *
 * Роль: справка-скрипт и библиотека фактов ФС. Единственный источник фактов
 * для docs/NAMING.md и scripts/check-docs-drift.mjs (гейт импортирует отсюда,
 * чтобы дока и гейт сверялись с ОДНОЙ реальностью, а не с двумя копиями).
 *
 * Инвентарь:
 *   1. экспорт-субпути package.json (`.`, `./easing`, …) — публичный API;
 *   2. фреймворк-биндинги: канонический реестр BINDINGS ∩ субпути;
 *   3. литералы CSS-кастом-свойств в строках src (комментарии вырезаны,
 *      сканируются только строковые/шаблонные литералы — `--i` в коде не CSS);
 *   4. файлы src|test|scripts|docs вне kebab-закона имён.
 *
 * CLI: `node scripts/naming-inventory.mjs` — сводка + полный JSON.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** Рекурсивный список файлов (POSIX-пути относительно base). */
export function walk(dir, out = [], base = dir) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out, base);
    } else {
      out.push(relative(base, join(dir, e.name)).replaceAll('\\', '/'));
    }
  }
  return out;
}

/** Вырезает блочные и строчные комментарии: примеры в докстрингах — не факт. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Содержимое строковых и шаблонных литералов кода. */
export function stringLiterals(code) {
  const out = [];
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]);
  return out;
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
    if (!f.endsWith('.ts')) continue;
    const code = stripComments(readFileSync(join(src, f), 'utf8'));
    for (const lit of stringLiterals(code)) {
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
 * (`NAMING.md` — как в эталоне lab-icons).
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
