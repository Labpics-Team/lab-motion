#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRules } from './analyze.mjs';
import { GitReader } from './git.mjs';
import { configFrom, digest, isOid, REPORT_SCHEMA, stableJson, within } from './model.mjs';
import { parseJsonData, readRegularFile } from './input.mjs';

export const SEMANTIC_ADMISSION_SCHEMA = 'labpics.architecture/semantic-admission/v1';
const semanticRule = rule => stableJson({ kind: rule.kind, from: rule.from ?? null, to: rule.to ?? null, scope: rule.scope ?? null });
const sourcePrefixes = rule => rule.from ?? rule.scope;
const sourcePaths = report => [...new Set(report.structure.nodes.filter(node => !node.external).flatMap(node => node.paths))].sort();
const matching = (paths, prefixes) => paths.filter(candidate => prefixes.some(prefix => within(candidate, prefix)));
const owner = (config, candidate) => config.components.find(component => component.prefixes.some(prefix => within(candidate, prefix)))?.id ?? null;

function validateReport(report) {
    if (!report || report.schema !== REPORT_SCHEMA || !isOid(report.subject?.commit) || !isOid(report.subject?.tree))
        throw new TypeError('semantic admission: invalid report subject');
    const { identity, ...body } = report;
    if (!/^[a-f0-9]{64}$/.test(identity ?? '') || digest(body) !== identity)
        throw new TypeError('semantic admission: invalid report identity');
    if (!Array.isArray(report.structure?.nodes) || !Array.isArray(report.structure?.edges) || !Array.isArray(report.structure?.limitations))
        throw new TypeError('semantic admission: incomplete report structure');
}

function ownership(config, paths) {
    if (!paths.length)
        return { complete: config.components.length === 0, sourceFiles: 0, declaredFiles: 0, unmatched: [], staleComponents: config.components.map(c => c.id) };
    const unmatched = paths.filter(candidate => owner(config, candidate) === null);
    const staleComponents = config.components.filter(component => !paths.some(candidate => component.prefixes.some(prefix => within(candidate, prefix)))).map(component => component.id);
    return { complete: config.components.length > 0 && unmatched.length === 0 && staleComponents.length === 0,
        sourceFiles: paths.length, declaredFiles: paths.length - unmatched.length, unmatched, staleComponents };
}

function qualifyRules(report, config, paths) {
    const parser = report.structure.producer?.name;
    const limitations = report.structure.limitations.filter(item => item.path !== null);
    return config.rules.map(rule => {
        const sources = matching(paths, sourcePrefixes(rule));
        const unresolved = limitations.filter(item => sources.includes(item.path));
        const reasons = [];
        if (!sources.length) reasons.push('source-scope-empty');
        if (parser !== 'ast-grep') reasons.push('native-source-parser-not-qualified');
        if (unresolved.length) reasons.push('source-scope-has-unresolved-static-evidence');
        return { ruleId: rule.id, qualified: reasons.length === 0, sourceFiles: sources.length, reasons,
            unresolved: unresolved.map(item => ({ path: item.path, reason: item.reason })) };
    });
}

function policyChange(trusted, candidate, paths) {
    const candidateById = new Map(candidate.rules.map(rule => [rule.id, rule]));
    const protectedRules = [];
    for (const rule of trusted.rules) {
        const next = candidateById.get(rule.id), stillApplicable = matching(paths, sourcePrefixes(rule)).length > 0;
        if (!stillApplicable) continue;
        if (!next) protectedRules.push({ ruleId: rule.id, reason: 'declared-law-removed' });
        else if (semanticRule(next) !== semanticRule(rule)) protectedRules.push({ ruleId: rule.id, reason: 'declared-law-semantics-changed' });
    }
    const mergedOwners = candidate.components.flatMap(component => {
        const candidatePaths = matching(paths, component.prefixes), trustedOwners = [...new Set(candidatePaths.map(candidatePath => owner(trusted, candidatePath)).filter(Boolean))].sort();
        return trustedOwners.length > 1 ? [{ component: component.id, trustedOwners }] : [];
    });
    const excludeChanged = stableJson(trusted.excludeDirectories) !== stableJson(candidate.excludeDirectories);
    return { safe: !protectedRules.length && !excludeChanged && !mergedOwners.length, protectedRules, mergedOwners,
        excludeDirectoriesChanged: excludeChanged,
        addedRules: candidate.rules.filter(rule => !trusted.rules.some(old => old.id === rule.id)).map(rule => rule.id).sort() };
}

