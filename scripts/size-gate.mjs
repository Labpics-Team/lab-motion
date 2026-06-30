/**
 * size-gate.mjs — размерный гейт @labpics/motion
 *
 * Измеряет gz-вес каждого ESM-subpath в dist/ после tsup-сборки.
 * Использует только встроенные модули Node.js (>=18) — нет внешних зависимостей.
 *
 * Выход 0 (CI-green) всегда: гейт фиксирует базовые числа и ПРЕДУПРЕЖДАЕТ
 * при превышении порога, но не ломает CI пока не принято решение о минификации.
 * Если нужен жёсткий провал — раскомментируй `process.exit(1)` в конце.
 *
 * Использование:
 *   node scripts/size-gate.mjs
 *   pnpm size
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ESM-точки входа пакета (`.js` = ESM subpath, level-9 gzip)
const ENTRIES = [
  // gate = порог в байтах; null = только замер (нет порога)
  { label: 'core (index)',  path: 'dist/index.js',          gate: 2048 },
  { label: 'easing',       path: 'dist/easing/index.js',   gate: null },
  { label: 'react',        path: 'dist/react/index.js',    gate: null },
  { label: 'svelte',       path: 'dist/svelte/index.js',   gate: null },
  { label: 'vue',          path: 'dist/vue/index.js',      gate: null },
  { label: 'driver',       path: 'dist/driver/index.js',   gate: null },
];

// Совокупный гейт для "полного бандла" (<8 KB) — PLACEHOLDER:
// timeline / stagger / svg / layout ещё не реализованы, суммировать их пока нечего.
// Активировать когда все subpath-плагины смержены.
const FULL_BUNDLE_GATE_PLACEHOLDER = true;

// ─── замер ──────────────────────────────────────────────────────────────────

let totalGzBytes = 0;
let hasWarnings = false;

const rows = ENTRIES.map(entry => {
  const fullPath = resolve(ROOT, entry.path);
  let raw, gz;
  try {
    raw = readFileSync(fullPath);
    gz  = gzipSync(raw, { level: 9 });
  } catch {
    return { label: entry.label, error: `MISSING: ${entry.path}`, warn: true };
  }

  totalGzBytes += gz.length;
  const exceeded = entry.gate !== null && gz.length > entry.gate;
  if (exceeded) hasWarnings = true;

  return {
    label:    entry.label,
    rawBytes: raw.length,
    gzBytes:  gz.length,
    gate:     entry.gate,
    exceeded,
  };
});

// ─── вывод ──────────────────────────────────────────────────────────────────

const COL = { label: 22, raw: 10, gz: 10, status: 0 };

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log('\n@labpics/motion — bundle size (ESM, gzip level-9)\n');
console.log(
  pad('Entry', COL.label) +
  lpad('Raw', COL.raw) +
  lpad('GZ', COL.gz) +
  '  Status'
);
console.log('-'.repeat(COL.label + COL.raw + COL.gz + 10));

for (const row of rows) {
  if (row.error) {
    console.log(pad(row.label, COL.label) + '  ' + row.error);
    continue;
  }

  const rawFmt = lpad((row.rawBytes / 1024).toFixed(2) + ' KB', COL.raw);
  const gzFmt  = lpad((row.gzBytes  / 1024).toFixed(2) + ' KB gz', COL.gz + 3);

  let status = 'OK';
  if (row.exceeded) {
    status = `WARN > ${(row.gate / 1024).toFixed(1)} KB gz [OPEN ITEM]`;
  }

  console.log(pad(row.label, COL.label) + rawFmt + gzFmt + '  ' + status);
}

console.log('-'.repeat(COL.label + COL.raw + COL.gz + 10));
const totalFmt = (totalGzBytes / 1024).toFixed(2);
console.log(pad('TOTAL (текущие subpaths)', COL.label + COL.raw) + lpad(totalFmt + ' KB gz', COL.gz + 3));

// ─── OPEN ITEMS ──────────────────────────────────────────────────────────────

if (hasWarnings) {
  console.log(`
OPEN ITEMS
----------
core (index) gz = ${((rows.find(r => r.label === 'core (index)') || {}).gzBytes / 1024).toFixed(2)} KB
  Порог PRD <2.0 KB gz пока НЕ достигнут.
  Причина: ядро включает полный стек (spring/tween/drive/motion-value/errors).
  Путь к цели: minify:true в tsup.config.ts + tree-shaking через ESM-разбиение
  на micro-subpaths. Решение — отдельный срез (s09-core-size-reduction).
`);
}

if (FULL_BUNDLE_GATE_PLACEHOLDER) {
  console.log(`PLACEHOLDER: full-bundle gate <8.0 KB gz (timeline/stagger/svg/layout ещё не реализованы)
  Активировать когда все subpath-плагины смержены в main.
`);
}

// ─── итог ──────────────────────────────────────────────────────────────────

if (hasWarnings) {
  console.log('size-gate: WARN (см. OPEN ITEMS выше) — CI продолжается');
  // Раскомментировать для жёсткого провала после оптимизации:
  // process.exit(1);
} else {
  console.log('size-gate: PASS');
}
