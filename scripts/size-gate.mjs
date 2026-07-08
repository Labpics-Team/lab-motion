/**
 * size-gate.mjs — размерный гейт @labpics/motion
 *
 * Две метрики, обе жёсткие (превышение или отсутствующий dist-файл → exit 1):
 *
 * 1. ШИПНУТЫЙ вес: gz каждого ESM-subpath в dist/ (что качает CDN/raw-потребитель).
 *    Список subpath-точек выводится АВТОМАТИЧЕСКИ из package.json → "exports".
 *    Порог несёт только ядро (".").
 *
 * 2. СЦЕНАРНЫЙ import-cost: сколько gz реально платит npm-потребитель за
 *    типовой импорт — esbuild bundle+minify против dist (ровно то, что сделает
 *    его бандлер). Это главный потребительский гейт: он ловит и регрессию
 *    tree-shakeability (раздутый сценарий при неизменном шипнутом весе), и
 *    совокупное раздувание — поэтому отдельного «full-bundle»-гейта нет.
 *    Заземление 2026-07-02: шипнутый terser-минифицированный dist трясётся
 *    esbuild'ом ЛУЧШЕ неминифицированного во всех сценариях (856 vs 873 /
 *    1536 vs 1701 / 2173 vs 2350 gz) — mangle /^_/ даёт выигрыш, который
 *    бандлер потребителя сам не получит; двойной dist не нужен.
 *
 * Пороги — РЕГРЕССИОННЫЕ потолки (факт + люфт на шум минификаторов), не цели;
 * не поднимать без явного решения Даниила.
 *
 * Использование:
 *   node scripts/size-gate.mjs
 *   pnpm size
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Порог (в байтах) для ядра пакета (".") — фактический вес после s09 = ~2090 gz
// + небольшой люфт. Дожимание до 2048 отменено решением Даниила 2026-07-02:
// за размер браться только при перспективе кратного (~2×) выигрыша,
// не ради добивания круглой цифры.
// 2150 → 2190 (2026-07-03): +~80 gz — clamp:false (честный overshoot в 4
// драйверах) + выведенный settle-бюджет валидатора взамен коробочных полов.
// Подъём в рамках полной делегации Даниила на автономные решения
// («каждый следующий шаг решай автономно»); дешёвые шейвы сняты до подъёма.
export const CORE_GATE_BYTES = 2190;

// Потолок для КАЖДОГО прочего субпутя (drift-класс: новый/раздутый субпуть
// не должен молча проходить без порога). Максимальный факт 2026-07-02 —
// ./presets 4004 gz; люфт ~15%. Точечные пороги при нужде задаются в
// deriveEntriesFromExports, этот — общая страховка от грубого раздувания.
export const SUBPATH_GATE_BYTES = 4608;

// Точечные (bespoke) пороги субпутей — жёстче общего SUBPATH_GATE_BYTES там, где
// это осмысленно. ./utils — семь чистых скалярных примитивов + сегментный движок;
// факт после первой сборки 1197 gz, люфт ~15%. Отдельный порог не даёт будущему
// раздуванию прятаться под щедрым общим зонтом 4608 (тот же класс, что ловит
// CORE_GATE_BYTES для ядра). Поднимать только осознанно.
export const BESPOKE_SUBPATH_GATES = {
  './utils': 1400,
  // ./compositor — компилятор пружина→linear() (сегментер + LRU-кэш + контроллер)
  // + C¹-хендофф compositor→live (M2) + COMPOSITED STAGGER (M3).
  // Хронология факта/порога:
  //   M1: 4408 / 4600 — компилятор + сегментер + LRU + CompositorSpring.
  //   M2: 4672 / 4800 — живой мост в rAF-пружину (handoffToLive).
  //   M3: 5919 / 6100 — composited stagger. НЕИЗБЕЖНЫЙ рост на новую capability:
  //       (а) compileStaggerPlan — чистый планировщик (общий план + per-element
  //           задержки из ./stagger); (б) CompositorStaggerGroup — контроллер группы
  //           (N CompositorSpring, per-group каскад, per-element retarget/handoff);
  //       (в) delay + setTimer в CompositorSpring (нативный WAAPI-delay на compositor-
  //           пути, отложенный старт на fallback). Рост +1247 gz на весь слой каскада.
  //       Порог 6100 = факт 5919 + ~3% люфт (дисциплина M1/M2 сохранена; ./stagger
  //       переиспользуется, не дублируется). Жёстче общего 4608. Поднимать только решением Даниила.
  './compositor': 6100,
  // ./tokens — motion-токены (M3): duration/easing/spring/staggerGap + distanceScale.
  // Чистые данные + 4 cubic-bezier (тянут ../easing.cubicBezier) + одна функция.
  // Факт 1117 gz (весь субпуть). Порог 1250 (~12% люфт, как у ./utils). Гарантия —
  // СУБПУТЬ-изоляция (sideEffects:false): не импортишь ./tokens = ноль, ядро не
  // растёт (full-core сценарий это и стережёт). Внутри субпутя семейства в
  // минифициров. dist по отдельности не шейкаются; целиком дёшев. Поднимать осознанно.
  './tokens': 1250,
};

/**
 * Потребительские сценарии: код — то, что реально пишет потребитель;
 * gate — потолок от замера 2026-07-02 (+~4% люфт). `%DIST%` подставляется
 * абсолютным путём dist/index.js.
 */
