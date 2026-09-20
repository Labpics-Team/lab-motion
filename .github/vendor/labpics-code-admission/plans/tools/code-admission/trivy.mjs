import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stableJson } from '../../../architecture/model.mjs';

import { fileDigest, prepareQualifiedExecutable } from './identity.mjs';
export { fileDigest } from './identity.mjs';

const MAX_OUTPUT = 64 * 1024 * 1024;
const SEVERITIES = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, label) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError(`Invalid Trivy ${label}`);
  return value;
}
function array(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`Invalid Trivy ${label}`);
  return value;
}
function severity(item) {
  if (!object(item) || !SEVERITIES.has(item.Severity)) throw new TypeError('Unknown Trivy finding severity');
  return item.Severity;
}
function line(value) {
  if (value === undefined || value === 0) return 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid Trivy source line');
  return value;
}
export function trivyTarget(root, target) {
  text(target, 'target');
  const resolved = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const result = relative(resolve(root), resolved);
  if (isAbsolute(result) || result === '..' || result.startsWith(`..${sep}`)) throw new TypeError('Trivy target is outside the scanned snapshot');
  return result.split(sep).join('/') || '.';
}
export function validateTrivyReport(report, root) {
  if (!object(report) || report.SchemaVersion !== 2 || report.ArtifactType !== 'filesystem' || report.ArtifactName !== resolve(root)) throw new TypeError('Trivy report schema or artifact identity mismatch');
  if (report.Metadata !== undefined && !object(report.Metadata)) throw new TypeError('Invalid Trivy metadata');
  for (const result of array(report.Results, 'Results')) {
    if (!object(result)) throw new TypeError('Invalid Trivy result');
    trivyTarget(root, result.Target);
    if (result.Class !== undefined && !['os-pkgs', 'lang-pkgs', 'config', 'secret', 'license', 'license-file'].includes(result.Class)) throw new TypeError('Unqualified Trivy result class');
    for (const key of ['Vulnerabilities', 'Secrets', 'Misconfigurations', 'Packages', 'Licenses', 'ExperimentalModifiedFindings']) array(result[key], key);
    if ((result.ExperimentalModifiedFindings ?? []).length) throw new TypeError('Modified Trivy findings require independent review');
    if (result.CustomResources !== undefined && array(result.CustomResources, 'CustomResources').length) throw new TypeError('Unqualified custom scanner evidence');
    if (result.MisconfSummary !== undefined) {
      const summary = result.MisconfSummary;
      if (!object(summary) || !Number.isSafeInteger(summary.Successes) || summary.Successes < 0 || !Number.isSafeInteger(summary.Failures) || summary.Failures < 0) throw new TypeError('Invalid Trivy misconfiguration summary');
      const successes = (result.Misconfigurations ?? []).filter(item => item?.Status === 'PASS').length;
      const failures = (result.Misconfigurations ?? []).filter(item => item?.Status === 'FAIL').length;
      if (successes !== summary.Successes || failures !== summary.Failures) throw new TypeError('Trivy summary disagrees with complete finding population');
    }
  }
  return report;
}
export function normalizeTrivyReport(report, root) {
  validateTrivyReport(report, root);
  const findings = [];
  for (const result of report.Results ?? []) {
    const path = trivyTarget(root, result.Target);
    for (const item of result.Vulnerabilities ?? []) {
      const level = severity(item), id = text(item.VulnerabilityID, 'vulnerability ID');
      const pkg = text(item.PkgName, 'package'), version = text(item.InstalledVersion, 'package version');
      findings.push({ fingerprint: `trivy:vulnerability:${path}:${id}:${pkg}:${version}`, source: 'trivy', kind: 'vulnerability', severity: level, rule: id, path, line: 1,
        package: pkg, installedVersion: version, fixedVersion: item.FixedVersion ?? null,
        message: `${id}: ${pkg}@${version} (${level})` });
    }
    for (const item of result.Secrets ?? []) {
      const level = severity(item), id = text(item.RuleID, 'secret rule');
      const material = item.Match ?? item.Code?.Lines;
      if (material === undefined) throw new TypeError('Trivy secret has no identity evidence');
      findings.push({ fingerprint: `trivy:secret:${path}:${id}:${sha256(stableJson(material))}`, source: 'trivy', kind: 'secret', severity: level, rule: id, path, line: line(item.StartLine),
        message: `${id}: обнаружено совпадение с детектором секрета` });
    }
    for (const item of result.Misconfigurations ?? []) {
      const level = severity(item), id = text(item.ID ?? item.AVDID, 'misconfiguration ID');
      if (!['PASS', 'FAIL', 'EXCEPTION'].includes(item.Status)) throw new TypeError('Unknown Trivy misconfiguration status');
      if (item.Status === 'PASS') continue;
      const title = text(item.Title, 'misconfiguration title');
      findings.push({ fingerprint: `trivy:misconfiguration:${path}:${id}:${sha256(title)}`, source: 'trivy', kind: 'misconfiguration', severity: level, rule: id, path,
        line: line(item.CauseMetadata?.StartLine), suppressed: item.Status === 'EXCEPTION', message: `${id}: ${title}` });
    }
  }
  return findings;
}
export function blockingSecurityFindings(findings) {
  return findings.filter(item => item.kind === 'secret' || item.suppressed || ['HIGH', 'CRITICAL', 'UNKNOWN'].includes(item.severity));
}
export function scannerEnvironment(home, temporary, inherited = process.env) {
  // Ни TRIVY_*, ни credentials, ни NODE_OPTIONS не пересекают границу сканера.
  return { PATH: inherited.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' };
}
export function databaseEvidence(cache, now = Date.now()) {
  const metadata = JSON.parse(readFileSync(join(cache, 'db/metadata.json'), 'utf8'));
  const updated = Date.parse(metadata.UpdatedAt), next = Date.parse(metadata.NextUpdate);
  if (metadata.Version !== 2 || !Number.isFinite(updated) || !Number.isFinite(next) || updated > now + 300000 || next <= updated || now - updated > 24 * 60 * 60 * 1000 || now > next) throw new Error('Trivy vulnerability database is stale or invalid');
  const database = join(cache, 'db/trivy.db');
  if (!statSync(database).isFile() || statSync(database).size === 0) throw new Error('Trivy vulnerability database is absent');
  return { schemaVersion: metadata.Version, updatedAt: metadata.UpdatedAt, nextUpdate: metadata.NextUpdate, digest: fileDigest(database) };
}
function execute(runtime, args, context, json = true) {
  const result = runtime.run(args, { cwd: context.directory, env: context.environment, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 360000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    // stderr может содержать исходный секрет; в ошибке только безопасная квитанция.
    throw new Error(`Trivy execution incomplete: status=${result.status ?? 'none'} code=${result.error?.code ?? 'none'} diagnosticDigest=${sha256(result.stderr ?? '')}`);
  }
  if (!json) return result.stdout;
  if (!result.stdout?.trim()) throw new Error('Trivy execution returned an empty report');
  try { return JSON.parse(result.stdout); } catch { throw new Error('Trivy execution returned malformed JSON'); }
}
export function createTrivySession(executable, parent, qualifiedBinaryDigest) {
  const binaryDigest = qualifiedBinaryDigest;
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'qualified-trivy-'));
  const home = join(directory, 'home'), temporary = join(directory, 'tmp'), cache = join(directory, 'cache');
  for (const path of [home, temporary, cache]) mkdirSync(path, { mode: 0o700 });
  const config = join(directory, 'trusted-empty.yaml'); writeFileSync(config, '{}\n', { mode: 0o600 });
  const context = { directory, environment: scannerEnvironment(home, temporary) };
  // Исполнение идёт через анонимный файловый дескриптор проверенной копии: замена пути
  // после квалификации не меняет байты, которые получает execve.
  const runtime = prepareQualifiedExecutable(executable, qualifiedBinaryDigest, directory, 'Trivy binary');
  const checkedExecute = (args, json = true) => execute(runtime, args, context, json);
  let firstDatabase = null, prepared = false;
  return {
    scan(root, { skipUpdate = false } = {}) {
      runtime.verify();
      if (skipUpdate && !firstDatabase) throw new Error('Candidate scan requires a qualified database from baseline');
      if (skipUpdate && stableJson(databaseEvidence(cache)) !== stableJson(firstDatabase)) throw new Error('Trivy database changed between subjects');
      if (!prepared) {
        checkedExecute(['image', '--config', config, '--download-db-only', '--cache-dir', cache, '--disable-telemetry', '--quiet', '--timeout', '5m'], false);
        // Bind the downloaded DB before the first scan, not afterwards.
        // Otherwise replacement during the first candidate execution becomes
        // the supposed baseline and silently receives a valid receipt.
        firstDatabase = databaseEvidence(cache);
        prepared = true;
      }
      const started = Date.now();
      const args = ['fs', '--config', config, '--secret-config', config, '--ignorefile', '/dev/null', '--format', 'json', '--exit-code', '0', '--scanners', 'vuln,secret,misconfig,license',
        '--severity', 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL', '--include-dev-deps', '--include-non-failures', '--list-all-pkgs', '--offline-scan', '--parallel', '2', '--timeout', '5m', '--cache-dir', cache,
        '--disable-telemetry', '--skip-version-check', '--show-suppressed', '--skip-db-update', '--skip-java-db-update', '--skip-check-update', '--skip-vex-repo-update', '--quiet'];
      args.push(resolve(root));
      const raw = checkedExecute(args);
      validateTrivyReport(raw, resolve(root));
      if (typeof raw.Trivy?.Version !== 'string' || !Number.isFinite(Date.parse(raw.CreatedAt)) || Date.parse(raw.CreatedAt) < started - 300000 || Date.parse(raw.CreatedAt) > Date.now() + 300000) throw new Error('Trivy report lacks current execution provenance');
      const database = databaseEvidence(cache);
      if (firstDatabase && stableJson(database) !== stableJson(firstDatabase)) throw new Error('Trivy database drift invalidates comparison');
      firstDatabase ??= database;
      const findings = normalizeTrivyReport(raw, resolve(root));
      const packageInventory = (raw.Results ?? []).flatMap(result => (result.Packages ?? []).map(pkg => ({ target: trivyTarget(root, result.Target), name: pkg.Name, version: pkg.Version ?? null, purl: pkg.Identifier?.PURL ?? null, licenses: pkg.Licenses ?? [] })));
      // SBOM строится из того же отчёта, без повторного сканирования исходников.
      const rawPath = join(directory, 'convert.json'); writeFileSync(rawPath, JSON.stringify(raw), { mode: 0o600 });
      let sbom;
      try { sbom = checkedExecute(['convert', '--config', config, '--ignorefile', '/dev/null', '--format', 'cyclonedx', '--quiet', rawPath]); }
      finally { rmSync(rawPath, { force: true }); }
      if (stableJson(databaseEvidence(cache)) !== stableJson(firstDatabase)) throw new Error('Trivy database drift invalidates SBOM evidence');
      if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components ?? [])) throw new Error('Trivy returned an invalid SBOM');
      return { findings, sbom, evidence: { tool: { name: 'trivy', version: raw.Trivy.Version, binaryDigest }, reportDigest: sha256(stableJson(raw)), database,
        artifact: { name: raw.ArtifactName, type: raw.ArtifactType }, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
        scanners: ['vuln', 'secret', 'misconfig', 'license'], checks: 'embedded-in-pinned-binary', packageInventory, configTargets: (raw.Results ?? []).filter(r => r.Class === 'config').map(r => trivyTarget(root, r.Target)), reportedTargets: (raw.Results ?? []).map(r => trivyTarget(root, r.Target)),
        limitation: 'Наблюдение поддержанных Trivy форматов, не доказательство отсутствия неизвестных уязвимостей или runtime-достижимости.' } };
    },
    close() { runtime.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
