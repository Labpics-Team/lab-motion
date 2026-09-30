import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_GZIP_PACKAGE } from '../../scripts/compression-policy.mjs';
import {
  prepareBenchmarkCheckout,
  assertCheckoutUnchanged,
  assertInstalledPackageTreesUnchanged,
} from '../compare/provenance.mjs';

// Сборка и identity принадлежат общему стенду; числа и потолки — size-gate.
// Адаптер сохраняет структурированный результат тех же измерений, что pnpm size.
export async function measureOldVector(root) {
  const provenance = prepareBenchmarkCheckout({
    root,
    benchDirectory: root,
    requiredRootPackages: ['esbuild', CANONICAL_GZIP_PACKAGE],
  });
  const gate = await import('../../scripts/size-gate.mjs');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entries = gate.measureEntries(gate.deriveEntriesFromExports(pkg), root);
  const scenarios = [];
  for (const scenario of gate.IMPORT_COST_SCENARIOS) {
    scenarios.push(await gate.measureScenario(scenario, join(root, 'dist/index.js')));
  }
  const failed = entries.hasWarnings || scenarios.some((row) => row.error || gate.evaluateScenarioBudget(row).exceeded);
  assertCheckoutUnchanged(root, provenance);
  assertInstalledPackageTreesUnchanged(root, provenance.environment.rootPackages);
  return { exitCode: failed ? 1 : 0, entries, scenarios, provenance };
}

export function validateReplayedVector(recorded, replayed) {
  if (recorded?.exitCode !== 0 || replayed?.exitCode !== 0) {
    throw new Error('PROFILE-01: старый cost vector не прошёл независимое измерение');
  }
  if (!recorded.entries || !Array.isArray(recorded.scenarios) || recorded.scenarios.length === 0) {
    throw new Error('PROFILE-01: отсутствуют структурированные измерения');
  }
  for (const field of ['entries', 'scenarios']) {
    if (!isDeepStrictEqual(recorded[field], replayed[field])) {
      throw new Error(`PROFILE-01: ${field} не воспроизводится независимым измерением`);
    }
  }
  // Время новой сборки отличается; исходники, inputs, dist и инструменты должны совпасть.
  for (const field of ['revision', 'trackedRevisionSha256', 'inputs', 'distRuntime', 'environment']) {
    if (recorded.provenance?.[field] === undefined ||
        !isDeepStrictEqual(recorded.provenance[field], replayed.provenance?.[field])) {
      throw new Error(`PROFILE-01: provenance.${field} не совпадает при воспроизведении`);
    }
  }
}