export function semanticVerdict({ report, trustedConfig, candidateConfig }) {
    validateReport(report);
    const paths = sourcePaths(report);
    const trustedOwnership = ownership(trustedConfig, paths), candidateOwnership = ownership(candidateConfig, paths);
    const trustedQualification = qualifyRules(report, trustedConfig, paths), candidateQualification = qualifyRules(report, candidateConfig, paths);
    const trustedViolations = evaluateRules(report.structure, trustedConfig), candidateViolations = evaluateRules(report.structure, candidateConfig);
    const change = policyChange(trustedConfig, candidateConfig, paths);
    const missingEvidence = [];
    if (!trustedOwnership.complete) missingEvidence.push('trusted-semantic-ownership-incomplete');
    if (!candidateOwnership.complete) missingEvidence.push('candidate-semantic-ownership-incomplete');
    if (trustedQualification.some(item => !item.qualified)) missingEvidence.push('trusted-law-evidence-incomplete');
    if (candidateQualification.some(item => !item.qualified)) missingEvidence.push('candidate-law-evidence-incomplete');
    const rejected = [];
    if (trustedViolations.length) rejected.push('trusted-law-violation');
    if (candidateViolations.length) rejected.push('candidate-law-violation');
    if (!change.safe) rejected.push('candidate-policy-weakening');
    const outcome = rejected.length ? 'rejected' : missingEvidence.length ? 'incomplete' : 'passed';
    return { schema: SEMANTIC_ADMISSION_SCHEMA, subject: { ...report.subject }, outcome, repositoryWideProof: false,
        ownership: { trusted: trustedOwnership, candidate: candidateOwnership },
        rules: { trusted: trustedQualification, candidate: candidateQualification, trustedViolations, candidateViolations },
        policyChange: change, missingEvidence, rejected,
        limitation: 'PASS proves declared source ownership and qualified import-graph laws, not every architectural property.' };
}

function parseArgs(argv) {
    const result = { repo: '.', report: null, policy: null, config: '.architecture.json', out: null, bootstrap: 'false' };
    const allowed = new Set(['--repo', '--report', '--policy', '--config', '--out', '--bootstrap']);
    for (let i = 0; i < argv.length; i += 2) {
        if (!allowed.has(argv[i]) || i + 1 >= argv.length) throw new TypeError('semantic admission: unknown or incomplete argument');
        result[argv[i].slice(2)] = argv[i + 1];
    }
    if (!result.report || !result.policy || !['true', 'false'].includes(result.bootstrap)) throw new TypeError('semantic admission: invalid required arguments');
    return result;
}

