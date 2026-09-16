import { BASELINE_SCHEMA, REPORT_SCHEMA, TOOL_VERSION, baselineFrom, compareText, componentFor, digest, graphEligible, graphFrom, object, text, stableJson, within } from './model.mjs';
import { buildSourceGraph } from './source-graph.mjs';
import { analyzeHistory, queryCoupling } from './history.mjs';
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
        const components = new Set(n.paths.map(f => componentFor(f, config).id));
        // External sensors may choose package-level units crossing declared cuts.
        // Do not join their IDs to unrelated history IDs by spelling coincidence.
        if (components.size !== 1)
            continue;
        const id = [...components][0];
        pathOwner.set(n.id, id);
        const existing = nodes.get(id) ?? { id, external: false, paths: [], basis: 'component-projection' };
        existing.paths.push(...n.paths);
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
    const comp = projection(graph, config), internal = new Set(comp.nodes.filter(n => !n.external).map(n => n.id));
    const edges = comp.edges.filter(e => internal.has(e.from) && internal.has(e.to));
    const undirected = new Set(edges.map(e => [e.from, e.to].sort(compareText).join('\0')));
    const absent = pairs => pairs.map(pair => ({ ...pair, kind: internal.has(pair.left) && internal.has(pair.right) ? 'coupling-without-observed-direct-edge' : 'coupling-with-uncovered-static-unit', basis: 'association is not causation; direct edge absence is not proof of independence' }));
    const hidden = absent(history.componentCoupling.filter(x => !undirected.has([x.left, x.right].sort(compareText).join('\0'))));
    const fanIn = new Map(), fanOut = new Map();
    for (const e of edges) {
        if (!fanIn.has(e.to))
            fanIn.set(e.to, new Set());
        fanIn.get(e.to).add(e.from);
        if (!fanOut.has(e.from))
            fanOut.set(e.from, new Set());
        fanOut.get(e.from).add(e.to);
    }
    const activity = new Map(history.componentHotspots.map(h => [h.component, h]));
    const hotspots = [...internal].map(id => ({ component: id, fanIn: fanIn.get(id)?.size ?? 0, fanOut: fanOut.get(id)?.size ?? 0, changes: activity.get(id)?.changes ?? 0, evidence: activity.get(id)?.evidence ?? null }));
    hotspots.sort((a, b) => (b.fanIn * b.changes) - (a.fanIn * a.changes) || compareText(a.component, b.component));
    return { cycles: stronglyConnected(graph), componentCycles: stronglyConnected(comp), hiddenCouplingCandidates: hidden, unstableBoundaryCandidates: hotspots.filter(h => h.fanIn && h.changes).slice(0, 30) };
}
export function analyzeRepository({ git, commit, config, externalGraph = null, syntax = null, runtime }) {
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
        graphEvidence: { producer: graph.producer, digest: digest(graph) }, coverage: { staticGraph: graph.coverage, history: history.coverage, limitations: graph.limitations, componentInference: config.components.length ? 'declared-with-directory-fallback' : 'directory-fallback-only; not semantic ownership' },
        graph: { nodes: graph.nodes.length, edges: graph.edges.length, externalNodes: graph.nodes.filter(n => n.external).length }, structure: graph, history, facts, violations };
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
