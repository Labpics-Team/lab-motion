import { compareText, digest, isOid, number, object, repoPath, stableJson, text } from './model.mjs';

const SCHEMA = 'labpics.architecture/protocols/v1';
const PROPERTIES = ['durable-success-after-commit', 'analysis-subject-identity', 'qualified-external-ordinal'];
const LIMITATIONS = [
    'Executed traces are a bounded sample, not a repository-wide proof or automatic source-code discovery.',
    'Source hashes bind witnesses to Git bytes; they do not authenticate probe semantics, instrumentation completeness or authority.',
    'The probe must observe actual external publication, actual analyzed bytes/generation and the actual index used at the sink.',
    'Generation equality excludes ABA only when the workspace owner guarantees non-reused generations.',
    'Unknown transaction outcome is not rollback evidence and does not authorize replay.',
];
const DEFINITIONS = {
    'durable-success-after-commit': {
        propertyStatement: 'An external claim of committed success must follow confirmation of its own transaction commit.',
        lawfulCounterexample: 'Buffered output, an explicit accepted/pending acknowledgement, or publication after confirmed commit.',
        falsifier: 'Show that the observed output was not externally visible or did not claim durable completion, or that this transaction committed before publication.',
        consequence: 'A consumer may act on success although durable state is absent or its outcome remains unknown.',
    },
    'analysis-subject-identity': {
        propertyStatement: 'The requested, actually analyzed and reported repository/revision must agree; mutable input must remain clean and on the same generation.',
        lawfulCounterexample: 'Analysis and report use the same verified immutable snapshot, independently of a subsequently moving branch.',
        falsifier: 'Bind every analyzer input and the report to the requested snapshot; prove the recorded mismatch or dirty/generation observation belongs to another workspace.',
        consequence: 'A review can certify a different program from the revision named in its report.',
    },
    'qualified-external-ordinal': {
        propertyStatement: 'A consumed external ordinal must be a safe integer inside the bounds of the collection actually accessed.',
        lawfulCounterexample: 'A boundary parser produces a valid index, or invalid input is rejected before access; validation uses current bounds.',
        falsifier: 'Show that the sink rejected the input before access, or the captured value/length is not the actual ordinal/bound.',
        consequence: 'An external value can cause a panic, an unintended lookup or an access outside the domain collection.',
    },
};
const fail = message => { throw new TypeError(`protocol evidence: ${message}`); };
function enumeration(value, allowed) { if (!allowed.includes(value)) fail('invalid enum'); }
function bool(value) { if (typeof value !== 'boolean') fail('expected boolean'); }
function id(value) { return text(value, 'protocol identity', 512); }
function identity(value) {
    object(value, ['repository', 'commit'], 'analyzed identity');
    text(value.repository, 'analyzed repository', 512);
    if (!isOid(value.commit)) fail('invalid analyzed commit');
}
function scalar(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 128) return;
    fail('ordinal must be a finite JSON scalar, not arbitrary response content');
}
function list(value, max, name) {
    if (!Array.isArray(value) || value.length > max) fail(`invalid ${name} or resource budget exceeded`);
    return value;
}
function validateEvent(e, sequence, entries, files, lineCounts) {
    object(e, ['sequence', 'kind', 'operation', 'witness', 'data'], 'protocol event');
    if (e.sequence !== sequence) fail('event sequence is missing, duplicated or reordered');
    id(e.operation);
    object(e.witness, ['path', 'blob', 'line'], 'protocol witness');
    repoPath(e.witness.path);
    const entry = entries.get(e.witness.path), source = files.get(e.witness.path);
    if (!entry || !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob' || entry.oid !== e.witness.blob || typeof source !== 'string')
        fail('source witness does not match an available regular Git blob');
    if (!lineCounts.has(e.witness.path)) lineCounts.set(e.witness.path, source.split('\n').length - (source.endsWith('\n') ? 1 : 0));
    const lines = lineCounts.get(e.witness.path);
    number(e.witness.line, 1, lines, 'protocol witness line');
    const d = e.data;
    switch (e.kind) {
        case 'transaction.begin': object(d, [], 'transaction begin'); break;
        case 'transaction.settle':
            object(d, ['outcome'], 'transaction settlement'); enumeration(d.outcome, ['committed', 'aborted', 'unknown']); break;
        case 'result.publish':
            object(d, ['claim', 'visibility'], 'result publication');
            enumeration(d.claim, ['committed', 'accepted', 'failure']); enumeration(d.visibility, ['external', 'buffered']); break;
        case 'analysis.begin':
            object(d, ['expected', 'actual', 'generation', 'dirty'], 'analysis begin'); identity(d.expected); identity(d.actual); id(d.generation); bool(d.dirty); break;
        case 'analysis.end':
            object(d, ['actual', 'generation', 'dirty'], 'analysis end'); identity(d.actual); id(d.generation); bool(d.dirty); break;
        case 'analysis.publish': object(d, ['reported'], 'analysis publication'); identity(d.reported); break;
        case 'ordinal.input': object(d, ['value'], 'ordinal input'); scalar(d.value); break;
        case 'ordinal.consume':
            object(d, ['index', 'length', 'outcome'], 'ordinal consumption'); scalar(d.index);
            number(d.length, 0, Number.MAX_SAFE_INTEGER, 'collection length'); enumeration(d.outcome, ['used', 'rejected']); break;
        default: fail('unknown event kind');
    }
}
function candidate(property, trace, operation, events, observed) {
    const witnesses = [...new Map(events.map(e => [stableJson(e.witness), e.witness]))].sort(([a], [b]) => compareText(a, b)).map(([, w]) => ({ ...w }));
    const site = events.at(-1);
    return { property, classification: 'investigation-candidate', ...DEFINITIONS[property], scenario: trace.scenario, operation,
        fingerprint: digest({ property, scenario: trace.scenario, path: site.witness.path, line: site.witness.line }),
        events: [...new Set(events.map(e => e.sequence))].sort((a, b) => a - b), witnesses, observed: structuredClone(observed) };
}
// Events come from a separately reviewed native probe. This reader never runs
// candidate code, infers protocol roles from names, or promotes a trace to policy.
export function diagnoseProtocols(corpus, snapshot) {
    if (corpus === null || corpus === undefined) return { status: 'not-collected', mergeBlocking: false, repositoryWideProof: false, candidates: [], limitations: [...LIMITATIONS] };
    object(corpus, ['schema', 'subject', 'producer', 'plannedScenarios', 'traces', 'limitations'], 'protocol corpus');
    object(corpus.subject, ['commit', 'tree'], 'protocol subject');
    if (corpus.schema !== SCHEMA || corpus.subject.commit !== snapshot.commit || corpus.subject.tree !== snapshot.tree) fail('schema or immutable subject mismatch');
    object(corpus.producer, ['name', 'version', 'digest'], 'protocol producer');
    id(corpus.producer.name); id(corpus.producer.version);
    if (typeof corpus.producer.digest !== 'string' || !/^[a-f0-9]{64}$/.test(corpus.producer.digest)) fail('invalid producer digest');
    const plan = list(corpus.plannedScenarios, 1000, 'scenario plan').map(id);
    if (!plan.length || new Set(plan).size !== plan.length) fail('empty or duplicate scenario plan');
    const limitations = list(corpus.limitations, 100, 'limitations').map(v => text(v, 'probe limitation'));
    const traces = list(corpus.traces, 1000, 'traces'), entries = new Map(snapshot.entries.map(e => [e.path, e]));
    const lineCounts = new Map(), seen = new Set(), candidates = [], properties = Object.fromEntries(PROPERTIES.map(p => [p, { exercised: 0, openOperations: 0, incompleteTraces: 0, candidates: 0 }]));
    let totalEvents = 0, emptyTraces = 0;
    for (const trace of traces) {
        object(trace, ['scenario', 'complete', 'events'], 'protocol trace'); id(trace.scenario); bool(trace.complete);
        if (!plan.includes(trace.scenario) || seen.has(trace.scenario)) fail('unplanned or duplicate scenario');
        seen.add(trace.scenario);
        list(trace.events, 10000, 'events'); totalEvents += trace.events.length;
        if (totalEvents > 100000) fail('total event resource budget exceeded');
        if (!trace.events.length) emptyTraces++;
        const txs = new Map(), analyses = new Map(), ordinals = new Map(), touched = new Set();
        const start = (map, e) => { if (map.has(e.operation)) fail('duplicate operation begin'); const s = { begin: e, uses: 0 }; map.set(e.operation, s); return s; };
        const get = (map, e) => { const s = map.get(e.operation); if (!s) fail('event has no owning operation'); return s; };
        for (const [sequence, e] of trace.events.entries()) {
            validateEvent(e, sequence, entries, snapshot.files, lineCounts);
            const d = e.data;
            if (e.kind.startsWith('transaction.') || e.kind === 'result.publish') {
                const property = PROPERTIES[0]; touched.add(property);
                if (e.kind === 'transaction.begin') { start(txs, e).pending = []; continue; }
                const tx = get(txs, e);
                if (e.kind === 'transaction.settle') {
                    if (tx.end) fail('transaction settled more than once'); tx.end = e;
                    for (const c of tx.pending) { c.observed.terminalOutcome = d.outcome; c.events.push(e.sequence);
                        c.witnesses = [...new Map([...c.witnesses, e.witness].map(w => [stableJson(w), { ...w }]))].sort(([a], [b]) => compareText(a, b)).map(([, w]) => w); }
                } else {
                    tx.uses++; properties[property].exercised++;
                    const state = tx.end?.data.outcome ?? 'pending';
                    if (d.visibility === 'external' && d.claim === 'committed' && state !== 'committed') {
                        const c = candidate(property, trace, e.operation, [tx.begin, ...(tx.end ? [tx.end] : []), e], { stateAtPublication: state, terminalOutcome: tx.end?.data.outcome ?? null });
                        candidates.push(c); if (!tx.end) tx.pending.push(c);
                    }
                }
            } else if (e.kind.startsWith('analysis.')) {
                const property = PROPERTIES[1]; touched.add(property);
                if (e.kind === 'analysis.begin') { start(analyses, e); continue; }
                const a = get(analyses, e);
                if (e.kind === 'analysis.end') { if (a.end) fail('analysis ended more than once'); a.end = e; continue; }
                if (!a.end) fail('analysis report preceded its completion');
                a.uses++; properties[property].exercised++;
                const b = a.begin.data, z = a.end.data, reasons = [];
                if (stableJson(b.expected) !== stableJson(b.actual)) reasons.push('input-does-not-match-request');
                if (stableJson(b.actual) !== stableJson(z.actual)) reasons.push('analyzed-subject-changed');
                if (stableJson(b.expected) !== stableJson(d.reported)) reasons.push('reported-subject-does-not-match-request');
                if (b.dirty || z.dirty) reasons.push('analyzed-worktree-is-dirty');
                if (b.generation !== z.generation) reasons.push('analyzed-generation-changed');
                if (reasons.length) candidates.push(candidate(property, trace, e.operation, [a.begin, a.end, e], { reasons, requested: b.expected, atStart: b.actual, atEnd: z.actual, reported: d.reported }));
            } else {
                const property = PROPERTIES[2]; touched.add(property);
                if (e.kind === 'ordinal.input') { start(ordinals, e); continue; }
                const value = get(ordinals, e); value.uses++; properties[property].exercised++;
                if (d.outcome === 'used' && (!Number.isSafeInteger(d.index) || d.index < 0 || d.index >= d.length))
                    candidates.push(candidate(property, trace, e.operation, [value.begin, e], { received: value.begin.data.value, index: d.index, length: d.length, outcome: d.outcome }));
            }
        }
        for (const [property, operations] of [[PROPERTIES[0], txs], [PROPERTIES[1], analyses], [PROPERTIES[2], ordinals]])
            properties[property].openOperations += [...operations.values()].filter(s => !s.uses || property !== PROPERTIES[2] && !s.end).length;
        if (!trace.complete) for (const p of touched) properties[p].incompleteTraces++;
    }
    const missingScenarios = plan.filter(p => !seen.has(p));
    for (const p of PROPERTIES) {
        const s = properties[p]; s.candidates = candidates.filter(c => c.property === p).length;
        s.status = s.candidates ? 'counterexamples-observed' : s.exercised === 0 ? 'not-exercised' : missingScenarios.length || emptyTraces || limitations.length || s.openOperations || s.incompleteTraces ? 'incomplete' : 'no-counterexample-in-supplied-traces';
    }
    const incomplete = missingScenarios.length || emptyTraces || limitations.length || traces.some(t => !t.complete) || Object.values(properties).some(p => p.openOperations) || !Object.values(properties).some(p => p.exercised);
    return { status: candidates.length ? 'counterexamples-observed' : incomplete ? 'incomplete' : 'no-counterexample-in-supplied-traces',
        mergeBlocking: false, repositoryWideProof: false, subject: { ...corpus.subject }, producer: { ...corpus.producer }, corpusDigest: digest(corpus),
        plannedScenarios: [...plan].sort(compareText), coverage: { observedScenarios: traces.length, missingScenarios, emptyTraces, events: totalEvents, completeTraces: traces.filter(t => t.complete).length },
        properties, candidates: candidates.sort((a, b) => compareText(a.fingerprint, b.fingerprint) || a.events.at(-1) - b.events.at(-1)), limitations: [...LIMITATIONS, ...limitations] };
}
function occurrences(diagnostics) {
    const groups = new Map();
    for (const c of diagnostics?.candidates ?? []) {
        if (!groups.has(c.fingerprint)) groups.set(c.fingerprint, []);
        groups.get(c.fingerprint).push(c);
    }
    return groups;
}
export function compareProtocolDiagnostics(before, after) {
    const b = occurrences(before), a = occurrences(after);
    // A fingerprint identifies a site, not one firing of that site. Preserve
    // multiplicity without pretending event offsets are stable across runs.
    const observations = group => stableJson(group.map(c => stableJson(c.observed)).sort(compareText));
    const occurrenceChanges = [...a].filter(([key, group]) => b.has(key) && observations(b.get(key)) !== observations(group))
        .map(([fingerprint, group]) => ({ fingerprint, beforeCount: b.get(fingerprint).length, afterCount: group.length, before: b.get(fingerprint), after: group }))
        .sort((left, right) => compareText(left.fingerprint, right.fingerprint));
    return { newlyObserved: [...a].filter(([key]) => !b.has(key)).flatMap(([, group]) => group), noLongerObserved: [...b].filter(([key]) => !a.has(key)).flatMap(([, group]) => group), occurrenceChanges,
        sameProbeAndPlan: Boolean(before?.producer && after?.producer && stableJson(before.producer) === stableJson(after.producer) && stableJson(before.plannedScenarios) === stableJson(after.plannedScenarios)),
        provesFix: false, limitation: 'Counts and outcomes can change with executions or coverage; neither disappearance nor fewer occurrences proves a repair.' };
}
export function protocolMarkdown(diagnostics) {
    if (!diagnostics || diagnostics.status === 'not-collected') return '\n## Protocol diagnostics\n\nNot collected; no behavioral absence claim.\n';
    // Only fixed vocabulary and computed numbers enter Markdown. Probe names,
    // paths, observed external values and prose remain data in report.json.
    const lines = ['\n## Protocol diagnostics', '', 'Observational execution evidence; not a repository-wide proof or a merge gate.', ''];
    for (const p of PROPERTIES) lines.push(`- ${p}: ${diagnostics.properties[p].candidates} candidates; ${diagnostics.properties[p].exercised} observed sink events.`);
    lines.push('', 'Exact source witnesses, counterexamples, falsifiers and coverage limitations are in report.json.', '');
    return lines.join('\n');
}