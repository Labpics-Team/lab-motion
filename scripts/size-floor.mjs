/**
 * scripts/size-floor.mjs — доказуемый size-floor субпутей (#243, пункт 2).
 *
 * Клейм строго «граница для ДАННОГО контракта поведения», не «предел жанра»:
 * любая реализация текущего поведенческого контракта субпутя обязана шипнуть
 * перечисленные ниже несжимаемые токены — имена платформенных API (минификатор
 * не переименовывает свойства host-объектов и глобалы), ключи публичной
 * грамматики опций (авторский код пишет их буквально), контрактные CSS-строки
 * и тексты ошибок (запинены тестами поведения). Floor = canonicalGzip
 * минимального синтаксически валидного модуля, содержащего каждый токен по
 * разу, той же compression-политикой, что merge-гейт (compression-oracle SSOT).
 *
 * Честность манифеста охраняется машинно: каждый токен ОБЯЗАН буквально
 * встречаться в фактическом минифицированном бандле сценария — протухший
 * манифест (токен ушёл из реализации) валит скрипт, а не тихо занижает floor.
 * Обратная сторона (floor ≤ факт) — санити самой методологии.
 *
 * Побочный продукт — атрибуция floor-а (leave-one-out дельта gzip по
 * категориям): показывает, ЧТО доминирует в несжимаемой части веса, и
 * направляет реальные шейвы (жать имеет смысл только слагаемые вне floor).
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
const NANO_FLOOR_MANIFEST = {
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

/** Минимальный валидный ESM-скелет, предъявляющий каждый токен ровно раз. */
function floorSource(manifest) {
  const tokens = Object.values(manifest.categories).flat();
  // Токены соединяются реалистичной пунктуацией модуля (не голым переносом):
  // gzip видит те же соседства «имя( / .имя / "строка"», что в настоящем коде.
  return `export const animate=(e,t,n)=>{${tokens.join(';')}};`;
}

/** Токен → форма, в которой он обязан встретиться в минифицированном бандле. */
function bundleNeedle(token) {
  // Кавычки манифеста означают «строковый литерал» — в бандле он в кавычках
  // (двойных либо одинарных, минификатор выбирает сам); голый токен ищется
  // как есть (имена свойств/глобалов минификатор не переименовывает).
  if (token.startsWith('"') && token.endsWith('"')) {
    const body = token.slice(1, -1);
    return [`"${body}"`, `'${body}'`];
  }
  return [token];
}

async function main() {
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
      if (!bundleNeedle(token).some((needle) => shipped.includes(needle))) {
        stale.push(token);
      }
    }
  }
  if (stale.length > 0) {
    console.error('size-floor: FAIL — токены манифеста не найдены в бандле (протух):');
    for (const token of stale) console.error(`  - ${token}`);
    process.exit(1);
  }

  const full = floorSource(NANO_FLOOR_MANIFEST);
  const floor = canonicalGzip(Buffer.from(full)).length;
  if (floor > fact.gzBytes) {
    console.error(`size-floor: FAIL — floor ${floor} B > факта ${fact.gzBytes} B (методология сломана)`);
    process.exit(1);
  }

  // Атрибуция: leave-one-out по категориям (сколько gzip-байт несёт категория).
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
  console.log(`  факт (закон merge-гейта):  ${fact.gzBytes} B gz`);
  console.log(`  floor контракта:           ${floor} B gz`);
  console.log(`  сжимаемый остаток:         ${fact.gzBytes - floor} B (${overhead.toFixed(1)}% факта)`);
  console.log('  атрибуция floor-а (leave-one-out):');
  for (const [category, bytes, count] of attribution) {
    console.log(`    ${String(bytes).padStart(4)} B  ${category} (${count} токенов)`);
  }
  console.log('size-floor: PASS');
}

await main();
