/** Сверяет названия исходников, экспорты и CSS-имена с их владельцами. */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BINDINGS, ROOT, collectInventory } from './naming-inventory.mjs';

/** Каждый публичный субпуть разрешается в исходный модуль. */
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

/** Зарегистрированные биндинги должны иметь публичные точки входа. */
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
  const declared = new Set(nonKebab);
  const errors = nonKebab
    .filter((file) => !section.includes(file))
    .map((file) => `файл вне соглашения об именах не указан в отступлениях: ${file}`);
  for (const [, file] of section.matchAll(/`((?:src|test|scripts|docs)\/[A-Za-z0-9_.\/-]+)`/g)) {
    if (!declared.has(file)) errors.push(`устаревшее отступление в документации: ${file}`);
  }
  return errors;
}


/** Отдельно рассматриваем поля документа и содержимое fenced-примеров. */
function proseOutsideFences(text) {
  const lines = [];
  let fence;
  for (const line of text.split('\n')) {
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = opening[1];
    } else {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/** Признаки рабочих записей; предметные планы исполнения остаются допустимы. */
export function workRecordReason(file, text) {
  const parts = file.split('/');
  if (parts.length > 1 && ['plans', 'handoffs', 'worklogs'].includes(parts[0].toLowerCase())) {
    return 'рабочий каталог';
  }
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  if (normalized.startsWith('---\n')) {
    const frontmatter = normalized.slice(4).split('\n---', 1)[0];
    const keys = new Set([...frontmatter.matchAll(/^([a-z][a-z_-]*):/gm)].map((match) => match[1]));
    if (['track', 'revision', 'owns'].every((key) => keys.has(key))) return 'план работы агента';
  }
  const fields = new Set([...proseOutsideFences(normalized).matchAll(/^\*\*([^*\n]+):\*\*/gm)]
    .map((match) => match[1].trim().toLowerCase()));
  if ((fields.has('status') && fields.has('branch'))
    || (fields.has('baseline sha') && fields.has('head at validation'))) return 'отчёт рабочей сессии';
  return undefined;
}

/** Проверка tracked-текстов не включает локальные результаты сборки и измерений. */
export function documentErrors(root = ROOT) {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  if (resolve(gitRoot) !== resolve(root)) throw new Error('inventory root differs from repository root');
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const errors = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const name of names) {
    if (!['.md', '.mdx', '.rst', '.txt'].includes(extname(name).toLowerCase())) continue;
    const filename = join(root, name);
    const entry = lstatSync(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not a regular document: ' + name);
    const text = decoder.decode(readFileSync(filename));
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text)) errors.push(name + ': скрытый управляющий символ');
    const reason = workRecordReason(name, text);
    if (reason) errors.push(name + ': ' + reason);
  }
  return errors;
}

export function auditRepo(root = ROOT) {
  const errors = documentErrors(root);
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