export const IMPORT_COST_SCENARIOS = [
  {
    name: 'only-spring',
    code: `import { spring } from '%DIST%'; console.log(spring({mass:1,stiffness:200,damping:20}, 0.1).value);`,
    gate: 900, // факт 893 (2026-07-03; было 856 — выведенный settle-бюджет валидатора)
  },
  {
    name: 'only-MotionValue',
    code: `import { MotionValue } from '%DIST%'; const m = new MotionValue({initial:0, spring:{mass:1,stiffness:200,damping:20}}); m.onChange(v=>console.log(v)); m.setTarget(1);`,
    // 1600→1620 (M2): +~14 gz за opts.initialVelocity — засев скорости рождения,
    // НЕОБХОДИМЫЙ для C¹-хендоффа compositor→live (нет иного публичного seam'а;
    // дублировать rAF-цикл MotionValue в handoff = запрещённый coupled-дубль). Факт 1606.
    gate: 1620, // факт 1592 (2026-07-03) → 1606 (2026-07-08, initialVelocity)
  },
  {
    name: 'full-core',
    code: `import * as M from '%DIST%'; console.log(Object.keys(M).length, M.spring({mass:1,stiffness:200,damping:20},0.1).value);`,
    // 2250 → 2290 (2026-07-03): +48 gz — цена ДВУХ фич волны clamp:false
    // (честный overshoot во всех 4 драйверах) и замены коробочных полов
    // валидатора выведенным settle-бюджетом (settleTimeUpperBound). Подъём
    // сделан в рамках полной делегации Даниила на автономные решения
    // (2026-07-03, «каждый следующий шаг решай автономно»); дешёвые шейвы
    // уже сняты (−15 gz: √(km)=m·ω₀, дедуп √(ζ²−1), сжатие сообщения).
    // Люфт прежний ~1.5% от факта 2254.
    gate: 2290,
  },
  {
    // Один скалярный примитив из ./utils обязан трястись до горстки байт — это
    // страж tree-shakeability субпутя: если clamp случайно потянет сегментный
    // движок interpolate или соседей, сценарий скакнёт с ~300 до ~1200 gz.
    // Путь до субпутя выводится из %DIST% (dist/index.js) через sibling-нормализацию
    // index.js/../utils/index.js → dist/utils/index.js — инвариант «%DIST% в каждом
    // сценарии» сохранён.
    name: 'only-clamp (utils tree-shake)',
    code: `import { clamp } from '%DIST%/../utils/index.js'; console.log(clamp(0,1,2));`,
    gate: 340, // факт 308 (2026-07-07, первая сборка ./utils); люфт ~10%
  },
];

/**
 * Меряет один сценарий: esbuild stdin (без временных файлов) → minify ESM →
 * gz level-9. Ошибка сборки (пропавший экспорт, битый dist) НЕ маскируется —
 * возвращается error, гейт падает громко.
 */
export async function measureScenario(scenario, distIndexPath) {
  // Прямые слэши: esbuild принимает абсолютный путь как спецификатор,
  // но не file://-URL; бэкслэши Windows ломают парсинг строки-импорта.
  const code = scenario.code.replaceAll('%DIST%', distIndexPath.replace(/\\/g, '/'));
  try {
    const result = await build({
      stdin: { contents: code, resolveDir: dirname(distIndexPath), loader: 'js' },
      bundle: true,
      minify: true,
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });
    const out = result.outputFiles[0].contents;
    return { name: scenario.name, gzBytes: gzipSync(out, { level: 9 }).length, rawBytes: out.length, gate: scenario.gate };
  } catch (err) {
    return { name: scenario.name, error: String(err?.message ?? err).split('\n')[0], gate: scenario.gate };
  }
}

