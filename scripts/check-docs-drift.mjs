#!/usr/bin/env node
/**
 * docs-drift guard для lab-motion (по образцу lab-icons feat/docs-drift-gate).
 *
 * Доки vs реальность — сверяет утверждения docs/NAMING.md с фактами ФС
 * (факты собирает scripts/naming-inventory.mjs, единый источник):
 *
 *   1. docs/NAMING.md существует и объявляет роль в первых 5 строках.
 *   2. Инвентарная таблица «сверяется гейтом»: числа в доке == факты ФС
 *      (субпути, биндинги, CSS-литералы, файлы вне kebab).
 *   3. Субпути двусторонне: каждый экспорт-субпуть упомянут в NAMING.md;
 *      каждое упоминание `./x` существует в package.json exports.
 *   4. Каждый субпуть разрешается в src: `.` → src/index.ts,
 *      `./x` → src/x/index.ts или src/x.ts (exports без кода запрещены).
 *   5. Число «N framework bindings» в description == канон-реестр BINDINGS,
 *      и каждый биндинг реально экспортируется.
 *   6. Закон префикса CSS: каждый литерал кастом-свойства в src вне
 *      `--lab-motion-*` перечислен в «Известных отступлениях», и наоборот.
 *   7. Файлы вне kebab-закона перечислены в «Известных отступлениях».
 *
 * Функции чистые и экспортируются — поведение проверяемо юнитами.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BINDINGS, ROOT, collectInventory } from './naming-inventory.mjs';

/* ------------------------------------------------------------------ *
 * 1. Роль дока                                                        *
 * ------------------------------------------------------------------ */

export function hasDocRole(text) {
  const head = text.split('\n').slice(0, 5).join('\n');
  return /(справка|ADR|канон|гайд|отчёт|роль:)/i.test(head);
}

/* ------------------------------------------------------------------ *
 * 2. Инвентарная таблица                                              *
 * ------------------------------------------------------------------ */

/** Строки `| метка | N |` из таблицы под заголовком «Инвентарь». */
export function extractInventoryTable(text) {
  const rows = new Map();
  for (const m of text.matchAll(/^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*$/gm)) {
    rows.set(m[1], Number(m[2]));
  }
  return rows;
}

/** Метрика доки → факт ФС; ключ ищется подстрокой в метке строки. */
export function inventoryTableErrors(rows, inv) {
  const expected = [
    ['экспорт-субпутей', inv.subpaths.length],
    ['фреймворк-биндингов', inv.bindings.length],
    ['`--lab-motion-*`', inv.labMotionVars.length],
    ['вне `--lab-motion-*`', inv.alienVars.length],
    ['вне kebab', inv.nonKebab.length],
  ];
  const errs = [];
  for (const [key, fact] of expected) {
    const row = [...rows.entries()].find(([label]) => label.includes(key));
    if (!row) {
      errs.push(`NAMING.md: в инвентарной таблице нет строки «${key}»`);
    } else if (row[1] !== fact) {
      errs.push(`NAMING.md: «${row[0]}» = ${row[1]}, факт ФС = ${fact}`);
    }
  }
  return errs;
}

/* ------------------------------------------------------------------ *
 * 3–4. Экспорт-субпути                                                *
 * ------------------------------------------------------------------ */

/** Бэктик-упоминания субпутей `./x` в доке. */
export function extractSubpathMentions(text) {
  return [...text.matchAll(/`(\.\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)`/g)].map((m) => m[1]);
}

export function subpathMentionErrors(text, subpaths) {
  const real = new Set(subpaths);
  const errs = [];
  for (const s of new Set(extractSubpathMentions(text))) {
    if (!real.has(s)) {
      errs.push(`NAMING.md упоминает несуществующий субпуть \`${s}\``);
    }
  }
  for (const s of subpaths) {
    if (s !== '.' && !text.includes(`\`${s}\``)) {
      errs.push(`экспорт-субпуть ${s} не упомянут в NAMING.md`);
    }
  }
  return errs;
}

/** Каждый субпуть обязан разрешаться в исходник. */
export function subpathSrcErrors(subpaths, root = ROOT) {
  const errs = [];
  for (const s of subpaths) {
    const name = s === '.' ? 'index' : s.slice(2);
    const candidates =
      s === '.'
        ? [join(root, 'src', 'index.ts')]
        : [join(root, 'src', name, 'index.ts'), join(root, 'src', `${name}.ts`)];
    if (!candidates.some((c) => existsSync(c))) {
      errs.push(`субпуть ${s} не разрешается в src (нет src/${name}/index.ts | src/${name}.ts)`);
    }
  }
  return errs;
}

