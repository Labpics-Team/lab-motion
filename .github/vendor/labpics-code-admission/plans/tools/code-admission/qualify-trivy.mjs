#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectBypassFindings } from '../code-admission.mjs';
import { normalizeTrivyReport, blockingSecurityFindings, scannerEnvironment, fileDigest } from './trivy.mjs';
import { prepareQualifiedExecutable } from './identity.mjs';

// These tiny subjects qualify the actual binary and its embedded checks without
// downloading a vulnerability database or scanning product source twice.
export function qualifyTrivy(executable, parent = tmpdir()) {
  const work = mkdtempSync(join(parent, 'trivy-controls-'));
  const binary = resolve(executable), binaryDigest = fileDigest(binary);
  const environment = scannerEnvironment(join(work, 'home'), work);
  mkdirSync(environment.HOME);
  const config = join(work, 'trusted.yml'); writeFileSync(config, '{}\n');
  const runtime = prepareQualifiedExecutable(binary, binaryDigest, work, 'Trivy qualification binary');
  const cases = [
    { name: 'lawful', text: 'FROM alpine:3.22\nUSER 65534\nWORKDIR /app\nHEALTHCHECK CMD exit 0\n', allowed: true },
    { name: 'unsafe', text: 'FROM alpine:3.22\nWORKDIR relative\n', allowed: false },
    { name: 'suppressed', text: 'FROM alpine:3.22\nUSER 65534\n#trivy:ignore:DS009\nWORKDIR relative\nHEALTHCHECK CMD exit 0\n', allowed: false },
  ];
  try {
    const receipts = cases.map(subject => {
      const root = join(work, subject.name); mkdirSync(root); writeFileSync(join(root, 'Dockerfile'), subject.text);
      const execution = runtime.run(['config', '--config', config, '--ignorefile', '/dev/null', '--format', 'json', '--exit-code', '0',
        '--include-non-failures', '--skip-check-update', '--cache-dir', join(work, 'cache'), '--quiet', root],
      { cwd: work, env: environment, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(execution.error, undefined, 'native Trivy qualification did not finish');
      assert.equal(execution.status, 0, 'native Trivy qualification did not execute');
      const raw = JSON.parse(execution.stdout);
      const findings = normalizeTrivyReport(raw, root);
      const controls = collectBypassFindings(root);
      const blockers = [...blockingSecurityFindings(findings), ...controls.filter(item => item.kind === 'scanner-control')];
      assert.equal(blockers.length === 0, subject.allowed, `native ${subject.name} qualification`);
      if (subject.name === 'unsafe') {
        assert.ok(blockers.some(item => item.rule === 'DS-0002'), 'non-root detector must fire');
        assert.ok(blockers.some(item => item.rule === 'DS-0009'), 'relative WORKDIR detector must fire');
      }
      if (subject.name === 'suppressed') assert.ok(controls.some(item => item.rule === 'lab-bypass-trivy-inline'));
      return { subject: subject.name, allowed: subject.allowed, blockingRules: blockers.map(item => item.rule).sort() };
    });
    return { schema: 'labpics.trivy/native-qualification/v1', binaryDigest, cases: receipts };
  } finally { runtime.close(); rmSync(work, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new TypeError('usage: qualify-trivy.mjs <trusted-trivy-binary>');
    process.stdout.write(`${JSON.stringify(qualifyTrivy(process.argv[2]))}\n`);
  } catch (error) { console.error(`Trivy qualification failed: ${error.message}`); process.exitCode = 2; }
}
