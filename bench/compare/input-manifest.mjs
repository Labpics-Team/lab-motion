const SHA256 = /^[0-9a-f]{64}$/;

// Пути относятся к корню Git; optional означает отсутствие файла в revision, не пропуск хеша.
const INPUTS = Object.freeze([
  ['root/package.json', 'package.json', 9, false, true],
  ['root/pnpm-lock.yaml', 'pnpm-lock.yaml', 9, false, true],
  ['root/pnpm-workspace.yaml', 'pnpm-workspace.yaml', 9, true, true],
  ['bench/package.json', 'bench/compare/package.json', 9, false, true],
  ['bench/pnpm-lock.yaml', 'bench/compare/pnpm-lock.yaml', 9, false, true],
  ['bench/pnpm-workspace.yaml', 'bench/compare/pnpm-workspace.yaml', 9, true, true],
  ['root/scripts/compression-policy.mjs', 'scripts/compression-policy.mjs', 9],
  ['root/scripts/compression-oracle.mjs', 'scripts/compression-oracle.mjs', 9],
  ['bench/bench.mjs', 'bench/compare/bench.mjs', 9],
  ['bench/methodology.mjs', 'bench/compare/methodology.mjs', 9],
  ['bench/provenance.mjs', 'bench/compare/provenance.mjs', 9],
  ['bench/report-contract.mjs', 'bench/compare/report-contract.mjs', 9],
  ['bench/motion-conformance.mjs', 'bench/compare/motion-conformance.mjs', 10],
  ['bench/input-manifest.mjs', 'bench/compare/input-manifest.mjs', 9, true, true],
  ...['lab', 'motion', 'gsap', 'anime', 'waapi-control', 'lab-spring', 'motion-mini', 'anime-waapi']
    .map((name) => [`bench/entries/${name}.entry.mjs`, `bench/compare/entries/${name}.entry.mjs`, 9]),
].map(([label, file, schema, optional = false, captureByDefault = false]) => Object.freeze({
  label, file, schema, optional, captureByDefault,
})));

export function benchmarkInputManifest(schema) {
  if (schema !== 9 && schema !== 10) throw new Error(`benchmark inputs: schema ${String(schema)} не поддержана`);
  return INPUTS.filter((input) => input.schema <= schema);
}

/** Read-only reader проверяет форму; наличие optional-файлов доказывает Git, не отчёт. */
export function assertBenchmarkInputHashes(inputs, schema, { allowUnknown = false } = {}) {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('benchmark inputs: отсутствует объект input SHA-256');
  }
  const manifest = benchmarkInputManifest(schema);
  for (const { label, optional } of manifest) {
    if ((!optional || Object.hasOwn(inputs, label)) && !SHA256.test(inputs[label] ?? '')) {
      throw new Error(`benchmark inputs: input ${label} требует SHA-256`);
    }
  }
  if (!allowUnknown) {
    for (const label of Object.keys(inputs)) {
      if (!manifest.some((input) => input.label === label)) throw new Error(`benchmark inputs: неподдерживаемый input ${label}`);
    }
  }
}

/** expected получен из Git revision доверенным reader, а не из companion JSON. */
export function assertBenchmarkRevisionInputs(inputs, expected, schema) {
  assertBenchmarkInputHashes(inputs, schema);
  assertBenchmarkInputHashes(expected, schema);
  for (const { label } of benchmarkInputManifest(schema)) {
    if (Object.hasOwn(inputs, label) !== Object.hasOwn(expected, label) || inputs[label] !== expected[label]) {
      throw new Error(`benchmark inputs: ${label} SHA-256 не совпадает с Git revision`);
    }
  }
}
