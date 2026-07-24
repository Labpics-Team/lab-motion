#!/usr/bin/env node
/**
 * api-manifest.mjs — машиночитаемый манифест публичного API (#96, первый срез).
 *
 * Источник правды — ФАКТЫ, не ручные копии:
 *   - субпути: package.json#exports (тот же deriveEntriesFromExports, что гейт);
 *   - runtime-экспорты: esbuild metafile против свежего dist (реальные байты
 *     npm-потребителя, SSR-safe импорт гарантирован инвариантом пакета);
 *   - размеры: measureEsmTransfer — тот же закон shipped-графа, что pnpm size;
 *   - назначение: H1-заголовок соответствующей страницы docs/reference.
 *
 * Выход:
 *   - api-manifest.json (schemaVersion 1; БЕЗ ревизии/времени — детерминизм и
 *     стабильность к коммитам; версия пакета присутствует);
 *   - llms.txt — краткая карта выбора API для агентов, генерируется из
 *     манифеста и заголовков доков (не поддерживается вручную).
 *
 * Проверка дрейфа: test/api-manifest.test.ts перегенерирует манифест в памяти
 * и сравнивает с закоммиченным байт-в-байт; каждый export-субпуть обязан быть
 * представлен ровно один раз; docs-страница обязана существовать и упоминать
 * субпуть. Числа размеров живут ТОЛЬКО в генерируемом артефакте (закон
 * docs/benchmark.md: Markdown чисел не хранит).
 */

import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEntriesFromExports, measureEsmTransfer } from './size-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Субпуть → страница справки. Дрейф ловит тест (существование + упоминание). */
export const DOCS_MAP = {
  '.': 'docs/reference/core.md',
  './spring': 'docs/reference/spring.md',
  './easing': 'docs/reference/easing.md',
  './value': 'docs/reference/value.md',
  './driver': 'docs/reference/driver-frame.md',
  './frame': 'docs/reference/driver-frame.md',
  './utils': 'docs/reference/utils.md',
  './tokens': 'docs/reference/tokens-presets.md',
  './presets': 'docs/reference/tokens-presets.md',
  './animate': 'docs/reference/animate.md',
  './nano': 'docs/reference/nano.md',
  './compiler/vite': 'docs/reference/compiler.md',
  './compiler/runtime': 'docs/reference/compiler.md',
  './compositor': 'docs/reference/compositor.md',
  './compositor/stagger': 'docs/reference/compositor.md',
  './waapi': 'docs/reference/compositor.md',
  './stagger': 'docs/reference/stagger.md',
  './timeline': 'docs/reference/timeline-keyframes.md',
  './keyframes': 'docs/reference/timeline-keyframes.md',
  './decay': 'docs/reference/decay.md',
  './scroll': 'docs/reference/scroll-in-view.md',
  './in-view': 'docs/reference/scroll-in-view.md',
  './gestures': 'docs/reference/gestures.md',
  './presence': 'docs/reference/presence.md',
  './flip': 'docs/reference/flip.md',
  './projection': 'docs/reference/projection.md',
  './smart': 'docs/reference/smart.md',
  './svg': 'docs/reference/svg.md',
  './svg-morph': 'docs/reference/svg.md',
  './a11y': 'docs/reference/a11y.md',
  './auto': 'docs/reference/auto.md',
  './behaviors': 'docs/reference/behaviors.md',
  './react': 'docs/reference/adapters.md',
  './vue': 'docs/reference/adapters.md',
  './svelte': 'docs/reference/adapters.md',
  './solid': 'docs/reference/adapters.md',
  './preact': 'docs/reference/adapters.md',
  './angular': 'docs/reference/adapters.md',
  './lit': 'docs/reference/adapters.md',
  './wc': 'docs/reference/adapters.md',
  './qwik': 'docs/reference/adapters.md',
};

/** H1 страницы (первая строка `# ...`) — назначение субпутя для llms.txt. */
export function docTitle(page) {
  const absolute = resolve(ROOT, page);
  if (!existsSync(absolute)) return undefined;
  const match = readFileSync(absolute, 'utf8').match(/^# (.+)$/m);
  return match?.[1];
}

/** Реальные runtime-экспорты entry: esbuild metafile, bare-импорты external. */
async function runtimeExports(importPath) {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [importPath],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    packages: 'external',
  });
  const outputs = Object.values(result.metafile.outputs);
  const entry = outputs.find((o) => o.entryPoint) ?? outputs[0];
  return [...entry.exports].sort();
}

/** Строит манифест целиком (чистая функция для drift-теста). */
export async function buildManifest() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const entries = deriveEntriesFromExports(pkg);
  const subpaths = [];
  for (const entry of entries) {
    const size = measureEsmTransfer(entry.importPath, ROOT);
    subpaths.push({
      subpath: entry.key,
      import: entry.key === '.' ? pkg.name : `${pkg.name}${entry.key.slice(1)}`,
      runtimeExports: await runtimeExports(entry.importPath),
      shippedGzBytes: size.gzBytes,
      shippedBrBytes: size.brBytes,
      docs: DOCS_MAP[entry.key],
      title: docTitle(DOCS_MAP[entry.key]),
    });
  }
  return {
    schemaVersion: 1,
    package: pkg.name,
    version: pkg.version,
    generatedBy: 'scripts/api-manifest.mjs',
    note:
      'Генерируется из package.json#exports, dist и docs/reference. ' +
      'Не редактировать вручную: pnpm manifest.',
    errorsCatalog: 'docs/errors.md',
    sizeMethodology: 'docs/benchmark.md',
    subpaths,
  };
}

/** llms.txt — краткая карта выбора API, из манифеста и заголовков доков. */
export function renderLlms(manifest) {
  const lines = [
    `# ${manifest.package} ${manifest.version}`,
    '',
    '> Zero-dependency headless motion: закрытая форма пружины, compositor-путь',
    '> (WAAPI + CSS linear()), build-time компилятор. Все единицы времени в',
    '> публичных опциях — МИЛЛИСЕКУНДЫ, если явно не сказано «секунды».',
    '',
    '## Быстрый выбор входа',
    '',
    '- Типовая DOM-анимация одной строкой → @labpics/motion/animate (animate(el, { x: 240, opacity: 1 }))',
    '- Минимальный вес, native WAAPI, to-only → @labpics/motion/nano',
    '- Статические вызовы без runtime-цены → плагин @labpics/motion/compiler/vite',
    '- Пружина из ощущений: fromBounce({ duration, bounce }) → @labpics/motion/spring',
    '- Каскады → @labpics/motion/stagger; жесты с инерцией → @labpics/motion/gestures',
    '',
    '## Субпути',
    '',
  ];
  for (const s of manifest.subpaths) {
    const title = s.title ? ` — ${s.title.replace(/^\.\/[\w/-]+ — /, '')}` : '';
    lines.push(`- ${s.import}${title}`);
    lines.push(`  exports: ${s.runtimeExports.join(', ') || '(type-only)'}`);
    if (s.docs) lines.push(`  docs: ${s.docs}`);
  }
  lines.push('', '## Дальше', '', '- Ошибки LMxxx: docs/errors.md', '- Методология размера/бенчей: docs/benchmark.md', '- Быстрый старт: docs/getting-started.md', '');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const manifest = await buildManifest();
  writeFileSync(
    resolve(ROOT, 'api-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  writeFileSync(resolve(ROOT, 'llms.txt'), renderLlms(manifest));
  console.log(
    `api-manifest: ${manifest.subpaths.length} субпутей → api-manifest.json + llms.txt`,
  );
}
