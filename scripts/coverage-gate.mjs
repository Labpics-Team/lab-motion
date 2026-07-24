/**
 * scripts/coverage-gate.mjs — ратчет покрытия по областям src/.
 *
 * ЗАЧЕМ. Сьюта из ~3900 тестов может быть зелёной и при этом НЕ ЗАХОДИТЬ в
 * ветку: тест, который не исполняет код, зелёный при любом его содержимом.
 * Ровно так прошли мимо сьюты дефекты стирания фасада (#240): finish-хвост не
 * исполнялся, потому что тестовый двойник не отдаёт addEventListener, а ветка
 * чтения computed-стиля — потому что окружение vitest 'node' не имеет
 * getComputedStyle. Гейта покрытия в CI не было вовсе, поэтому «эта ветка ни
 * разу не исполнялась» никто не произносил вслух.
 *
 * ЗАКОН (тот же, что у scripts/size-gate.mjs, но зеркальный по направлению):
 * - порог каждой области — ПОЛ, взятый от факта первой фиксации минус люфт;
 * - пол НЕ понижается ради прохождения CI; понижение требует явного решения
 *   владельца с хронологией в комментарии рядом с числом;
 * - после улучшений пол ЗАТЯГИВАЕТСЯ ВВЕРХ к новому факту (фиксация выигрыша);
 * - файл с исполнимыми строками и НУЛЕВЫМ покрытием — всегда FAIL, независимо
 *   от процентов области: это и есть детектор «код приехал, тестов нет».
 *
 * Гейт читает coverage/coverage-summary.json, который производит `pnpm coverage`
 * (v8-провайдер, тот же единственный прогон сьюты — второй прогон не нужен).
 *
 * Запуск: pnpm coverage && pnpm coverage:gate
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUMMARY = resolve(__dirname, '../coverage/coverage-summary.json');

/**
 * Полы покрытия по областям (проценты). Хронология — рядом с числом.
 *
 * 2026-07-24 (первая фиксация): значения взяты ОТ ФАКТА текущей сьюты минус
 * люфт 0.75 п.п. Люфт нужен, потому что покрытие меняется от любой правки
 * ветвления, а не только от потери теста; при этом он вдесятеро меньше
 * типичной потери от «забыли покрыть новый путь».
 */
const AREA_FLOORS = {
  a11y: { lines: 82.9, branches: 85.5 },
  angular: { lines: 99.2, branches: 99.2 },
  animate: { lines: 96.6, branches: 90.6 },
  auto: { lines: 92.7, branches: 81.7 },
  behaviors: { lines: 95.8, branches: 83.0 },
  compiler: { lines: 94.0, branches: 89.0 },
  compositor: { lines: 96.8, branches: 90.5 },
  // decay/driver — реэкспорты без исполнимых строк: пол держит сам факт
  // отсутствия кода, а не проценты (появится код — появится и покрытие).
  decay: { lines: 99.2, branches: 99.2 },
  driver: { lines: 99.2, branches: 99.2 },
  easing: { lines: 99.2, branches: 99.2 },
  flip: { lines: 93.0, branches: 90.4 },
  frame: { lines: 99.2, branches: 97.3 },
  gestures: { lines: 95.1, branches: 88.1 },
  'in-view': { lines: 89.1, branches: 85.3 },
  internal: { lines: 97.5, branches: 92.0 },
  keyframes: { lines: 98.3, branches: 94.4 },
  // lit: пол калиброван по CI, а не по локали. Локальный факт ветвей 88.46 %
  // (23/26), в CI — 84.62 % (22/26): ОДНА ветвь исполняется на Node 22 и не
  // исполняется на Node 24 (CI). Авторитетна среда CI; расхождение записано
  // как долг — найти ветвь и покрыть её явно, после чего затянуть пол вверх.
  lit: { lines: 95.0, branches: 83.9 },
  nano: { lines: 97.3, branches: 96.4 },
  preact: { lines: 99.2, branches: 99.2 },
  presence: { lines: 94.9, branches: 87.6 },
  presets: { lines: 96.6, branches: 92.9 },
  projection: { lines: 92.6, branches: 84.4 },
  qwik: { lines: 99.2, branches: 90.9 },
  react: { lines: 97.0, branches: 88.3 },
  root: { lines: 97.9, branches: 89.3 },
  scroll: { lines: 99.2, branches: 92.4 },
  smart: { lines: 94.8, branches: 86.2 },
  solid: { lines: 99.2, branches: 99.2 },
  spring: { lines: 99.2, branches: 96.7 },
  stagger: { lines: 99.2, branches: 99.2 },
  svelte: { lines: 99.2, branches: 99.2 },
  svg: { lines: 98.0, branches: 82.8 },
  'svg-morph': { lines: 98.0, branches: 93.5 },
  timeline: { lines: 83.2, branches: 70.1 },
  tokens: { lines: 99.2, branches: 94.2 },
  utils: { lines: 99.2, branches: 99.2 },
  value: { lines: 98.8, branches: 97.6 },
  vue: { lines: 98.0, branches: 89.4 },
  waapi: { lines: 98.3, branches: 97.8 },
  wc: { lines: 99.2, branches: 92.7 },
};

/** Общий пол по пакету — страховка от размазанной деградации по мелочи. */
const TOTAL_FLOORS = { lines: 95.7, branches: 89.3, functions: 96.0 };