/**
 * Рекурсивно достаёт СТРОКОВЫЙ путь из conditional-exports значения.
 * package.json "exports" допускает произвольную вложенность условий
 * (например `{ import: { types, default } }`), поэтому просто `value.import`
 * не гарантированно строка — нужно спускаться, пока не найдётся строка.
 * Возвращает null, если строкового пути нет (вместо падения с TypeError).
 */
function resolveImportString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const nested = value.import ?? value.default;
    if (nested !== undefined) return resolveImportString(nested);
  }
  return null;
}

/**
 * Выводит список { key, label, importPath, gate } из package.json → exports.
 * Работает с любой формой exports-значения: строка, conditional-объект с
 * полем "import"/"default", включая произвольно вложенные условия. Чистая
 * функция — без чтения диска и без побочных эффектов, что делает её
 * напрямую юнит-тестируемой без сборки dist/.
 */
export function deriveEntriesFromExports(pkg) {
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object') {
    throw new Error('package.json: поле "exports" отсутствует или не объект — размерный гейт не может вывести subpath-точки');
  }

  return Object.entries(exportsField)
    .map(([key, value]) => {
      const importPath = resolveImportString(value);
      if (!importPath) return null;
      const label = key === '.' ? 'core (index)' : key.replace(/^\.\//, '');
      return {
        key,
        label,
        importPath: importPath.replace(/^\.\//, ''),
        gate:
          key === '.'
            ? CORE_GATE_BYTES
            : (BESPOKE_SUBPATH_GATES[key] ?? SUBPATH_GATE_BYTES),
      };
    })
    .filter(Boolean);
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
    } catch (err) {
      hasWarnings = true;
      // Различаем "файла нет" (ожидаемо до сборки/для ещё-не-смерженных
      // subpath) от прочих ошибок (EACCES и т.п.), которые маскировать
      // нельзя — это реальный сбой окружения, не отсутствующий dist/.
      const reason = err?.code === 'ENOENT' ? 'MISSING' : `ERROR(${err?.code ?? err?.message ?? 'unknown'})`;
      return { label: entry.label, error: `${reason}: ${entry.importPath}` };
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

async function runCli() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(__dirname, '..');

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const entries = deriveEntriesFromExports(pkg);
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
РЕГРЕССИЯ РАЗМЕРА
-----------------
core (index) gz = ${(core.gzBytes / 1024).toFixed(2)} KB > порог ${(core.gate / 1024).toFixed(2)} KB.
  Ядро выросло относительно зафиксированного после s09 веса (~2.04 KB gz).
  Найди раздувший коммит/правку и убери причину — порог не поднимать
  без явного решения Даниила (это и есть класс, который гейт ловит).
`);
    }
  }

  // ─── сценарный import-cost (главный потребительский гейт) ───────────────

  console.log('\nimport-cost потребителя (esbuild bundle+minify+gz против dist)\n');
  const distIndexPath = resolve(ROOT, 'dist/index.js');
  for (const scenario of IMPORT_COST_SCENARIOS) {
    const m = await measureScenario(scenario, distIndexPath);
    if (m.error) {
      hasWarnings = true;
      console.log(pad(m.name, COL.label) + `  FAIL: ${m.error}`);
      continue;
    }
    const exceeded = m.gzBytes > m.gate;
    if (exceeded) hasWarnings = true;
    console.log(
      pad(m.name, COL.label) +
      lpad(`${m.gzBytes} B gz`, COL.gz) +
      `  ${exceeded ? `РЕГРЕССИЯ > ${m.gate} B (найди раздувший коммит; порог не поднимать без решения Даниила)` : `OK (порог ${m.gate})`}`
    );
  }

  // ─── итог ─────────────────────────────────────────────────────────────

  if (hasWarnings) {
    console.log('size-gate: FAIL (см. детали выше) — CI останавливается');
    process.exit(1);
  } else {
    console.log('size-gate: PASS');
  }
}

// Запускать CLI-вывод только когда файл выполняется напрямую (`node scripts/size-gate.mjs`),
// не при импорте функций в тестах.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().catch((err) => {
    // Сломанный замер не имеет права выглядеть зелёным.
    console.error('size-gate: внутренняя ошибка —', err);
    process.exit(1);
  });
}
