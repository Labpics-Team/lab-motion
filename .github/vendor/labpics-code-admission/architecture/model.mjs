import { createHash } from 'node:crypto';
import path from 'node:path';
export const TOOL_VERSION = '0.3.0';
export const REPORT_SCHEMA = 'labpics.architecture/report/v2';
export const GRAPH_SCHEMA = 'labpics.architecture/graph/v2';
export const BASELINE_SCHEMA = 'labpics.architecture/baseline/v1';
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const unique = values => [...new Set(values)].sort(compareText);
export function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort(compareText).map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
    if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || (typeof value === 'number' && !Number.isFinite(value)))
        throw new TypeError('Value is not canonical JSON');
    return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value)).digest('hex');
export const isOid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export function object(value, allowed, where) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError(`${where}: expected object`);
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new TypeError(`${where}: unknown field`);
}
export function text(value, where, max = 4096) {
    if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
        throw new TypeError(`${where}: invalid text`);
    return value;
}
export function number(value, min, max, where, integer = true) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
        throw new TypeError(`${where}: out of range`);
    return value;
}
export function repoPath(value) {
    text(value, 'repository path');
    if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\') || value.split('/').some(s => !s || s === '.' || s === '..'))
        throw new TypeError('Non-canonical repository path');
    return value;
}
function prefixes(values, where) {
    if (!Array.isArray(values) || !values.length || values.length > 1000)
        throw new TypeError(`${where}: expected nonempty prefix array`);
    return unique(values.map(v => v === '' ? v : repoPath(v.replace(/\/$/, ''))));
}
export const within = (candidate, prefix) => prefix === '' || candidate === prefix || candidate.startsWith(`${prefix}/`);
export function configFrom(value = {}) {
    object(value, ['schemaVersion', 'history', 'excludeDirectories', 'components', 'rules'], 'configuration');
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
        throw new TypeError('Unsupported configuration schemaVersion');
    const fields = ['maxCommits', 'windowDays', 'maxChangesetFiles', 'minShared', 'minJaccard', 'minConditional', 'minLift', 'maxPairs'];
    if (value.history !== undefined)
        object(value.history, fields, 'history');
    const history = { maxCommits: 2500, windowDays: 365, maxChangesetFiles: 80, minShared: 4, minJaccard: 0.35, minConditional: 0.8, minLift: 1.5, maxPairs: 300000, ...value.history };
    for (const [key, min, max] of [['maxCommits', 1, 100000], ['windowDays', 1, 36500], ['maxChangesetFiles', 2, 1000], ['minShared', 1, 100000], ['maxPairs', 1, 5000000]])
        number(history[key], min, max, `history.${key}`);
    for (const key of ['minJaccard', 'minConditional'])
        number(history[key], 0, 1, `history.${key}`, false);
    number(history.minLift, 0, 100000, 'history.minLift', false);
    const excluded = value.excludeDirectories ?? ['.git', '.next', '.turbo', 'coverage', 'dist', 'node_modules', 'target', 'vendor'];
    if (!Array.isArray(excluded) || excluded.length > 1000 || excluded.some(s => typeof s !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(s)))
        throw new TypeError('Invalid excludeDirectories');
    if (!Array.isArray(value.components ?? []) || (value.components?.length ?? 0) > 10000)
        throw new TypeError('Invalid components');
    const ids = new Set();
    const components = (value.components ?? []).map(c => {
        object(c, ['id', 'prefixes'], 'component');
        text(c.id, 'component.id', 512);
        if (ids.has(c.id) || (c.id.startsWith('external:') || c.id.startsWith('directory:')))
            throw new TypeError('Duplicate or reserved component identity');
        ids.add(c.id);
        return { id: c.id, prefixes: prefixes(c.prefixes, 'component.prefixes') };
    }).sort((a, b) => compareText(a.id, b.id));
    // Index actual path ancestors instead of comparing every pair of prefixes.
    const prefixOwners = new Map();
    for (const component of components)
        for (const prefix of component.prefixes) {
            if (prefixOwners.has(prefix))
                throw new TypeError('Overlapping components');
            prefixOwners.set(prefix, component.id);
        }
    for (const [prefix, id] of prefixOwners) {
        const segments = prefix.split('/');
        for (let depth = 0; depth < segments.length; depth++) {
            const owner = prefixOwners.get(segments.slice(0, depth).join('/'));
            if (owner !== undefined && owner !== id)
                throw new TypeError('Overlapping components');
        }
    }
    if (!Array.isArray(value.rules ?? []) || (value.rules?.length ?? 0) > 2000)
        throw new TypeError('Invalid rules');
    ids.clear();
    const rules = (value.rules ?? []).map(r => {
        object(r, ['id', 'kind', 'from', 'to', 'scope', 'rationale'], 'rule');
        text(r.id, 'rule.id', 512);
        text(r.rationale, 'rule.rationale');
        if (ids.has(r.id))
            throw new TypeError('Duplicate rule');
        ids.add(r.id);
        if (r.kind === 'forbidden-dependency' || r.kind === 'forbidden-reachability') {
            if (r.scope !== undefined)
                throw new TypeError('Forbidden dependency does not accept scope');
            return { id: r.id, kind: r.kind, from: prefixes(r.from, 'rule.from'), to: prefixes(r.to, 'rule.to'), rationale: r.rationale };
        }
        if (r.kind === 'acyclic') {
            if (r.from !== undefined || r.to !== undefined)
                throw new TypeError('Acyclic accepts scope only');
            return { id: r.id, kind: r.kind, scope: prefixes(r.scope, 'rule.scope'), rationale: r.rationale };
        }
        throw new TypeError('Unsupported rule kind');
    }).sort((a, b) => compareText(a.id, b.id));
    return { schemaVersion: 1, history, excludeDirectories: unique(excluded), components, rules };
}
export function classifyPath(candidate, config) {
    const segments = candidate.split('/'), name = segments.at(-1);
    if (segments.some(s => config.excludeDirectories.includes(s)))
        return 'excluded-directory';
    // A concurrency module named distributed-lock.ts is source, not a package
    // lockfile. Match actual artifact names/extensions, never an embedded word.
    if (['go.sum', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-lock.yml', 'bun.lockb'].includes(name) || name.endsWith('.lock'))
        return 'lockfile';
    if (/\.(?:md|mdx|rst|txt|svg|png|jpe?g|gif|webp|pdf|woff2?|ttf)$/i.test(candidate))
        return 'documentation-or-asset';
    if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test|\.spec|_test)\.[^.]+$|(?:^|\/)(?:test_[^/]*|conftest)\.py$/i.test(candidate))
        return 'test';
    if (/\.(?:[cm]?[jt]sx?|go|rs|py|java|kt|kts|cs|c|cc|cpp|cxx|h|hpp|rb|php|swift|scala|vue|svelte|ex|exs)$/i.test(candidate))
        return 'source';
    if (/\.(?:json|jsonc|toml|ya?ml|sh|bash|ps1|tf|hcl|proto|graphql|sql)$/i.test(candidate) || /^(?:Dockerfile|Makefile|go\.mod|\.gitignore|\.gitattributes)$/.test(name))
        return 'configuration';
    return 'other';
}
export const historyEligible = (p, c) => ['source', 'configuration'].includes(classifyPath(p, c));
export const graphEligible = (p, c) => classifyPath(p, c) === 'source';
export function componentFor(candidate, config) {
    const declared = config.components.find(c => c.prefixes.some(p => within(candidate, p)));
    const dir = path.posix.dirname(candidate);
    return declared ? { id: declared.id, basis: 'declared' } : { id: `directory:${dir === '.' ? '(root)' : dir}`, basis: 'directory-fallback' };
}
export function quantile(values, q) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b), i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
export function graphFrom(value, commit, treePaths = null) {
    object(value, ['schema', 'commit', 'producer', 'nodes', 'edges', 'limitations', 'coverage'], 'graph');
    if (value.schema !== GRAPH_SCHEMA || value.commit !== commit)
        throw new TypeError('Graph schema or subject commit mismatch');
    object(value.producer, ['name', 'version', 'digest'], 'graph.producer');
    text(value.producer.name, 'producer.name', 512);
    text(value.producer.version, 'producer.version', 512);
    if (value.producer.digest !== undefined && !/^[a-f0-9]{64}$/.test(value.producer.digest))
        throw new TypeError('Invalid producer digest');
    if (!Array.isArray(value.nodes) || value.nodes.length > 100000 || !Array.isArray(value.edges) || value.edges.length > 1000000)
        throw new TypeError('Graph resource budget exceeded');
    const ids = new Set(), owners = new Map();
    const nodes = value.nodes.map(n => {
        object(n, ['id', 'external', 'paths', 'basis'], 'node');
        text(n.id, 'node.id');
        text(n.basis, 'node.basis', 512);
        if (ids.has(n.id) || typeof n.external !== 'boolean' || !Array.isArray(n.paths) || (n.external ? n.paths.length : !n.paths.length))
            throw new TypeError('Invalid graph node');
        ids.add(n.id);
        const paths = unique(n.paths.map(repoPath));
        for (const p of paths) {
            if (treePaths && !treePaths.has(p))
                throw new TypeError('Graph path absent from subject');
            if (owners.has(p))
                throw new TypeError('Ambiguous graph path ownership');
            owners.set(p, n.id);
        }
        return { ...n, paths };
    }).sort((a, b) => compareText(a.id, b.id));
    const edges = value.edges.map(e => {
        object(e, ['from', 'to', 'kind', 'path', 'line'], 'edge');
        repoPath(e.path);
        if (!ids.has(e.from) || !ids.has(e.to) || owners.get(e.path) !== e.from)
            throw new TypeError('Invalid graph edge endpoint or witness');
        if (!['import', 'type-import', 're-export', 'dynamic-import', 'require', 'declared-dependency'].includes(e.kind))
            throw new TypeError('Unsupported edge kind');
        number(e.line, 1, 1000000000, 'edge.line');
        return { ...e };
    });
    const dedup = new Map(edges.map(e => [stableJson(e), e]));
    if (!Array.isArray(value.limitations) || value.limitations.length > 100000)
        throw new TypeError('Invalid graph limitations');
    const limitations = value.limitations.map(l => {
        object(l, ['path', 'reason'], 'limitation');
        if (l.path !== null)
            repoPath(l.path);
        text(l.reason, 'limitation.reason');
        return { ...l };
    });
    object(value.coverage, ['sourceFiles', 'parsedFiles', 'ratio', 'omittedSnapshotFiles', 'complete'], 'coverage');
    const c = value.coverage;
    number(c.sourceFiles, 0, 1000000, 'sourceFiles');
    number(c.parsedFiles, 0, c.sourceFiles, 'parsedFiles');
    number(c.omittedSnapshotFiles, 0, 1000000, 'omittedSnapshotFiles');
    const ratio = c.sourceFiles ? c.parsedFiles / c.sourceFiles : 0;
    if (c.ratio !== ratio || typeof c.complete !== 'boolean' || (c.complete && (c.parsedFiles !== c.sourceFiles || !c.sourceFiles || limitations.length)))
        throw new TypeError('Inconsistent graph coverage');
    return { schema: GRAPH_SCHEMA, commit, producer: { ...value.producer }, nodes, edges: [...dedup].sort(([a], [b]) => compareText(a, b)).map(([, e]) => e), limitations, coverage: { ...c } };
}
export function baselineFrom(value) {
    object(value, ['schema', 'accepted'], 'baseline');
    if (value.schema !== BASELINE_SCHEMA || !Array.isArray(value.accepted) || value.accepted.length > 100000)
        throw new TypeError('Unsupported baseline schema');
    const seen = new Set();
    const accepted = value.accepted.map(e => {
        object(e, ['fingerprint', 'ruleId'], 'baseline entry');
        text(e.ruleId, 'ruleId', 512);
        if (!/^[a-f0-9]{64}$/.test(e.fingerprint) || seen.has(e.fingerprint))
            throw new TypeError('Invalid baseline fingerprint');
        seen.add(e.fingerprint);
        return { ...e };
    }).sort((a, b) => compareText(a.fingerprint, b.fingerprint));
    return { schema: BASELINE_SCHEMA, accepted };
}
