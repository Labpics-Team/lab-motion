/** Сверяет названия исходников, экспорты и CSS-имена с их владельцами. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BINDINGS, ROOT, collectInventory } from './naming-inventory.mjs';

// Публичный путь должен разрешаться в исходный модуль.
/** Каждый субпуть обязан разрешаться в исходник. */
export function subpathSrcErrors(subpaths, root = ROOT) {
  const errs = [];
  const packagePath = join(root, 'package.json');
  const manifest = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : undefined;
  for (const s of subpaths) {
    const name = s === '.' ? 'index' : s.slice(2);
    const target = manifest?.exports?.[s]?.import?.default;
    const mapped = typeof target === 'string' ? /^\.\/dist\/(.+)\.js$/.exec(target) : null;
    const candidates = mapped ? [join(root, 'src', `${mapped[1]}.ts`)]
      : s === '.' ? [join(root, 'src', 'index.ts')]
      : [join(root, 'src', name, 'index.ts'), join(root, 'src', `${name}.ts`)];
    if (!candidates.some((c) => existsSync(c))) {
      errs.push(`субпуть ${s} не разрешается в src (нет src/${name}/index.ts | src/${name}.ts)`);
    }
  }
  return errs;
}

// Зарегистрированные биндинги должны иметь публичные точки входа.

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
