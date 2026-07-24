/**
 * test-doubles-ratchet.test.ts — ратчет на самодельные двойники элемента.
 *
 * ЗАЧЕМ. Каждый самодельный двойник реализует ровно то, что нужно СВОЕМУ файлу,
 * и молчит обо всём остальном. Именно так дефекты #240 стали невидимы: двойник
 * не отдавал `addEventListener`, поэтому finish-хвост продукта не исполнялся
 * ни разу, и тест был зелёным при любом его содержимом. Одиннадцать
 * несовместимых двойников — это одиннадцать разных представлений о том, что
 * такое элемент, и ни одно из них не сверено с движком.
 *
 * ЗАКОН (тот же, что у size-gate и coverage-gate): число падает и только
 * падает. Новый тест обязан брать `test/support/waapi-double.ts`, чей контракт
 * сверен с настоящими Chromium/Firefox/WebKit
 * (browser/18-waapi-double-fidelity.spec.ts). Существующие файлы переводятся
 * постепенно — переписывать одиннадцать файлов одним PR значило бы менять
 * смысл их тестов вслепую.
 *
 * Mutation proof: добавить новый самодельный двойник → RED с именем файла.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Объявление локального двойника элемента: функция либо константа-фабрика. */
const DOUBLE_DECLARATION =
  /^\s*(?:export\s+)?(?:function|const)\s+(?:fakeEl|fakeElement|timedEl|createFakeElement|makeEl|elementDouble)\b/m;

/**
 * Хронология ратчета.
 *
 * 2026-07-24 — первая фиксация: 11 файлов. Общий двойник появился в этот же
 * день, поэтому число ещё равно факту; каждый следующий срез обязан его
 * уменьшать, а не удерживать.
 */
const MAX_ADHOC_DOUBLES = 11;

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('ратчет самодельных двойников элемента', () => {
  const offenders = collectFiles(TEST_DIR)
    .filter((file) => !file.includes(`${'support'}/`))
    .filter((file) => DOUBLE_DECLARATION.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(TEST_DIR.length + 1))
    .sort();

  it(`число самодельных двойников не растёт (потолок ${MAX_ADHOC_DOUBLES})`, () => {
    expect(
      offenders.length,
      `самодельные двойники:\n  ${offenders.join('\n  ')}\n`
      + 'Новый тест обязан брать test/support/waapi-double.ts — его контракт сверен '
      + 'с настоящими движками в browser/18-waapi-double-fidelity.spec.ts.',
    ).toBeLessThanOrEqual(MAX_ADHOC_DOUBLES);
  });

  it('потолок затянут по факту: лишнего запаса нет', () => {
    // Ратчет без этой проверки тихо накапливает люфт и перестаёт быть ратчетом.
    expect(MAX_ADHOC_DOUBLES).toBe(offenders.length);
  });

  it('общий двойник существует и экспортирует контракт целиком', async () => {
    const shared = await import('./support/waapi-double.js');
    expect(typeof shared.createWaapiDouble).toBe('function');
    expect(typeof shared.installDomShims).toBe('function');
    // Анти-вырожденность: двойник обязан уметь то, чего не умели самодельные.
    const dom = shared.createWaapiDouble();
    const animation = dom.el.animate([{ opacity: 1 }], { duration: 1 });
    expect(typeof animation.addEventListener).toBe('function');
    expect(typeof animation.commitStyles).toBe('function');
    expect(typeof animation.finished.then).toBe('function');
  });

  it('sanity: детектор находит объявление и не срабатывает на упоминании', () => {
    expect(DOUBLE_DECLARATION.test('function fakeElement(journal) {')).toBe(true);
    expect(DOUBLE_DECLARATION.test('const fakeEl = () => ({})')).toBe(true);
    expect(DOUBLE_DECLARATION.test('// см. fakeElement в соседнем файле')).toBe(false);
    expect(DOUBLE_DECLARATION.test('const x = fakeElement();')).toBe(false);
  });

  it('файл support исключён из счёта (иначе ратчет считал бы сам себя)', () => {
    const supportFiles = collectFiles(resolve(TEST_DIR, 'support'));
    expect(supportFiles.length).toBeGreaterThan(0);
    expect(offenders.some((file) => file.startsWith('support/'))).toBe(false);
  });
});