function writeVerdict(options, verdict) {
    if (options.out) { mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true }); writeFileSync(path.resolve(options.out), stableJson(verdict) + '\n'); }
    const trustedOwned = verdict.ownership?.trusted, candidateOwned = verdict.ownership?.candidate;
    const line = trustedOwned ? `architecture semantic admission: ${verdict.outcome.toUpperCase()} trusted-ownership=${trustedOwned.declaredFiles}/${trustedOwned.sourceFiles} candidate-ownership=${candidateOwned?.declaredFiles ?? 0}/${candidateOwned?.sourceFiles ?? 0} laws=${verdict.rules.trusted.length}`
        : `architecture semantic admission: ${verdict.outcome.toUpperCase()} (${[...(verdict.missingEvidence ?? []), ...(verdict.rejected ?? [])].join(', ')})`;
    if (verdict.outcome === 'passed') {
        console.log(line);
        return 0;
    }
    console.error(line);
    const details = [];
    for (const [label, owned] of [['trusted', trustedOwned], ['candidate', candidateOwned]]) {
        if (owned?.unmatched?.length) details.push(`${label} unmatched source: ${owned.unmatched.slice(0, 20).join(', ')}${owned.unmatched.length > 20 ? ` (+${owned.unmatched.length - 20} more)` : ''}`);
        if (owned?.staleComponents?.length) details.push(`${label} stale components: ${owned.staleComponents.slice(0, 20).join(', ')}${owned.staleComponents.length > 20 ? ` (+${owned.staleComponents.length - 20} more)` : ''}`);
    }
    const missing = verdict.missingEvidence ?? [], rejected = verdict.rejected ?? [];
    if (missing.length) details.push(`missing evidence: ${missing.join(', ')}`);
    if (rejected.length) details.push(`rejected: ${rejected.join(', ')}`);
    for (const violation of [...(verdict.rules?.trustedViolations ?? []), ...(verdict.rules?.candidateViolations ?? [])].slice(0, 20))
        details.push(`law ${violation.ruleId}: ${violation.witness}:${violation.line} -> ${violation.to}`);
    for (const detail of details) console.error(`  - ${detail}`);
    return verdict.outcome === 'rejected' ? 1 : 2;
}

export function run(argv) {
    const options = parseArgs(argv), repo = path.resolve(options.repo), git = new GitReader(repo), bootstrap = options.bootstrap === 'true';
    const report = parseJsonData(readRegularFile(path.resolve(options.report), 192 * 1024 * 1024).toString('utf8'));
    const policy = parseJsonData(readRegularFile(path.resolve(options.policy), 4 * 1024 * 1024).toString('utf8'));
    validateReport(report);
    if (!isOid(policy.commit) || policy.path !== options.config || policy.digest !== report.configuration?.digest)
        throw new TypeError('semantic admission: trusted policy does not match the report');
    const trustedRaw = git.readFile(policy.commit, options.config), candidateRaw = git.readFile(report.subject.commit, options.config);
    if (bootstrap) {
        if (trustedRaw !== null || candidateRaw === null) throw new TypeError('semantic admission: bootstrap requires absent trusted policy and committed candidate policy');
        const base = git.mergeBase(policy.commit, report.subject.commit), changed = git.changedPaths(base, report.subject.commit);
        if (changed.length !== 1 || changed[0] !== options.config) throw new TypeError('semantic admission: bootstrap is allowed only for a policy-only change');
        const candidateConfig = configFrom(parseJsonData(candidateRaw)), defaults = configFrom();
        if (stableJson(candidateConfig.excludeDirectories) !== stableJson(defaults.excludeDirectories))
            return writeVerdict(options, { schema: SEMANTIC_ADMISSION_SCHEMA, subject: { ...report.subject }, outcome: 'rejected', repositoryWideProof: false,
                missingEvidence: [], rejected: ['bootstrap-exclusion-policy-change'], limitation: 'Bootstrap may not hide source by changing exclusion policy.' });
        const verdict = semanticVerdict({ report, trustedConfig: candidateConfig, candidateConfig });
        verdict.bootstrap = true;
        return writeVerdict(options, verdict);
    }
    if (trustedRaw === null || candidateRaw === null) return writeVerdict(options, { schema: SEMANTIC_ADMISSION_SCHEMA, subject: { ...report.subject }, outcome: 'incomplete', repositoryWideProof: false,
        missingEvidence: [trustedRaw === null ? 'trusted-policy-missing' : null, candidateRaw === null ? 'candidate-policy-missing' : null].filter(Boolean), rejected: [],
        limitation: 'Every admitted repository must commit its product-owned .architecture.json.' });
    const trustedConfig = configFrom(parseJsonData(trustedRaw)), candidateConfig = configFrom(parseJsonData(candidateRaw));
    if (digest(trustedConfig) !== policy.digest) throw new TypeError('semantic admission: trusted config digest mismatch');
    return writeVerdict(options, semanticVerdict({ report, trustedConfig, candidateConfig }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try { process.exitCode = run(process.argv.slice(2)); }
    catch (error) { console.error(`architecture semantic admission failed: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}`); process.exitCode = 2; }
}
