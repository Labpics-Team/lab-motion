import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const smoke = readFileSync(new URL('../scripts/pack-smoke.mjs', import.meta.url), 'utf8');

describe('packed release boundary', () => {
  it('ships every referenced support document', () => {
    expect(pkg.files).toContain('docs/errors.md');
    expect(pkg.files).toContain('docs/benchmark.md');
    expect(pkg.files).toContain('docs/recipes.md');
    expect(smoke).toContain("'docs/benchmark.md'");
    expect(smoke).toContain("'docs/recipes.md'");
    expect(smoke).toContain("readFileSync(installedRecipes, 'utf8') !== readFileSync");
    expect(smoke).toContain("readFileSync(installedBenchmark, 'utf8') !== readFileSync");
    expect(smoke).toContain('parseBenchmarkDocumentationState(benchmarkDocument, installedPackage)');
    expect(smoke).not.toContain('/bench/compare/results/`;');
  });

  it('derives the runnable Node floor and export surface from installed archive metadata', () => {
    expect(smoke).toContain("JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))");
    expect(smoke).toContain("/^>=(\\d+)\\.(\\d+)$/.exec(installedPackage.engines?.node ?? '')");
    expect(smoke).toContain('Object.keys(installedPackage.exports)');
    // Пол не должен быть зашит в скрипт ни в каком виде: смысл проверки —
    // «раннер удовлетворяет тому, что реально отгружено», а не константе.
    expect(smoke).not.toMatch(/engines\?\.node !== '/);
  });

  it('проверяет смешанный граф в одном процессе, а не две ветки порознь', () => {
    // Разделённые ESM- и CJS-пробы не могут увидеть дублирование модуля:
    // у каждой свой процесс. Смешанная проба — единственное место, где
    // возврат к условным веткам import/require стал бы красным.
    expect(smoke).toContain("createRequire(import.meta.url)");
    expect(smoke).toContain('required.frame !== imported.frame');
    expect(smoke).toContain('mixed-graph.mjs');
    // Условные ветки в exports обязаны быть отказом, а не молчаливым «ок».
    expect(smoke).toContain("for (const forbidden of ['import', 'require'])");
    // Гарды невакуумности: без них «получился 1 rAF» было бы верно и для
    // фасада, который не планирует ничего, а «cancelAll погасил» — для
    // пустой очереди. Замерено: animate в одиночку даёт 0 → 1 rAF и 1 кадр
    // в очереди, поэтому оба гарда проверяют факт, а не тавтологию.
    expect(smoke).toContain('проба была бы вакуумной');
    expect(smoke).toContain('очередь кадров пуста — гасить нечего, проба вакуумна');
  });
});
