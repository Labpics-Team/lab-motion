import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { distReady } from './support/dist-required.js';
import { CORE_GATE_BYTES } from '../scripts/size-gate.mjs';
import { canonicalGzip } from '../scripts/compression-oracle.mjs';

/**
 * Дымовой контракт поставки: ноль runtime-зависимостей и внешних импортов,
 * размер корневого ESM не обходит общий размерный эталон, обязательные экспорты
 * присутствуют в собранном артефакте.
 *
 * ОХВАТ (аудит 2026-07-25). До него «нет внешних импортов» проверялось на ОДНОМ
 * файле — dist/index.js — при 82 отгружаемых файлах и 41 субпути. То есть
 * публичное обещание «zero runtime dependencies» держалось на 1/82 поставки:
 * зависимость, приехавшая в любой другой субпуть (или в ЛЮБОЙ .cjs, которых
 * гейт не видел вовсе), проходила зелёной. Теперь сканируются все отгружаемые
 * файлы, обе формы модулей и все три формы ссылки (`from`, `import()`,
 * `require()`), а разрешены ровно две категории: объявленные peerDependencies
 * фреймворковых адаптеров и объявленный в package.json `imports` алиас #frame.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distRoot = resolve(pkgRoot, 'dist');

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  imports?: Record<string, unknown>;
  name: string;
};

/** Все отгружаемые исполняемые файлы (ESM + CJS), а не один корневой. */
function shippedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs)$/.test(p)) out.push(p);
    }
  };
  walk(distRoot);
  return out;
}

/** Не-относительные спецификаторы файла: `from`, `import()`, `require()`. */
function externalSpecifiers(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /from\s*["']([^./"'][^"']*)/g,
    /import\s*\(\s*["']([^./"'][^"']*)/g,
    /require\s*\(\s*["']([^./"'][^"']*)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.push(m[1] ?? '');
  }
  return found;
}

/** Lazily read dist/index.js inside each test body that needs it.
 *  Top-level readFileSync would throw ENOENT on a clean checkout before `pnpm build`. */
function readDist(): string {
  return readFileSync(resolve(pkgRoot, 'dist/index.js'), 'utf8');
}

describe.runIf(distReady())('zero-dep + bundle-size smoke (invariant 1)', () => {
  it('package.json has no runtime dependencies', () => {
    const deps = pkg.dependencies ?? {};
    expect(
      Object.keys(deps),
      `@labpics/motion must have zero runtime deps. Found: ${Object.keys(deps).join(', ')}`,
    ).toHaveLength(0);
  });

  it('НИ ОДИН отгружаемый файл не тянет незаявленный внешний модуль', () => {
    // Разрешено ровно две категории. Всё остальное — либо забытая зависимость,
    // либо необъявленный peer: и то и другое ломает установку у потребителя.
    const allowed = new Set([
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.imports ?? {}),
    ]);
    const violations: string[] = [];
    for (const file of shippedFiles()) {
      for (const spec of externalSpecifiers(readFileSync(file, 'utf8'))) {
        // Подпуть пира ('preact/hooks') разрешён вместе с самим пиром.
        const root = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0]!;
        if (allowed.has(spec) || allowed.has(root)) continue;
        violations.push(`${relative(pkgRoot, file)} → ${spec}`);
      }
    }
    expect(violations, `незаявленные внешние модули:\n${violations.join('\n')}`)
      .toEqual([]);
  });

  it('ядро (всё, кроме фреймворковых адаптеров) не тянет НИЧЕГО внешнего', () => {
    // Пиры законны только у адаптеров. Если внешний модуль появится в ./animate,
    // ./compositor, ./nano и т.д. — это уже не «peer фреймворка», а зависимость
    // ядра, и обещание «zero runtime dependencies» перестаёт быть правдой.
    const ADAPTERS = /^dist\/(react|preact|vue|svelte|solid|lit|angular|qwik|wc)\//;
    const aliases = new Set(Object.keys(pkg.imports ?? {}));
    const violations: string[] = [];
    for (const file of shippedFiles()) {
      const rel = relative(pkgRoot, file).replaceAll('\\', '/');
      if (ADAPTERS.test(rel)) continue;
      for (const spec of externalSpecifiers(readFileSync(file, 'utf8'))) {
        if (aliases.has(spec)) continue; // #frame — внутренний алиас поставки
        violations.push(`${rel} → ${spec}`);
      }
    }
    expect(violations, `ядро тянет внешнее:\n${violations.join('\n')}`).toEqual([]);
  });

  it('охват гейта покрывает всю поставку, а не один файл (страж самого гейта)', () => {
    // Пин на случай, если сборка перестанет класть часть выхода в dist/ либо
    // кто-то сузит обход: гейт без охвата зелен по построению и потому опасен.
    const files = shippedFiles();
    expect(files.length).toBeGreaterThanOrEqual(80);
    expect(files.filter((f) => f.endsWith('.cjs')).length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith('dist/index.js'))).toBe(true);
  });

  it('корневой ESM использует канонический gzip и единый CORE-порог', () => {
    const distJs = readDist();
    const gz = canonicalGzip(Buffer.from(distJs, 'utf8')).length;
    console.info(`[@labpics/motion] dist/index.js canonical gzip size: ${gz} bytes`);
    expect(gz).toBeLessThanOrEqual(CORE_GATE_BYTES);
  });

  it('dist/index.js exports the required engine names', () => {
    const distJs = readDist();
    // Разбираем обе формы именованных ESM-экспортов, чтобы не зависеть от выбора минификатора.
    const exportMatches = [...distJs.matchAll(/export\s*\{([^}]+)\}/g)];
    const exportedNames = exportMatches
      .flatMap((m) =>
        (m[1] ?? '').split(',').map(
          (s) =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop() ?? '',
        ),
      )
      .filter(Boolean);

    // Also catch `export function foo` and `export class Foo` and `export const foo`.
    const namedExports = [
      ...distJs.matchAll(/export\s+(?:function|class|const|let|var)\s+(\w+)/g),
    ].map((m) => m[1] ?? '');
    const allExported = new Set([...exportedNames, ...namedExports]);

    const REQUIRED = ['spring', 'tween', 'drive', 'MotionParamError'];
    const missing = REQUIRED.filter((name) => !allExported.has(name));
    expect(
      missing,
      `dist/index.js is missing required engine exports: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});
