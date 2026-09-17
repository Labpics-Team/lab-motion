import { BASELINE_SCHEMA, REPORT_SCHEMA, TOOL_VERSION, baselineFrom, compareText, componentFor, digest, graphEligible, graphFrom, object, text, stableJson, within } from './model.mjs';
import { buildSourceGraph } from './source-graph.mjs';
import { analyzeHistory, queryCoupling } from './history.mjs';
import { diagnoseProtocols, compareProtocolDiagnostics } from './protocols.mjs';
export function stronglyConnected(graph) {
    const adj = new Map(graph.nodes.filter(n => !n.external).map(n => [n.id, new Set()])), reverse = new Map([...adj].map(([id]) => [id, new Set()]));
    for (const e of graph.edges)
        if (adj.has(e.from) && adj.has(e.to)) {
            adj.get(e.from).add(e.to);
            reverse.get(e.to).add(e.from);
        }
    // Iterative Kosaraju avoids the JS call-stack limit on large import chains.
    const seen = new Set(), order = [];
    for (const root of [...adj.keys()].sort(compareText))
        if (!seen.has(root)) {
            seen.add(root);
            const stack = [[root, [...adj.get(root)][Symbol.iterator]()]];
            while (stack.length) {
                const frame = stack.at(-1), next = frame[1].next();
                if (next.done) {
                    order.push(frame[0]);
                    stack.pop();
                }
                else if (!seen.has(next.value)) {
                    seen.add(next.value);
                    stack.push([next.value, [...adj.get(next.value)][Symbol.iterator]()]);
                }
            }
        }
    seen.clear();
    const groups = [];
    for (const root of order.reverse())
        if (!seen.has(root)) {
            const stack = [root], group = [];
            seen.add(root);
            while (stack.length) {
                const node = stack.pop();
                group.push(node);
                for (const next of reverse.get(node))
                    if (!seen.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
            }
            if (group.length > 1 || adj.get(root).has(root))
                groups.push(group.sort(compareText));
        }
    return groups.sort((a, b) => compareText(a.join('\0'), b.join('\0')));
}
function projection(graph, config) {
    const pathOwner = new Map(), nodes = new Map();
    for (const n of graph.nodes) {
        if (n.external) {
            pathOwner.set(n.id, n.id);
            nodes.set(n.id, n);
            continue;
        }
        const owners = n.paths.map(f => componentFor(f, config));
        const components = new Set(owners.map(o => o.id));
        // External sensors may choose package-level units crossing declared cuts.
        // Do not join their IDs to unrelated history IDs by spelling coincidence.
        if (components.size !== 1)
            continue;
        const id = [...components][0], basis = owners.every(o => o.basis === 'declared') ? 'declared' : 'directory-fallback';
        pathOwner.set(n.id, id);
        const existing = nodes.get(id) ?? { id, external: false, paths: [], basis };
        existing.paths.push(...n.paths);
        if (existing.basis !== basis)
            existing.basis = 'mixed';
        nodes.set(id, existing);
    }
    const edges = [];
    for (const e of graph.edges) {
        const from = pathOwner.get(e.from), to = pathOwner.get(e.to);
        if (from && to && from !== to)
            edges.push({ ...e, from, to });
    }
    return { nodes: [...nodes.values()], edges };
}
function prefixHits(paths, prefixes) { return paths.some(f => prefixes.some(prefix => within(f, prefix))); }
export function evaluateRules(graph, config) {
    const nodes = new Map(graph.nodes.map(n => [n.id, n])), violations = new Map();
    for (const rule of config.rules) {
        if (rule.kind === 'forbidden-dependency')
            for (const edge of graph.edges) {
                const target = nodes.get(edge.to), targetPaths = target.external ? [target.id] : target.paths;
                // A witness belongs to one actual source path, not every file in its package.
                if (prefixHits([edge.path], rule.from) && targetPaths.length && targetPaths.every(f => prefixHits([f], rule.to))) {
                    const fact = { ruleId: rule.id, kind: rule.kind, from: edge.from, to: edge.to, witness: edge.path, line: edge.line, rationale: rule.rationale };
                    const fingerprint = digest({ ruleId: fact.ruleId, kind: fact.kind, from: fact.from, to: fact.to, witness: fact.witness });
                    violations.set(fingerprint, { ...fact, fingerprint });
                }
            }
        else if (rule.kind === 'acyclic') {
            const ids = new Set(graph.nodes.filter(n => !n.external && n.paths.every(f => prefixHits([f], rule.scope))).map(n => n.id));
            const sub = { nodes: graph.nodes.filter(n => ids.has(n.id)), edges: graph.edges.filter(e => ids.has(e.from) && ids.has(e.to)) };
            for (const cycle of stronglyConnected(sub)) {
                // Fingerprint cyclic edges, not just SCC membership: a new edge inside an
                // existing SCC is still new debt and must not be laundered by the baseline.
                const members = new Set(cycle);
                for (const e of sub.edges)
                    if (members.has(e.from) && members.has(e.to)) {
                        const fingerprint = digest({ ruleId: rule.id, kind: rule.kind, from: e.from, to: e.to, witness: e.path });
                        violations.set(fingerprint, { ruleId: rule.id, kind: rule.kind, cycle, from: e.from, to: e.to, witness: e.path, line: e.line, rationale: rule.rationale, fingerprint });
                    }
            }
        }
    }
    return [...violations.values()].sort((a, b) => compareText(a.fingerprint, b.fingerprint));
}
function graphFacts(graph, history, config) {
    const comp = projection(graph, config), internalNodes = comp.nodes.filter(n => !n.external), internal = new Set(internalNodes.map(n => n.id));
    const nodeById = new Map(internalNodes.map(n => [n.id, n]));
    const edges = comp.edges.filter(e => internal.has(e.from) && internal.has(e.to));
    const outgoing = new Map([...internal].map(id => [id, new Set()])), incoming = new Map([...internal].map(id => [id, new Set()]));
    for (const e of edges) { outgoing.get(e.from).add(e.to); incoming.get(e.to).add(e.from); }
    const reaches = (from, target) => {
        const seen = new Set([from]), queue = [...(outgoing.get(from) ?? [])];
        while (queue.length) {
            const next = queue.shift();
            if (next === target) return true;
            if (seen.has(next)) continue;
            seen.add(next); queue.push(...(outgoing.get(next) ?? []));
        }
        return false;
    };
    const intersects = (a, b) => [...a].some(x => b.has(x));
    const fallbackPath = id => id.startsWith('directory:') ? id.slice('directory:'.length) : null;
    const nestedFallback = (left, right) => {
        const a = fallbackPath(left), b = fallbackPath(right);
        if (a === null || b === null) return false;
        const withinDir = (child, parent) => child === parent || child.startsWith(parent === '(root)' ? '' : parent + '/');
        return withinDir(a, b) || withinDir(b, a);
    };
    const explain = pair => {
        const left = nodeById.get(pair.left), right = nodeById.get(pair.right);
        if (!left || !right) return { kind: 'static-unit-uncovered', reason: 'one or both historical units are absent from the collected static graph' };
        if (outgoing.get(pair.left).has(pair.right) || outgoing.get(pair.right).has(pair.left)) return { kind: 'direct-dependency', reason: 'an observed direct dependency already explains coordination' };
        if (reaches(pair.left, pair.right) || reaches(pair.right, pair.left)) return { kind: 'transitive-dependency', reason: 'an observed dependency path already connects the units' };
        if (intersects(outgoing.get(pair.left), outgoing.get(pair.right))) return { kind: 'shared-dependency', reason: 'both units depend on an observed common component' };
        if (intersects(incoming.get(pair.left), incoming.get(pair.right))) return { kind: 'shared-consumer', reason: 'an observed common consumer depends on both units' };
        if (nestedFallback(pair.left, pair.right)) return { kind: 'nested-directory', reason: 'directory fallback produced ancestor/descendant units; this is layout, not independent ownership' };
        if (left.basis !== 'declared' || right.basis !== 'declared') return { kind: 'directory-correlation', reason: 'semantic ownership is not declared for both units; retain as historical context only' };
        return { kind: 'unexplained-declared-component-coupling', reason: 'declared components repeatedly co-change without an observed direct, transitive or shared static relation' };
    };
    const couplingAssessments = history.componentCoupling.map(pair => ({ ...pair, ...explain(pair), associationBasis: 'Git co-change is correlation, not causation' }));
    const hidden = couplingAssessments.filter(x => x.kind === 'unexplained-declared-component-coupling');
    const directoryLeads = couplingAssessments.filter(x => x.kind === 'directory-correlation');
    const fanIn = new Map(), fanOut = new Map();
    for (const e of edges) {
        if (!fanIn.has(e.to)) fanIn.set(e.to, new Set());
        fanIn.get(e.to).add(e.from);
        if (!fanOut.has(e.from)) fanOut.set(e.from, new Set());
        fanOut.get(e.from).add(e.to);
    }
    const activity = new Map(history.componentHotspots.map(h => [h.component, h]));
    const hotspots = [...internal].map(id => ({ component: id, basis: nodeById.get(id)?.basis ?? 'unknown', fanIn: fanIn.get(id)?.size ?? 0, fanOut: fanOut.get(id)?.size ?? 0, changes: activity.get(id)?.changes ?? 0, evidence: activity.get(id)?.evidence ?? null }));
    hotspots.sort((a, b) => (b.fanIn * b.changes) - (a.fanIn * a.changes) || compareText(a.component, b.component));
    const declaredPaths = graph.nodes.filter(n => !n.external).flatMap(n => n.paths).filter(p => componentFor(p, config).basis === 'declared');
    const totalPaths = graph.nodes.filter(n => !n.external).flatMap(n => n.paths).length;
    return { cycles: stronglyConnected(graph), componentCycles: stronglyConnected(comp), couplingAssessments, hiddenCouplingCandidates: hidden, directoryCouplingLeads: directoryLeads,
        semanticOwnership: { declaredComponents: config.components.length, declaredPaths: declaredPaths.length, totalPaths, complete: totalPaths > 0 && declaredPaths.length === totalPaths },
        unstableBoundaryCandidates: hotspots.filter(h => h.fanIn && h.changes && h.basis === 'declared').slice(0, 30) };
}
export function analyzeRepository({ git, commit, config, externalGraph = null, syntax = null, runtime, protocolEvidence = null }) {
    object(runtime, ['implementation', 'node'], 'analysis runtime');
    if (typeof runtime.implementation !== 'string' || !/^[a-f0-9]{64}$/.test(runtime.implementation))
        throw new TypeError('analysis runtime: invalid implementation identity');
    text(runtime.node, 'analysis runtime.node', 256);
    const tool = { name: 'labpics-architecture-observer', version: TOOL_VERSION, implementation: runtime.implementation, node: runtime.node };
    const snapshot = git.snapshot(commit, config), treePaths = new Set(snapshot.entries.map(e => e.path));
    const graph = graphFrom(externalGraph ?? buildSourceGraph(snapshot, config, syntax), commit, treePaths);
    const sourceFiles = snapshot.entries.filter(e => graphEligible(e.path, config)).map(e => e.path);
    const suppliedPaths = new Set(graph.nodes.flatMap(n => n.paths));
    if (graph.coverage.complete && (graph.coverage.sourceFiles !== sourceFiles.length || sourceFiles.some(f => !suppliedPaths.has(f))))
        throw new TypeError('Complete graph omitted eligible source files');
    const raw = git.history(commit, config.history), history = analyzeHistory(raw, config, [...treePaths]), facts = graphFacts(graph, history, config), violations = evaluateRules(graph, config);
    const report = { schema: REPORT_SCHEMA, tool, subject: { commit, tree: snapshot.tree },
        configuration: { digest: digest(config), declaredComponents: config.components.length, declaredRules: config.rules.length },
        graphEvidence: { producer: graph.producer, digest: digest(graph) }, coverage: { staticGraph: graph.coverage, history: history.coverage, limitations: graph.limitations, componentInference: facts.semanticOwnership.complete ? 'declared-complete' : config.components.length ? 'declared-partial-with-directory-context' : 'directory-context-only; no semantic ownership model' },
        graph: { nodes: graph.nodes.length, edges: graph.edges.length, externalNodes: graph.nodes.filter(n => n.external).length }, structure: graph, history, facts, violations };
    report.protocolDiagnostics = diagnoseProtocols(protocolEvidence, snapshot);
    const protocolPaths = [...new Set(report.protocolDiagnostics.candidates.flatMap(c => c.witnesses.map(w => w.path)))];
    if (protocolPaths.length)
        report.protocolDiagnostics.context = reviewContext(report, protocolPaths, config);
    report.identity = digest(report);
    return report;
}
function keyed(items, key) { return new Map(items.map(x => [key(x), x])); }
export function compareReports(base, head) {
    if (base.schema !== REPORT_SCHEMA || head.schema !== REPORT_SCHEMA)
        throw new TypeError('Can only compare architecture reports');
    const comparable = base.configuration.digest === head.configuration.digest && stableJson(base.graphEvidence.producer) === stableJson(head.graphEvidence.producer) && stableJson(base.tool) === stableJson(head.tool);
    const bv = keyed(base.violations, x => x.fingerprint), hv = keyed(head.violations, x => x.fingerprint), bc = new Set(base.facts.cycles.map(c => c.join('\0'))), hc = new Set(head.facts.cycles.map(c => c.join('\0')));
    const edgeKey = e => `${e.from}\0${e.to}\0${e.kind}\0${e.path}`, be = keyed(base.structure.edges, edgeKey), he = keyed(head.structure.edges, edgeKey);
    return { base: base.subject.commit, head: head.subject.commit, comparable,
        protocolDiagnostics: compareProtocolDiagnostics(base.protocolDiagnostics, head.protocolDiagnostics),
        limitations: comparable ? [] : ['configuration, collector or runtime identity differs; delta is not attributable to code alone'],
        newViolations: [...hv].filter(([k]) => !bv.has(k)).map(([, v]) => v), resolvedViolations: [...bv].filter(([k]) => !hv.has(k)).map(([, v]) => v),
        newCycles: [...hc].filter(k => !bc.has(k)).map(k => k.split('\0')), resolvedCycles: [...bc].filter(k => !hc.has(k)).map(k => k.split('\0')),
        addedEdges: [...he].filter(([k]) => !be.has(k)).map(([, v]) => v), removedEdges: [...be].filter(([k]) => !he.has(k)).map(([, v]) => v),
        metrics: { graphEdges: { base: base.graph.edges, head: head.graph.edges, delta: head.graph.edges - base.graph.edges }, staticCycles: { base: bc.size, head: hc.size, delta: hc.size - bc.size }, policyViolations: { base: bv.size, head: hv.size, delta: hv.size - bv.size } } };
}
export function reviewContext(report, paths, config) {
    const selected = report.structure.nodes.flatMap(n => n.paths).filter(f => paths.some(prefix => within(f, prefix)));
    // Configuration files may have temporal evidence without a static source node.
    for (const h of report.history.fileHotspots)
        if (paths.some(prefix => within(h.path, prefix)))
            selected.push(h.path);
    const uniquePaths = [...new Set(selected)], selectedSet = new Set(uniquePaths), coupling = queryCoupling(report.history, uniquePaths);
    return { historySubject: report.subject.commit, selectedPaths: uniquePaths, requestedPaths: paths, unmatchedPaths: paths.filter(prefix => !uniquePaths.some(f => within(f, prefix))),
        coupling, relatedUnchanged: coupling.items.filter(x => selectedSet.has(x.left) !== selectedSet.has(x.right)),
        components: [...new Set(uniquePaths.map(f => componentFor(f, config).id))],
        instruction: 'Inspect whether the same behavioral decision really must change. Unchanged partner is a review lead, not a missing-edit verdict.' };
}
export function createBaseline(report) { return { schema: BASELINE_SCHEMA, accepted: report.violations.map(({ fingerprint, ruleId }) => ({ fingerprint, ruleId })).sort((a, b) => compareText(a.fingerprint, b.fingerprint)) }; }
export function baselineVerdict(report, raw) { const baseline = baselineFrom(raw), accepted = new Set(baseline.accepted.map(e => e.fingerprint)), current = new Map(report.violations.map(e => [e.fingerprint, e])); const newViolations = [...current].filter(([f]) => !accepted.has(f)).map(([, v]) => v), staleAccepted = baseline.accepted.filter(e => !current.has(e.fingerprint)); return { newViolations, staleAccepted, valid: !newViolations.length && !staleAccepted.length }; }
export { stableJson };
