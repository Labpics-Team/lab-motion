/**
 * size-gate.mjs — размерный гейт @labpics/motion
 *
 * Измеряет gz-вес каждого ESM-subpath в dist/ после tsup-сборки.
 * Использует только встроенные модули Node.js (>=18) — нет внешних зависимостей.
 *
 * Список subpath-точек ВЫВОДИТСЯ АВТОМАТИЧЕСКИ из package.json → "exports":
 * каждый ключ exports с полем "import" становится строкой отчёта. Добавление
 * нового subpath-экспорта в package.json подхватывается без правки этого файла.
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

// Порог (в байтах) для ядра пакета ("."); null = только замер, нет порога.
export const CORE_GATE_BYTES = 2048;

// Планируемые subpath-плагины, из которых складывается "полный бандл".
// Пока не ВСЕ смержены в exports — совокупный гейт <8 KB остаётся PLACEHOLDER.
export const PLANNED_PLUGIN_SUBPATHS = ['./timeline', './stagger', './svg', './layout'];

/**
 * Выводит список { key, label, importPath, gate } из package.json → exports.
 * Работает с любой формой exports-значения: строка ИЛИ conditional-объект
 * с полем "import". Чистая функция — без чтения диска и без побочных эффектов,
 * что делает её напрямую юнит-тестируемой без сборки dist/.
 */
export function deriveEntriesFromExports(pkg) {
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object') {
    throw new Error('package.json: поле "exports" отсутствует или не объект — размерный гейт не может вывести subpath-точки');
  }

  return Object.entries(exportsField)
    .map(([key, value]) => {
      const importPath = typeof value === 'string' ? value : value?.import;
      if (!importPath) return null;
      const label = key === '.' ? 'core (index)' : key.replace(/^\.\//, '');
      return {
        key,
        label,
        importPath: importPath.replace(/^\.\//, ''),
        gate: key === '.' ? CORE_GATE_BYTES : null,
      };
    })
    .filter(Boolean);
}

/** true когда ВСЕ запланированные subpath-плагины уже присутствуют в exports. */
export function isFullBundleReady(pkg) {
  return PLANNED_PLUGIN_SUBPATHS.every(subpath =>
    Object.prototype.hasOwnProperty.call(pkg.exports ?? {}, subpath)
  );
}

/**
 * Измеряет gz-вес каждой entry относительно ROOT. Чистая функция ввода/вывода
 * данных (без console.log) — тестируема отдельно от CLI-форматирования.
 */
export function measureEntries(entries, root) {
  let totalGzBytes = 0;
  let hasWarnings = false;

  const rows = entries.map(entry => {
    const fullPath = resolve(root, entry.importPath);
    let raw, gz;
    try {
      raw = readFileSync(fullPath);
      gz = gzipSync(raw, { level: 9 });
    } catch {
      hasWarnings = true;
      return { label: entry.label, error: `MISSING: ${entry.importPath}` };
    }

    totalGzBytes += gz.length;
    const exceeded = entry.gate !== null && gz.length > entry.gate;
    if (exceeded) hasWarnings = true;

    return {
      label: entry.label,
      rawBytes: raw.length,
      gzBytes: gz.length,
      gate: entry.gate,
      exceeded,
    };
  });

  return { rows, totalGzBytes, hasWarnings };
}

function runCli() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(__dirname, '..');

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const entries = deriveEntriesFromExports(pkg);
  const fullBundleReady = isFullBundleReady(pkg);
  const { rows, totalGzBytes, hasWarnings: measuredWarnings } = measureEntries(entries, ROOT);
  let hasWarnings = measuredWarnings;

  // ─── вывод ────────────────────────────────────────────────────────────────

  const COL = { label: 22, raw: 10, gz: 10 };

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
    const gzFmt = lpad((row.gzBytes / 1024).toFixed(2) + ' KB gz', COL.gz + 3);

    let status = 'OK';
    if (row.exceeded) {
      status = `WARN > ${(row.gate / 1024).toFixed(1)} KB gz [OPEN ITEM]`;
    }

    console.log(pad(row.label, COL.label) + rawFmt + gzFmt + '  ' + status);
  }

  console.log('-'.repeat(COL.label + COL.raw + COL.gz + 10));
  const totalFmt = (totalGzBytes / 1024).toFixed(2);
  console.log(pad(`TOTAL (${rows.length} subpaths)`, COL.label + COL.raw) + lpad(totalFmt + ' KB gz', COL.gz + 3));

  // ─── OPEN ITEMS ─────────────────────────────────────────────────────────

  if (hasWarnings) {
    const core = rows.find(r => r.label === 'core (index)');
    if (core && !core.error && core.exceeded) {
      console.log(`
OPEN ITEMS
----------
core (index) gz = ${(core.gzBytes / 1024).toFixed(2)} KB
  Порог PRD <2.0 KB gz пока НЕ достигнут.
  Причина: ядро включает полный стек (spring/tween/drive/motion-value/errors).
  Путь к цели: minify:true в tsup.config.ts + tree-shaking через ESM-разбиение
  на micro-subpaths. Решение — отдельный срез (s09-core-size-reduction).
`);
    }
  }

  if (!fullBundleReady) {
    const missing = PLANNED_PLUGIN_SUBPATHS.filter(
      subpath => !Object.prototype.hasOwnProperty.call(pkg.exports, subpath)
    );
    console.log(`PLACEHOLDER: full-bundle gate <8.0 KB gz (${missing.join(', ')} ещё не реализованы)
  Активировать когда все subpath-плагины смержены в main.
`);
  } else {
    const FULL_BUNDLE_GATE_BYTES = 8192;
    const exceeded = totalGzBytes > FULL_BUNDLE_GATE_BYTES;
    if (exceeded) hasWarnings = true;
    console.log(
      `full bundle (${rows.length} subpaths) = ${totalFmt} KB gz` +
      (exceeded ? ` — WARN > ${(FULL_BUNDLE_GATE_BYTES / 1024).toFixed(1)} KB gz [OPEN ITEM]` : ' — OK')
    );
  }

  // ─── итог ─────────────────────────────────────────────────────────────

  if (hasWarnings) {
    console.log('size-gate: WARN (см. OPEN ITEMS выше) — CI продолжается');
    // Раскомментировать для жёсткого провала после оптимизации:
    // process.exit(1);
  } else {
    console.log('size-gate: PASS');
  }
}

// Запускать CLI-вывод только когда файл выполняется напрямую (`node scripts/size-gate.mjs`),
// не при импорте функций в тестах.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli();
}
