import { compareText, componentFor, historyEligible, quantile } from './model.mjs';
const CANDIDATE_LIMIT = 200;
const WITNESS_LIMIT = 8;
function lineageHistory(events) {
    const identities = new Map(), touchedByEvent = new Map();
    for (const event of [...events].reverse()) {
        const before = new Map(event.changes.map(c => [c.oldPath, identities.get(c.oldPath)])), touched = new Set();
        // Read all old names before mutating: rename permutations are simultaneous.
        for (const c of event.changes)
            if (c.status === 'D' || c.status === 'R')
                identities.delete(c.oldPath);
        for (const c of event.changes) {
            const id = c.status === 'A' || c.status === 'C' ? `born:${event.sha}:${c.path}` : before.get(c.oldPath) ?? `seed:${c.oldPath}`;
            touched.add(id);
            if (c.status !== 'D')
                identities.set(c.path, id);
        }
        touchedByEvent.set(event.sha, touched);
    }
    return { current: new Map([...identities].map(([p, id]) => [id, p])), touchedByEvent };
}
function pairKeys(names) {
    const keys = [];
    for (let i = 0; i < names.length; i++)
        for (let j = i + 1; j < names.length; j++)
            keys.push(`${names[i]}\0${names[j]}`);
    return keys;
}
function record(names, index, event) {
    for (const name of names) {
        if (!index.has(name))
            index.set(name, []);
        index.get(name).push(event);
    }
}
function evidence(events) { return { commits: events.slice(0, WITNESS_LIMIT).map(e => e.sha), omittedCommits: Math.max(0, events.length - WITNESS_LIMIT), firstObserved: events.at(-1)?.sha ?? null, lastObserved: events[0]?.sha ?? null }; }
function coupling(total, index, pairs, settings) {
    const selected = [];
    for (const [key, shared] of pairs) {
        if (shared < settings.minShared)
            continue;
        const [left, right] = key.split('\0'), a = index.get(left), b = index.get(right), leftChanges = a.length, rightChanges = b.length;
        const jaccard = shared / (leftChanges + rightChanges - shared), lift = shared * total / (leftChanges * rightChanges);
        if ((jaccard < settings.minJaccard && Math.max(shared / leftChanges, shared / rightChanges) < settings.minConditional) || lift < settings.minLift)
            continue;
        selected.push({ left, right, shared, leftChanges, rightChanges, jaccard, lift, givenLeft: shared / leftChanges, givenRight: shared / rightChanges });
    }
    selected.sort((a, b) => b.shared - a.shared || b.jaccard - a.jaccard || b.lift - a.lift || compareText(`${a.left}\0${a.right}`, `${b.left}\0${b.right}`));
    return { total: selected.length, items: selected.slice(0, CANDIDATE_LIMIT).map(item => {
            const right = new Set(index.get(item.right).map(e => e.sha));
            return { ...item, evidence: evidence(index.get(item.left).filter(e => right.has(e.sha))) };
        }) };
}
function breadth(events) { const counts = events.map(e => e.components.length); return { medianComponents: quantile(counts, .5), p90Components: quantile(counts, .9), maxComponents: counts.length ? counts.reduce((a, b) => Math.max(a, b), 0) : 0 }; }
export function analyzeHistory(history, config, currentPaths) {
    const { current, touchedByEvent } = lineageHistory(history.events), currentSet = new Set(currentPaths);
    const identities = new Map([...current].filter(([, p]) => currentSet.has(p) && historyEligible(p, config)));
    const fileIndex = new Map(), componentIndex = new Map(), filePairs = new Map(), componentPairs = new Map(), evidenceEvents = [], excluded = [], allEvents = [];
    let pairBudgetExceeded = false;
    for (const event of history.events) {
        const originalFiles = new Set(event.changes.flatMap(c => [c.oldPath, c.path]).filter(p => historyEligible(p, config)));
        const files = [...new Set([...(touchedByEvent.get(event.sha) ?? [])].map(id => identities.get(id)).filter(Boolean))].sort(compareText);
        const components = [...new Set(files.map(p => componentFor(p, config).id))].sort(compareText);
        const observed = { sha: event.sha, time: event.time, files, components, originalFiles: originalFiles.size };
        if (files.length && event.time >= history.since && event.time <= history.until)
            allEvents.push(observed);
        let reason = null;
        if (event.time < history.since || event.time > history.until)
            reason = 'outside-time-window';
        else if (!files.length)
            reason = 'no-current-eligible-lineage';
        else if (originalFiles.size > config.history.maxChangesetFiles)
            reason = 'broad-changeset';
        else if (event.parents?.length === 0)
            reason = 'root-import';
        else if (event.changes.every(c => c.status === 'R' && c.similarity === 100))
            reason = 'pure-rename';
        if (reason) {
            excluded.push({ sha: event.sha, reason, originalFiles: originalFiles.size, survivingFiles: files.length });
            continue;
        }
        evidenceEvents.push(observed);
        record(files, fileIndex, observed);
        record(components, componentIndex, observed);
        if (pairBudgetExceeded)
            continue;
        const fk = pairKeys(files), ck = pairKeys(components);
        if (filePairs.size + fk.filter(k => !filePairs.has(k)).length > config.history.maxPairs || componentPairs.size + ck.filter(k => !componentPairs.has(k)).length > config.history.maxPairs) {
            pairBudgetExceeded = true;
            excluded.push({ sha: event.sha, reason: 'pair-resource-budget', originalFiles: originalFiles.size, survivingFiles: files.length });
            // Partial pair counts bias BOTH numerator and population. Abstain on
            // coupling, retain independent activity/breadth instead of faking PASS.
            filePairs.clear();
            componentPairs.clear();
            continue;
        }
        for (const k of fk)
            filePairs.set(k, (filePairs.get(k) ?? 0) + 1);
        for (const k of ck)
            componentPairs.set(k, (componentPairs.get(k) ?? 0) + 1);
    }
    const activityDays = Math.min(28, config.history.windowDays / 2), recentStart = history.until - activityDays * 86400, previousStart = recentStart - activityDays * 86400;
    const activity = events => ({ recentChanges: events.filter(e => e.time >= recentStart).length, previousChanges: events.filter(e => e.time >= previousStart && e.time < recentStart).length, windowDays: activityDays });
    const hotspots = (index, key) => [...index].map(([name, events]) => ({ [key]: name, changes: events.length, ...activity(events), evidence: evidence(events) })).sort((a, b) => b.changes - a.changes || compareText(a[key], b[key]));
    const fileCoupling = coupling(evidenceEvents.length, fileIndex, filePairs, config.history), componentCoupling = coupling(evidenceEvents.length, componentIndex, componentPairs, config.history);
    const { events: _events, ...provenance } = history;
    const recent = evidenceEvents.filter(e => e.time >= recentStart), previous = evidenceEvents.filter(e => e.time >= previousStart && e.time < recentStart);
    return {
        provenance, settings: { ...config.history }, coverage: { commitsObserved: history.events.length, evidenceEvents: evidenceEvents.length,
            excludedBroadEvents: excluded.filter(e => e.reason === 'broad-changeset').length, excludedResourceEvents: excluded.filter(e => e.reason === 'pair-resource-budget').length,
            currentLineages: identities.size, historyComplete: history.complete, couplingComplete: !pairBudgetExceeded, complete: history.complete && !pairBudgetExceeded,
            selection: { candidateLimit: CANDIDATE_LIMIT, fileCouplingTotal: fileCoupling.total, componentCouplingTotal: componentCoupling.total, witnessLimit: WITNESS_LIMIT } },
        excluded, evidenceEvents, changeBreadth: breadth(evidenceEvents), allChangeBreadth: breadth(allEvents),
        changeBreadthTrend: { windowDays: activityDays, recent: { events: recent.length, ...breadth(recent) }, previous: { events: previous.length, ...breadth(previous) } },
        broadChanges: allEvents.filter(e => e.originalFiles > config.history.maxChangesetFiles).map(({ sha, time, originalFiles, components }) => ({ sha, time, originalFiles, components: components.length })),
        fileHotspots: hotspots(fileIndex, 'path'), componentHotspots: hotspots(componentIndex, 'component'), fileCoupling: fileCoupling.items, componentCoupling: componentCoupling.items,
    };
}
// Selection precedes display truncation. A changed component must not vanish
// simply because 200 unrelated pairs rank above it.
export function queryCoupling(history, selectedNames, unit = 'files') {
    if (!['files', 'components'].includes(unit))
        throw new TypeError('Unknown coupling unit');
    if (!history.coverage.couplingComplete)
        return { items: [], total: 0, complete: false };
    const selected = new Set(selectedNames), index = new Map(), pairs = new Map();
    for (const event of history.evidenceEvents) {
        const names = event[unit];
        record(names, index, event);
        const keys = new Set();
        for (const left of names)
            if (selected.has(left))
                for (const right of names)
                    if (left !== right)
                        keys.add([left, right].sort(compareText).join('\0'));
        for (const k of keys)
            pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    return { ...coupling(history.evidenceEvents.length, index, pairs, history.settings), complete: history.coverage.historyComplete };
}
