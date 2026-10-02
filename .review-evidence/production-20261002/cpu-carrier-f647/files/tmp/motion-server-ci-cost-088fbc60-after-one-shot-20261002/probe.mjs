// Диагностика стоимости существующего full-four callback; не performance sample пакета.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const root = '/workspace/lab-motion', out = '/tmp/motion-server-ci-cost-088fbc60-after-one-shot-20261002';
const source = readFileSync(`${root}/test/server-profile-contract.test.ts`, 'utf8');
const prefix = source.slice(0, source.indexOf('// Исполняем настоящий browser owner'))
  .replace(/import \{[^\n]+\} from 'vitest';\n/, '').replaceAll("'../bench/", `'${root}/bench/`);
const startMarker = "  it('завершённый public admission отвергает четыре независимых reviewer counterexamples', () => {";
const start = source.indexOf(startMarker), end = source.indexOf('  }, 30_000);', start);
assert(start !== -1 && end !== -1);
const callbackBody = source.slice(start + startMarker.length, end);
writeFileSync(`${out}/exact-test-callback.ts`, callbackBody, { flag: 'wx' });
const esbuild = createRequire(`${root}/package.json`)('esbuild');
writeFileSync(`${out}/fixtures.mjs`, esbuild.transformSync(`${prefix}\nexport { admissionHistory, chain };`,
  { loader: 'ts', target: 'es2022', format: 'esm' }).code, { flag: 'wx' });
const fixture = await import(pathToFileURL(`${out}/fixtures.mjs`).href);
const contract = await import(`${root}/bench/profile/server-profile-contract.mjs`);
const steps = [];
function timed(name, fn) {
  const begin = performance.now(), cpu = process.cpuUsage(); let status = 'returned';
  try { return fn(); } catch (error) { status = 'threw'; throw error; }
  finally { const row = { name, elapsedMs: performance.now() - begin, cpuUs: process.cpuUsage(cpu), status }; steps.push(row); appendFileSync(`${out}/acquired-steps.ndjson`, JSON.stringify(row) + '\n'); }
}
const expect = (value) => ({ toBe: (other) => assert.equal(value, other), toHaveProperty: (key) => assert(Object.hasOwn(value, key)),
  toThrow: (pattern) => assert.throws(value, pattern) });
const callback = Function('admissionHistory', 'chain', 'validateServerArtifact', 'validateServerJournal', 'expect', callbackBody);
const begin = performance.now();
let failure = null;
try {
  callback(() => timed('fixture/admissionHistory', fixture.admissionHistory), (...args) => timed('fixture/chain', () => fixture.chain(...args)),
    (...args) => timed('validateServerArtifact', () => contract.validateServerArtifact(...args)),
    (...args) => timed('validateServerJournal', () => contract.validateServerJournal(...args)), expect);
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; }
const result = { sourceSha256: createHash('sha256').update(source).digest('hex'), callbackSha256: createHash('sha256').update(callbackBody).digest('hex'),
  qualification: 'Exact existing full-four callback/prefix. Vitest expect replaced by node assert equivalents; one process, no default-worker/gate timeout claim. Diagnostic CPU timing is not package performance data.',
  elapsedMs: performance.now() - begin, node: process.version, esbuild: esbuild.version, steps, failure, actualRegisteredPerformanceSamples: 0 };
writeFileSync(`${out}/probe-result.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failure) process.exitCode = 1;
