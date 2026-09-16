#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync, existsSync, lstatSync, constants, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRepository, baselineVerdict, compareReports, createBaseline, reviewContext, stableJson } from './analyze.mjs';
import { GitReader } from './git.mjs';
import { configFrom, digest, BASELINE_SCHEMA, repoPath, baselineFrom, within } from './model.mjs';
import { createSyntaxCollector } from './native-syntax.mjs';
import { markdownReport } from './report.mjs';
import { parseJsonData, readRegularFile } from './input.mjs';
import { implementationDigest } from './provenance.mjs';
import { createFeedback, annotationLines, feedbackMarkdown, failureAnnotation } from './ci-feedback.mjs';
function parseArgs(argv) {
    if (!argv.length)
        return null;
    const o = { command: argv[0], repo: '.', ref: 'HEAD', out: 'architecture-evidence', paths: [] }, seen = new Set();
    const keys = ['--repo', '--ref', '--base', '--policy-ref', '--config', '--baseline', '--graph', '--base-graph', '--ast-grep', '--out', '--summary', '--repository', '--path', '--presentation'];
    for (let i = 1; i < argv.length; i++) {
        const k = argv[i];
        if (!keys.includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--'))
            throw new TypeError('Unknown or incomplete argument');
        const v = argv[++i];
        if (k === '--path') {
            o.paths.push(repoPath(v));
            continue;
        }
        if (seen.has(k))
            throw new TypeError('Repeated argument');
        seen.add(k);
        o[k.slice(2)] = v;
    }
    return o;
}
function readJson(file) {
    return parseJsonData(readRegularFile(file, 192 * 1024 * 1024).toString('utf8'));
}
function committedConfig(git, commit, name) { const source = git.readFile(commit, name); return { raw: source, config: configFrom(source === null ? {} : parseJsonData(source)) }; }
function graphInput(repo, candidate, authoritative) {
    if (!candidate)
        return null;
    const full = path.resolve(repo, candidate);
    if (authoritative) {
        const relative = path.relative(realpathSync(repo), realpathSync(full)).split(path.sep).join('/');
        const inside = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
        // Untracked files share the candidate's writable boundary. Being outside
        // that boundary is necessary, but producer authority still belongs to the caller.
        if (inside)
            throw new Error('Authoritative graph must be generated outside the analyzed checkout; untracked or candidate-committed graph evidence is not trusted');
    }
    return readJson(full);
}
function safeOutput(directory) {
    const full = path.resolve(directory);
    let current = full;
    while (true) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink())
            throw new Error('Output must not traverse symlinks');
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    mkdirSync(full, { recursive: true });
    return full;
}
function writeEvidence(directory, report, markdown, comparison, ratchet, context, policy, feedback = null) {
    const files = { 'report.json': stableJson(report) + '\n', 'report.md': markdown, 'graph.json': stableJson(report.structure) + '\n', 'history.json': stableJson(report.history) + '\n',
        'delta.json': comparison ? stableJson(comparison) + '\n' : null, 'ratchet.json': ratchet ? stableJson(ratchet) + '\n' : null, 'context.json': context ? stableJson(context) + '\n' : null, 'policy.json': stableJson(policy) + '\n',
        'ci-findings.json': feedback ? stableJson(feedback) + '\n' : null, 'ci-summary.md': feedback ? feedbackMarkdown(feedback) : null };
    const dir = safeOutput(directory);
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        if (existsSync(target) && lstatSync(target).isSymbolicLink())
            throw new Error('Evidence file must not be a symlink');
        if (content === null) {
            if (existsSync(target))
                unlinkSync(target);
            continue;
        }
        writeFileSync(target, content, { flag: constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), mode: 0o600 });
    }
}
export function run(argv) {
    const o = parseArgs(argv);
    if (!o || !['observe', 'context', 'check', 'baseline'].includes(o.command)) {
        console.error('usage: architecture/cli.mjs <observe|context|check|baseline> --repo DIR [--ref SHA] [--base SHA] [--ast-grep BIN] [--path PATH] [--out DIR]');
        return 2;
    }
    const presentation = o.presentation ?? 'detailed';
    if (!['detailed', 'github'].includes(presentation) || presentation === 'github' && o.command === 'baseline')
        throw new TypeError('Unsupported presentation for command');
    const repo = path.resolve(o.repo), git = new GitReader(repo), commit = git.oid(o.ref), requestedBase = o.base ? git.oid(o.base) : null;
    const base = requestedBase ? git.mergeBase(requestedBase, commit) : null, policyCommit = o['policy-ref'] ? git.oid(o['policy-ref']) : requestedBase ?? commit;
    const configPath = o.config ?? '.architecture.json', trusted = committedConfig(git, policyCommit, configPath), candidate = committedConfig(git, commit, configPath), config = trusted.config;
    const policy = { commit: policyCommit, path: configPath, digest: digest(config), changed: trusted.raw !== candidate.raw };
    const syntax = o['ast-grep'] ? createSyntaxCollector(o['ast-grep']) : null;
    if ((o.graph && !o['base-graph'] && base) || (o['base-graph'] && (!o.graph || !base)))
        throw new Error('External graph comparison requires both sides');
    const authoritativeGraph = o.command === 'check' || o.command === 'baseline';
    const subjectGraph = graphInput(repo, o.graph, authoritativeGraph);
    const runtime = { implementation: implementationDigest(), node: process.version };
    const report = analyzeRepository({ git, commit, config, syntax, externalGraph: subjectGraph, runtime });
    const baseGraph = base ? graphInput(repo, o['base-graph'], authoritativeGraph) : null;
    const before = base ? analyzeRepository({ git, commit: base, config, syntax, externalGraph: baseGraph, runtime }) : null;
    const comparison = before ? { ...compareReports(before, report), requestedBase } : null;
    const selected = o.paths.length ? o.paths : base ? git.changedPaths(base, commit) : [];
    const context = selected.length ? reviewContext(before ?? report, selected, config) : null;
    if (o.command === 'baseline') {
        if (!report.structure.coverage.complete)
            throw new Error('Cannot authorize a baseline from incomplete structural evidence');
        const target = path.resolve(repo, o.baseline ?? '.architecture-baseline.json');
        safeOutput(path.dirname(target));
        if (existsSync(target) && lstatSync(target).isSymbolicLink())
            throw new Error('Baseline must not be symlink');
        writeFileSync(target, stableJson(createBaseline(report)) + '\n', { flag: constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), mode: 0o600 });
        return 0;
    }
    let ratchet = null, baselineExpansion = false;
    if (o.baseline) {
        const source = git.readFile(commit, o.baseline);
        if (source === null)
            throw new Error('Candidate baseline is not committed');
        const candidateBaseline = baselineFrom(parseJsonData(source));
        const trustedSource = git.readFile(policyCommit, o.baseline);
        const trustedBaseline = baselineFrom(trustedSource ? parseJsonData(trustedSource) : { schema: BASELINE_SCHEMA, accepted: [] });
        const allowed = new Set(trustedBaseline.accepted.map(e => e.fingerprint));
        baselineExpansion = candidateBaseline.accepted.some(e => !allowed.has(e.fingerprint));
        ratchet = baselineVerdict(report, candidateBaseline);
    }
    const markdown = markdownReport(report, comparison, ratchet, context, o.repository, policy);
    // Publication projects the existing outcome; it never changes admission policy.
    const finish = status => {
        const feedback = presentation === 'github' ? createFeedback({ report, delta: comparison, ratchet, mode: o.command, exitCode: status, policy, repository: o.repository,
            replay: { baseline: o.baseline ?? null, externalGraph: Boolean(o.graph), protocols: Boolean(o.protocols) } }) : null;
        writeEvidence(path.resolve(repo, o.out), report, markdown, comparison, ratchet, context, policy, feedback);
        const visible = feedback ? feedbackMarkdown(feedback) : markdown;
        if (o.summary) appendFileSync(o.summary, visible + '\n');
        if (feedback) {
            for (const line of annotationLines(feedback)) console.log(line);
            // Canonical JSON escapes embedded newlines; candidate prose cannot
            // become a workflow command. Logs keep agent evidence without storage.
            console.log('::group::Architecture machine feedback (JSON)');
            console.log(stableJson(feedback));
            console.log('::endgroup::');
        }
        console.log(visible);
        console.log(`architecture evidence: ${commit} identity=${report.identity}`);
        return status;
    };
    if (o.command === 'check') {
        if (config.rules.some(rule => !report.structure.nodes.some(n => !n.external && n.paths.some(p => (rule.from ?? rule.scope).some(prefix => within(p, prefix)))))) {
            console.error('architecture check: INCOMPLETE; rule source scope matched no observed paths');
            return finish(2);
        }
        const ambiguousScope = config.rules.some(rule => report.structure.nodes.some(n => !n.external &&
            [rule.scope, rule.to].filter(Boolean).some(prefixes => n.paths.some(p => prefixes.some(prefix => within(p, prefix))) && !n.paths.every(p => prefixes.some(prefix => within(p, prefix))))));
        if (!requestedBase && !o['policy-ref'] || !report.configuration.declaredRules || !report.structure.coverage.complete || comparison && !comparison.comparable || ambiguousScope) {
            console.error('architecture check: INCOMPLETE; no qualified proof of all declared laws');
            return finish(2);
        }
        if (!o.baseline && report.violations.length || ratchet && !ratchet.valid || baselineExpansion)
            return finish(1);
    }
    return finish(0);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = run(process.argv.slice(2));
    }
    catch (error) {
        if (process.argv.includes('--presentation') && process.argv.includes('github')) console.log(failureAnnotation());
        console.error(`architecture observer failed: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}`);
        process.exitCode = 2;
    }
}
