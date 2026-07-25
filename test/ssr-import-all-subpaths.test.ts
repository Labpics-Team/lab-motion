/**
 * ssr-import-all-subpaths.test.ts — инвариант 4 («импорт ЛЮБОГО субпутя не
 * трогает DOM») проверяется на ВСЕХ субпутях, а не на двух.
 *
 * ЧТО БЫЛО. Инвариант сформулирован для любого субпутя, а исполняемо
 * проверялся ровно у двух: ./animate (animate-facade-ssr) и ./lit
 * (lit-ssr-safe). Остальные 39 держались на дисциплине автора. Между тем цена
 * нарушения — не «менее красиво», а падение сборки у потребителя: Next.js,
 * Remix, Astro и SvelteKit импортируют модуль на сервере, где `window` нет
 * вовсе, и top-level обращение к DOM роняет рендер страницы целиком.
 *
 * ЗДЕСЬ ДВЕ СРЕДЫ, и они ловят разное:
 *   1. ЧИСТЫЙ NODE (window/document отсутствуют) — прямой SSR: импорт обязан
 *      пройти. Ловит `document.createElement(…)` и подобное на верхнем уровне.
 *   2. ВРАЖДЕБНЫЙ ХОСТ: window/document существуют, но ЛЮБОЕ чтение их свойств
 *      при импорте фиксируется. Ловит то, что первая среда пропускает —
 *      `typeof window !== 'undefined' && window.matchMedia(…)` на верхнем
 *      уровне: в node такой код молча уходит в else, а в браузере выполняет
 *      побочный эффект при импорте (и ломает гидратацию + tree-shaking).
 *
 * Проверяется СОБРАННЫЙ dist — то, что получает потребитель, а не исходники.
 * Субпути с фреймворковым пиром, которого нет в окружении, помечаются
 * пропуском ЯВНО (со списком в сообщении), чтобы «зелено» никогда не означало
 * «ничего не проверено».
 *
 * Mutation proof: добавить `const w = document.body;` в начало любого
 * входного модуля субпутя → RED в среде 1; добавить
 * `const m = typeof window !== 'undefined' && window.matchMedia('x');` → RED в
 * среде 2 (первая такое пропускает).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distReady = existsSync(resolve(repoRoot, 'dist/index.js'));

/** Все ESM-входы из карты exports — источник правды поставки. */
function subpathEntries(): [subpath: string, file: string][] {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  const out: [string, string][] = [];
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    if (typeof value !== 'object' || value === null) continue;
    const target = (value as { import?: { default?: string } | string }).import;
    const file = typeof target === 'string' ? target : target?.default;
    if (typeof file !== 'string' || !file.endsWith('.js')) continue;
    out.push([subpath, resolve(repoRoot, file)]);
  }
  return out;
}

/** Отсутствие модуля-пира — не нарушение инварианта, а отсутствие окружения. */
function missingPeer(error: unknown): string | undefined {
  const code = (error as { code?: string }).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return undefined;
  return /'([^']+)'/.exec(String((error as Error).message))?.[1] ?? 'unknown';
}

/**
 * Глобалы, чтение которых при импорте считается обращением к DOM. `navigator`
 * в Node 21+ существует штатно (Navigator API), поэтому его нельзя требовать
 * отсутствующим — но подменять и ВОССТАНАВЛИВАТЬ для враждебной пробы можно.
 */
const DOM_GLOBALS = ['window', 'document', 'navigator'] as const;
/** Отсутствуют в SSR-рантаймах по определению — на них строится среда 1. */
const ABSENT_IN_SSR = ['window', 'document'] as const;

const originals = new Map<string, PropertyDescriptor | undefined>();

function installSpies(make: (name: string) => unknown): void {
  for (const name of DOM_GLOBALS) {
    if (!originals.has(name)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
      value: make(name), configurable: true, writable: true,
    });
  }
}

function restoreGlobals(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
  originals.clear();
}

afterEach(restoreGlobals);

describe.runIf(distReady)('инвариант 4: импорт субпутя не трогает DOM', () => {
  it('среда действительно без DOM (герметичность самого теста)', () => {
    for (const name of ABSENT_IN_SSR) {
      expect(typeof (globalThis as Record<string, unknown>)[name], name).toBe('undefined');
    }
    expect(subpathEntries().length).toBeGreaterThanOrEqual(40);
  });

  it('ЧИСТЫЙ NODE: каждый субпуть импортируется без window/document', async () => {
    const broken: string[] = [];
    const skipped: string[] = [];
    for (const [subpath, file] of subpathEntries()) {
      try {
        await import(file);
      } catch (error) {
        const peer = missingPeer(error);
        if (peer !== undefined) skipped.push(`${subpath} (нет пира ${peer})`);
        else broken.push(`${subpath}: ${(error as Error).message}`);
      }
    }
    // Пропуски печатаются всегда: молчаливый пропуск неотличим от проверки.
    if (skipped.length > 0) console.info(`SSR-пропуски: ${skipped.join(', ')}`);
    expect(broken, `субпути падают при SSR-импорте:\n${broken.join('\n')}`).toEqual([]);
    // Больше половины поставки обязано реально проверяться, иначе гейт пуст.
    expect(skipped.length).toBeLessThan(subpathEntries().length / 2);
  }, 120_000);

  it('ВРАЖДЕБНЫЙ ХОСТ: наличие window/document не вызывает обращений при импорте', async () => {
    const touched: string[] = [];
    let current = '';
    const spy = (name: string): unknown =>
      new Proxy({}, {
        get(_t, prop) {
          // Символы движка (Symbol.toPrimitive и пр.) не считаются обращением
          // к DOM: их дёргает сам JS при печати/сравнении объекта.
          if (typeof prop !== 'symbol') touched.push(`${current} → ${name}.${String(prop)}`);
          return undefined;
        },
        has: () => true,
      });

    for (const [subpath, file] of subpathEntries()) {
      current = subpath;
      installSpies(spy);
      try {
        // Кэш модулей уже прогрет предыдущим тестом, поэтому повторный import
        // побочных эффектов не выполнит. Читаем модуль заново через
        // cache-busting query — иначе среда 2 не проверяла бы НИЧЕГО.
        await import(`${file}?hostile`);
      } catch (error) {
        if (missingPeer(error) === undefined) throw error;
      } finally {
        restoreGlobals();
      }
    }
    expect(touched, `DOM тронут на верхнем уровне:\n${touched.join('\n')}`).toEqual([]);
  }, 120_000);
});
