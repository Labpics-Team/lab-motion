/**
 * Гвард обязательности нативного тайпчека (бриф D3).
 *
 * Класс дефекта: команда typecheck:native существует в package.json, но не
 * вызывается ни одним обязательным гейтом — тогда она тихо перестаёт быть
 * merge-гейтом при любом рефакторинге workflow. Гвард требует: если скрипт
 * объявлен, он обязан быть либо шагом ci.yml, либо частью check:static.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const native = pkg.scripts?.['typecheck:native'];
if (!native) {
  console.log('native-gate: скрипт typecheck:native не объявлен — гвард не применим');
  process.exit(0);
}

const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const aggregated = String(pkg.scripts['check:static'] ?? '').includes('typecheck:native');
const inCi = /pnpm (run )?typecheck:native/.test(ci);

if (!aggregated && !inCi) {
  console.error(
    'native-gate: typecheck:native объявлен, но не вызывается ни в ci.yml, ни в check:static — нативный тайпчек перестал быть обязательным гейтом',
  );
  process.exit(1);
}
console.log(`native-gate: OK (${inCi ? 'шаг ci.yml' : 'внутри check:static'})`);
