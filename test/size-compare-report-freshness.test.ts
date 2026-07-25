/**
 * size-compare-report-freshness.test.ts — публикуемое сравнение с конкурентами
 * обязано соответствовать ТЕКУЩЕЙ поставке.
 *
 * ЧТО ЗДЕСЬ ЗАЩИЩАЕТСЯ. `bench/compare/size-compare.report.json` — не
 * внутренний артефакт: на него ссылаются docs/explanations/size-methodology.md
 * и обе страницы миграции (Framer/Motion, anime.js), из него берутся числа,
 * которыми пакет себя сравнивает. При этом до 2026-07-25 файл не проверялся
 * НИЧЕМ: ни одного теста, ни шага CI. Отчёт был снят на ревизии 8091eb61 и
 * успел разъехаться с фактом (lab-nano: 1001 B в отчёте против 1005 B в
 * поставке) — то есть публичное сравнительное утверждение тихо устарело.
 *
 * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ. Строки конкурентов пересчитать без их пакетов нельзя
 * (у корневого workspace их нет и не должно быть), поэтому гейт разделён:
 *   • СВОИ строки (`lab-*`, kind: 'esbuild') пересобираются здесь заново из
 *     текущего dist тем же сценарием и тем же gzip-оракулом — расхождение
 *     означает устаревший отчёт;
 *   • строка `lab-compiled` собирается реальным Vite и потому проверяется
 *     своим приёмочным гейтом (scripts/compiler-acceptance.mjs), здесь — лишь
 *     присутствие;
 *   • ЧУЖИЕ строки проверяются по метаданным: версии конкурентов в отчёте
 *     обязаны совпадать с пинами bench/compare/package.json, иначе сравнение
 *     ведётся с версией, которой в стенде уже нет.
 *
 * Сценарии импортируются ИЗ САМОГО СТЕНДА — здесь нет их копии, иначе гейт
 * проверял бы соответствие отчёта своей собственной реплике.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { distReady } from './support/dist-required.js';
import { SCENARIOS, measureEsbuild } from '../bench/compare/size-compare.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(repoRoot, 'bench/compare/size-compare.report.json');

interface Row {
  readonly id: string;
  readonly gz: number;
  readonly raw: number;
}
interface Report {
  readonly generatedFor: string;
  readonly revision: string;
  readonly competitors: Record<string, string>;
  readonly rows: readonly Row[];
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;

describe.runIf(distReady())('отчёт size-compare соответствует поставке', () => {
  it('СВОИ строки пересобираются байт-в-байт из текущего dist', async () => {
    const drift: string[] = [];
    for (const scenario of SCENARIOS as readonly {
      id: string; kind: string; code: string;
    }[]) {
      if (!scenario.id.startsWith('lab-') || scenario.kind !== 'esbuild') continue;
      const row = report.rows.find((r) => r.id === scenario.id);
      expect(row, `в отчёте нет строки ${scenario.id}`).toBeDefined();
      const measured = await measureEsbuild(scenario.code) as { gz: number; raw: number };
      if (measured.gz !== row!.gz || measured.raw !== row!.raw) {
        drift.push(
          `${scenario.id}: отчёт ${row!.gz} B gz / ${row!.raw} B raw, ` +
          `факт ${measured.gz} B gz / ${measured.raw} B raw`,
        );
      }
    }
    expect(
      drift,
      `отчёт устарел — перегенерируйте:\n  cd bench/compare && node size-compare.mjs\n${drift.join('\n')}`,
    ).toEqual([]);
  }, 120_000);

  it('версии конкурентов в отчёте совпадают с пинами стенда', () => {
    const bench = JSON.parse(
      readFileSync(resolve(repoRoot, 'bench/compare/package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    for (const [name, version] of Object.entries(report.competitors)) {
      expect(bench.devDependencies[name], `конкурент ${name} не запинен в стенде`)
        .toBe(version);
    }
    // Обратная сторона: пин, добавленный в стенд, обязан попасть в сравнение,
    // иначе таблица тихо перестаёт быть полной.
    for (const name of ['motion', 'animejs', 'gsap']) {
      expect(report.competitors[name], `${name} выпал из отчёта`).toBeDefined();
    }
  });

  it('отчёт снят для ТЕКУЩЕЙ версии пакета и несёт provenance', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(report.generatedFor).toBe(pkg.version);
    expect(report.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(report.rows.length).toBeGreaterThanOrEqual(7);
    // compiled-строка живёт в отчёте, но её число пинит compiler-acceptance.
    expect(report.rows.some((r) => r.id === 'lab-compiled')).toBe(true);
  });
});