/* ------------------------------------------------------------------ *
 * 5. Биндинги                                                         *
 * ------------------------------------------------------------------ */

export function bindingErrors(inv, root = ROOT) {
  const errs = [];
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const m = (pkg.description ?? '').match(/(\d+)\s+framework bindings/);
  if (!m) {
    errs.push('package.json description не заявляет «N framework bindings»');
  } else if (Number(m[1]) !== inv.bindings.length) {
    errs.push(
      `description заявляет ${m[1]} framework bindings, факт (BINDINGS ∩ exports) = ${inv.bindings.length}`,
    );
  }
  for (const b of BINDINGS) {
    if (!inv.subpaths.includes(`./${b}`)) {
      errs.push(`биндинг из канон-реестра не экспортируется: ./${b}`);
    }
  }
  return errs;
}

/* ------------------------------------------------------------------ *
 * 6–7. Известные отступления                                          *
 * ------------------------------------------------------------------ */

/** Текст раздела «Известные отступления» (до следующего `## `). */
export function deviationsSection(text) {
  const m = text.match(/^##[^\n]*Известные отступления[^\n]*\n([\s\S]*?)(?=^## |\n*$(?![\s\S]))/m);
  return m ? m[1] : '';
}

export function cssLawErrors(section, alienVars) {
  const errs = [];
  for (const v of alienVars) {
    if (!section.includes(`\`${v.name}\``)) {
      errs.push(
        `литерал ${v.name} (${v.files[0]}) вне --lab-motion-* не зафиксирован в «Известных отступлениях»`,
      );
    }
  }
  const declared = new Set(alienVars.map((v) => v.name));
  for (const m of section.matchAll(/`(--(?!lab-motion-)[a-z][\w-]*)`/g)) {
    if (!declared.has(m[1])) {
      errs.push(
        `«Известные отступления» перечисляют ${m[1]}, но в src такого литерала больше нет — убери из доки`,
      );
    }
  }
  return errs;
}

export function fileLawErrors(section, nonKebab) {
  return nonKebab
    .filter((f) => !section.includes(f))
    .map((f) => `файл вне закона имён не зафиксирован в «Известных отступлениях»: ${f}`);
}

/* ------------------------------------------------------------------ *
 * Аудит целиком                                                       *
 * ------------------------------------------------------------------ */

export function auditRepo(root = ROOT) {
  const errors = [];
  const namingPath = join(root, 'docs', 'NAMING.md');
  const inv = collectInventory(root);
  if (!existsSync(namingPath)) {
    return { errors: ['docs/NAMING.md отсутствует — канона нет'], inv };
  }
  const text = readFileSync(namingPath, 'utf8');

  if (!hasDocRole(text)) {
    errors.push('docs/NAMING.md: роль не объявлена в первых 5 строках');
  }
  errors.push(...inventoryTableErrors(extractInventoryTable(text), inv));
  errors.push(...subpathMentionErrors(text, inv.subpaths));
  errors.push(...subpathSrcErrors(inv.subpaths, root));
  errors.push(...bindingErrors(inv, root));
  const section = deviationsSection(text);
  if (!section) {
    errors.push('docs/NAMING.md: нет раздела «Известные отступления»');
  }
  errors.push(...cssLawErrors(section, inv.alienVars));
  errors.push(...fileLawErrors(section, inv.nonKebab));

  return { errors, inv };
}

/* ------------------------------------------------------------------ */

const isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCLI) {
  const { errors, inv } = auditRepo(ROOT);
  console.info(
    `check-docs-drift: факт ФС — субпутей ${inv.subpaths.length}, ` +
      `биндингов ${inv.bindings.length}, --lab-motion-* ${inv.labMotionVars.length}, ` +
      `вне --lab-motion-* ${inv.alienVars.length}, вне kebab ${inv.nonKebab.length}`,
  );
  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(`check-docs-drift: FAIL (${errors.length})`);
    process.exit(1);
  }
  console.info('check-docs-drift: PASS — доки совпадают с реальностью');
}
