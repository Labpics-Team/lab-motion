/**
 * scripts/size-floor.mjs — эмпирический size-floor субпутей (#243, пункт 2).
 *
 * Клейм: floor РЕФЕРЕНС-КОДИРОВКИ данного контракта поведения — canonicalGzip
 * минимального валидного модуля, буквально несущего токены, которые текущая
 * реализация шипит по контракту: имена платформенных API (минификатор не
 * переименовывает свойства host-объектов и глобалы), ключи публичной
 * грамматики опций, контрактные CSS-строки и тексты ошибок (запинены тестами
 * поведения). Это НЕ доказанная нижняя граница всех мыслимых реализаций:
 * gzip несёт кросс-токенные эффекты, а патологическая реализация может
 * собирать литералы динамически (заплатив больше кодом сборки) — floor
 * честен как эмпирический базис для текущего манифеста и кодировки, и ровно
 * так формулируется в docs/explanations/size-methodology.md.
 *
 * Честность манифеста охраняется машинно: каждый токен ОБЯЗАН буквально
 * встречаться в шипнутом минифицированном субпуте — протухший манифест
 * (токен ушёл из реализации) валит скрипт, а не тихо искажает floor.
 * Второй трипвайр — floor > факт: значит, манифест стал жаднее реальной
 * реализации (например, она ушла от буквальных литералов) и требует ревизии.
 *
 * Побочный продукт — диагностическая leave-one-out дельта gzip по категориям:
 * показывает, что доминирует в несжимаемой части референс-кодировки, и
 * направляет реальные шейвы. Дельты не аддитивны (кросс-токенные эффекты) —
 * это ориентир, не бухгалтерия.
 *
 * Запуск: node scripts/size-floor.mjs  (или pnpm size:floor)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalGzip } from './compression-oracle.mjs';
import { IMPORT_COST_SCENARIOS, measureScenario } from './size-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Манифест несжимаемых токенов nano spring-to. Категории — для атрибуции.
 * Каждая строка обязана буквально присутствовать в минифицированном бандле
 * сценария (см. гейт честности ниже).
 */
export const NANO_FLOOR_MANIFEST = {
  scenario: 'nano spring-to',
  categories: {
    'публичная грамматика (ключи опций/props)': [
      'animate', 'duration', 'ease', 'spring', 'delay', 'stagger',
      'reducedMotion', 'stiffness', 'damping', 'mass', 'rotate',
    ],
    'платформенный шов (WAAPI/DOM/глобалы)': [
      'document.querySelectorAll', 'matchMedia', 'matches', 'finished',
      'playState', 'commitStyles', 'cancel', 'addEventListener',
      'queueMicrotask', 'Promise.all', 'Array.from', 'Object.keys',
      'Number.isFinite', 'Number.EPSILON', 'RangeError',
      'Math.sqrt', 'Math.abs', 'Math.exp', 'Math.cos', 'Math.sin',
      'Math.log', 'Math.max', 'Math.ceil', 'Math.round',
      'easing', 'fill',
    ],
    'контрактные литералы (CSS/события/ошибки)': [
      '(prefers-reduced-motion: reduce)',
      'linear(',
      '"linear"',
      '"both"',
      '"finish"',
      '"finished"',
      'deg',
      'spring parameters must be finite and positive',
      'spring is not representable',
    ],
  },
};

/** Токен допустим голым выражением (идентификатор/dotted-глобал)? */
const IDENTIFIER_TOKEN = /^[A-Za-z$_][\w$]*(\.[A-Za-z$_][\w$]*)*$/;

/**
 * Минимальный ВАЛИДНЫЙ ESM-скелет, предъявляющий каждый токен ровно раз:
 * идентификаторы/dotted-глобалы — выражениями-стейтментами, всё остальное
 * (CSS-строки, тексты ошибок, фрагменты грамматики) — строковыми литералами.
 * Валидность носителя проверяется машинно (см. main) — floor меряется по
 * байтам исполнимого кода, а не произвольной конкатенации.
 */
export function floorSource(manifest) {
  const tokens = Object.values(manifest.categories).flat();
  const statements = tokens.map((token) => {
    if (IDENTIFIER_TOKEN.test(token)) return token;
    const body = token.startsWith('"') && token.endsWith('"')
      ? token.slice(1, -1)
      : token;
    return JSON.stringify(body);
  });
  return `export const animate=(e,t,n)=>{${statements.join(';')}};`;
}