/** Насколько факт должен обгонять пол, чтобы гейт попросил его затянуть. */
const TIGHTEN_HINT_PP = 1.5;

export function areaOf(path) {
  const rel = path.split('/src/')[1] ?? path;
  return rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : 'root';
}

/**
 * Чистое ядро гейта: сводка покрытия + таблицы полов → строки отчёта, список
 * провалов и подсказки на затяжку. Отделено от main ради тестируемости
 * (пин: test/coverage-gate.test.ts) — сам main только читает файл и печатает.
 */
export function evaluateCoverage(summary, areaFloors = AREA_FLOORS, totalFloors = TOTAL_FLOORS) {
  const areas = new Map();
  const uncovered = [];
  for (const [path, metrics] of Object.entries(summary)) {
    if (path === 'total') continue;
    const area = areaOf(path);
    const acc = areas.get(area) ?? { lines: [0, 0], branches: [0, 0], files: 0 };
    for (const key of ['lines', 'branches']) {
      acc[key][0] += metrics[key].covered;
      acc[key][1] += metrics[key].total;
    }
    acc.files++;
    areas.set(area, acc);
    // Детектор «код приехал, тестов нет»: исполнимые строки есть, покрытия нет.
    if (metrics.lines.total > 0 && metrics.lines.covered === 0) {
      uncovered.push(path.split('/src/')[1] ?? path);
    }
  }

  const pct = ([covered, total]) => (total === 0 ? 100 : (covered / total) * 100);
  const rows = [];
  const failures = [];
  const tighten = [];

  for (const [area, acc] of [...areas].sort(([a], [b]) => a.localeCompare(b))) {
    const floor = areaFloors[area];
    const lines = pct(acc.lines);
    const branches = pct(acc.branches);
    if (!floor) {
      failures.push(`область «${area}» не имеет пола в AREA_FLOORS `
        + `(факт: строки ${lines.toFixed(2)}%, ветви ${branches.toFixed(2)}%) — впишите её`);
      continue;
    }
    const lineFail = lines + 1e-9 < floor.lines;
    const branchFail = branches + 1e-9 < floor.branches;
    rows.push({ area, lines, branches, floor, ok: !lineFail && !branchFail });
    if (lineFail) failures.push(`${area}: строки ${lines.toFixed(2)}% < пола ${floor.lines}%`);
    if (branchFail) failures.push(`${area}: ветви ${branches.toFixed(2)}% < пола ${floor.branches}%`);
    if (lines - floor.lines > TIGHTEN_HINT_PP || branches - floor.branches > TIGHTEN_HINT_PP) {
      tighten.push(`${area} → { lines: ${(lines - 0.75).toFixed(1)}, branches: ${(branches - 0.75).toFixed(1)} }`);
    }
  }

  const total = summary.total;
  for (const key of ['lines', 'branches', 'functions']) {
    if (total[key].pct + 1e-9 < totalFloors[key]) {
      failures.push(`ИТОГО ${key}: ${total[key].pct.toFixed(2)}% < пола ${totalFloors[key]}%`);
    }
  }
  if (uncovered.length > 0) {
    failures.push(`${uncovered.length} файл(ов) не исполняются ни одним тестом`);
  }
  return { rows, failures, tighten, uncovered, total };
}

function main() {
  let summary;
  try {
    summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
  } catch {
    console.error(`coverage-gate: FAIL — нет ${SUMMARY}; сначала выполните pnpm coverage`);
    process.exit(1);
  }

  const { rows, failures, tighten, uncovered, total } = evaluateCoverage(summary);

  console.log('покрытие по областям src/ (пол — ратчет, движется только вверх)');
  for (const row of rows) {
    console.log(
      `  ${row.area.padEnd(12)} строки ${row.lines.toFixed(2).padStart(6)}% (пол ${row.floor.lines})`
      + `  ветви ${row.branches.toFixed(2).padStart(6)}% (пол ${row.floor.branches})`
      + `  ${row.ok ? 'OK' : 'РЕГРЕССИЯ'}`,
    );
  }
  console.log(
    `  ИТОГО        строки ${total.lines.pct.toFixed(2)}% (пол ${TOTAL_FLOORS.lines})`
    + `  ветви ${total.branches.pct.toFixed(2)}% (пол ${TOTAL_FLOORS.branches})`
    + `  функции ${total.functions.pct.toFixed(2)}% (пол ${TOTAL_FLOORS.functions})`,
  );

  if (uncovered.length > 0) {
    console.error('\ncoverage-gate: файлы с исполнимым кодом и НУЛЕВЫМ покрытием:');
    for (const file of uncovered) console.error(`  - ${file}`);
  }
  if (tighten.length > 0) {
    console.log(`\nфакт обогнал пол больше чем на ${TIGHTEN_HINT_PP} п.п. — затяните ратчет:`);
    for (const line of tighten) console.log(`  ${line}`);
  }

  if (failures.length > 0) {
    console.error('\ncoverage-gate: FAIL');
    for (const line of failures) console.error(`  - ${line}`);
    console.error('\nПол покрытия НЕ понижается ради прохождения CI: либо покройте путь тестом,');
    console.error('либо получите явное решение владельца и впишите хронологию рядом с числом.');
    process.exit(1);
  }
  console.log('\ncoverage-gate: PASS');
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