/** Тело носителя (без export-обёртки) — для синтакс-проверки new Function. */
export function floorBody(source) {
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const escapeRegExp = (value) => value.replace(REGEXP_SPECIALS, '\\$&');

/**
 * Присутствует ли токен манифеста в шипнутом бандле.
 *
 * Подстрочный поиск (первая версия, находка ревью #247) был ЛОЖНО щедрым:
 * `mass` находился внутри `_mass`, `ease` внутри `easing`, `fill` внутри
 * `fillMode`, `animate` внутри `el.animate` даже когда самого токена в
 * контракте уже нет. Гейт честности при этом переставал ловить протухший
 * манифест — то есть охранял ровно то, ради чего написан, лишь на словах.
 *
 * Поэтому идентификаторы ищутся по границам слова: слева не должно быть
 * [\w$] (точка допустима — доступ к свойству host-объекта это нормальная
 * форма шипа), справа не должно быть [\w$]. Не-идентификаторы (CSS-строки,
 * тексты ошибок, фрагменты вроде `linear(`) остаются подстроками: они
 * самодостаточно различимы и границ слова не имеют.
 */
export function isTokenShipped(token, shipped) {
  // Кавычки манифеста означают «строковый литерал» — в бандле он в кавычках
  // (двойных либо одинарных, минификатор выбирает сам).
  if (token.startsWith('"') && token.endsWith('"')) {
    const body = token.slice(1, -1);
    return shipped.includes(`"${body}"`) || shipped.includes(`'${body}'`);
  }
  if (!IDENTIFIER_TOKEN.test(token)) return shipped.includes(token);
  return new RegExp(`(?<![\\w$])${escapeRegExp(token)}(?![\\w$])`).test(shipped);
}

export async function main() {
  const scenario = IMPORT_COST_SCENARIOS.find(
    (s) => s.name === NANO_FLOOR_MANIFEST.scenario,
  );
  if (!scenario) throw new Error(`сценарий не найден: ${NANO_FLOOR_MANIFEST.scenario}`);
  const distIndexPath = resolve(__dirname, '../dist/index.js');
  const fact = await measureScenario(scenario, distIndexPath);
  if (!fact || !Number.isFinite(fact.gzBytes)) {
    throw new Error(`measureScenario не смерил сценарий (${fact?.error ?? 'нет dist'}) — обнови dist (pnpm build)`);
  }

  // Гейт честности манифеста: каждый токен буквально присутствует в шипнутом
  // минифицированном субпуте (сценарий бандлится из него же; esbuild свойства
  // host-объектов и глобалы не переименовывает — присутствие переносится).
  const shipped = readFileSync(resolve(__dirname, '../dist/nano/index.js'), 'utf8');
  const stale = [];
  for (const tokens of Object.values(NANO_FLOOR_MANIFEST.categories)) {
    for (const token of tokens) {
      if (!isTokenShipped(token, shipped)) stale.push(token);
    }
  }
  if (stale.length > 0) {
    console.error('size-floor: FAIL — токены манифеста не найдены в бандле (протух):');
    for (const token of stale) console.error(`  - ${token}`);
    process.exit(1);
  }

  const full = floorSource(NANO_FLOOR_MANIFEST);
  // Носитель обязан быть валидным кодом: floor меряется по байтам исполнимого
  // модуля, а не произвольной конкатенации (невалидный токен — ошибка здесь).
  try {
    new Function(floorBody(full));
  } catch (error) {
    console.error(`size-floor: FAIL — носитель floor не является валидным кодом: ${error}`);
    process.exit(1);
  }
  const floor = canonicalGzip(Buffer.from(full)).length;
  if (floor > fact.gzBytes) {
    // Трипвайр, не «сломанная методология»: реализация стала компактнее
    // референс-кодировки манифеста (например, ушла от буквальных литералов) —
    // манифест требует ревизии под новый способ нести контракт.
    console.error(`size-floor: FAIL — floor ${floor} B > факта ${fact.gzBytes} B: манифест жаднее реализации, пересмотри его`);
    process.exit(1);
  }

  // Диагностика: leave-one-out по категориям. Дельты НЕ аддитивны
  // (кросс-токенные эффекты gzip) — ориентир для шейвов, не бухгалтерия.
  const attribution = [];
  for (const [category, tokens] of Object.entries(NANO_FLOOR_MANIFEST.categories)) {
    const reduced = {
      ...NANO_FLOOR_MANIFEST,
      categories: Object.fromEntries(
        Object.entries(NANO_FLOOR_MANIFEST.categories).filter(([name]) => name !== category),
      ),
    };
    const without = canonicalGzip(Buffer.from(floorSource(reduced))).length;
    attribution.push([category, floor - without, tokens.length]);
  }

  const overhead = ((fact.gzBytes - floor) / fact.gzBytes) * 100;
  console.log(`size-floor: сценарий «${NANO_FLOOR_MANIFEST.scenario}»`);
  console.log(`  факт (закон merge-гейта):        ${fact.gzBytes} B gz`);
  console.log(`  floor референс-кодировки:        ${floor} B gz`);
  console.log(`  остаток сверх floor:             ${fact.gzBytes - floor} B (${overhead.toFixed(1)}% факта)`);
  console.log('  диагностика floor-а (leave-one-out, дельты не аддитивны):');
  for (const [category, bytes, count] of attribution) {
    console.log(`    ${String(bytes).padStart(4)} B  ${category} (${count} токенов)`);
  }
  console.log('size-floor: PASS');
}

// Прямой запуск исполняет гейт; импорт из теста — только чистые функции
// (тот же приём, что в scripts/size-gate.mjs).
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
