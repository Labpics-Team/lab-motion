import { compareText } from './model.mjs';
const limit = 12;
function safe(value) { return String(value).replace(/[\x00-\x1f\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('\\', '&#92;'); }
const code = value => `\`${safe(value)}\``;
function repositoryUrl(name) { return typeof name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(name) ? `https://github.com/${name}` : null; }
function urlSegment(value) { return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function commits(evidence, repository) {
    if (!evidence)
        return 'No commit witness';
    const root = repositoryUrl(repository);
    return evidence.commits.map(sha => root ? `[${sha.slice(0, 8)}](${root}/commit/${sha})` : code(sha)).join(', ') + (evidence.omittedCommits ? ` (+${evidence.omittedCommits} in reproducible history)` : '');
}
function source(edge, report, repository) { const root = repositoryUrl(repository); return root ? `[${safe(edge.path)}:${edge.line}](${root}/blob/${report.subject.commit}/${edge.path.split('/').map(urlSegment).join('/')}#L${edge.line})` : code(`${edge.path}:${edge.line}`); }
function section(title, items, render) {
    if (!items.length)
        return '';
    return `\n## ${title}\n\n${items.slice(0, limit).map(render).join('\n')}\n${items.length > limit ? `\nShowing ${limit}/${items.length}; full evidence is in JSON.\n` : ''}`;
}
function pairLine(item, repository) { return `- ${code(item.left)} ↔ ${code(item.right)}: ${item.shared} shared; ${item.leftChanges}/${item.rightChanges} changes; conditional ${(100 * item.givenLeft).toFixed(0)}% / ${(100 * item.givenRight).toFixed(0)}%, lift ${item.lift.toFixed(2)}. Witnesses: ${commits(item.evidence, repository)}.`; }
export function markdownReport(report, comparison = null, ratchet = null, context = null, repository = null, policy = null) {
    const s = report.coverage.staticGraph, h = report.coverage.history;
    let out = `# Architecture evidence\n\nSubject ${code(report.subject.commit)}. Observer ${code(report.tool.version)}; identity ${code(report.identity)}.\n\n`;
    out += 'These are observations, not automatic defects. Green execution means the observer ran, not that the architecture is healthy.\n\n';
    out += `Source parser coverage: **${s.parsedFiles}/${s.sourceFiles}** files. Semantic completeness: **${s.complete ? 'qualified by the supplied sensor' : 'not certified'}**.\n`;
    out += `History: **${h.evidenceEvents} accepted / ${h.commitsObserved} observed** first-parent events; history ${h.historyComplete ? 'available in the declared window' : 'incomplete'}, coupling ${h.couplingComplete ? 'computed' : 'withheld after resource exhaustion'}.\n`;
    out += `Rules declared: **${report.configuration.declaredRules}**; known violations: **${report.violations.length}**. Directory groups are not inferred semantic owners.\n`;
    if (policy)
        out += `Policy anchor ${code(policy.commit)}; candidate configuration ${policy.changed ? 'differs and was not used to weaken the comparison' : 'unchanged'}.\n`;
    if (comparison) {
        out += '\n## This change\n\n';
        out += `Comparison ${code(comparison.base)} → ${code(comparison.head)}; ${comparison.comparable ? 'same policy and collector' : 'NOT directly comparable'}.\n`;
        out += `Dependencies +${comparison.addedEdges.length}/−${comparison.removedEdges.length}; new cycles ${comparison.newCycles.length}; new explicit violations ${comparison.newViolations.length}.\n`;
        if (comparison.requestedBase !== comparison.base)
            out += 'The target branch advanced; source delta uses the unique merge base, not unrelated target-branch changes.\n';
        for (const l of comparison.limitations)
            out += `\n${safe(l)}\n`;
        out += section('New dependency witnesses', comparison.addedEdges, e => `- ${code(e.from)} → ${code(e.to)} (${safe(e.kind)}), ${source(e, report, repository)}.`);
    }
    if (context) {
        out += '\n## Review context\n\n';
        out += `Historical leads are measured at **${code(context.historySubject)}**, before the candidate change when a base was supplied.\n`;
        out += `Selected ${context.selectedPaths.length} files from ${context.requestedPaths.length} requested paths; ${context.unmatchedPaths.length} paths have no eligible historical/static evidence.\n`;
        out += safe(context.instruction) + '\n';
        out += section('Historically related, unchanged files', context.relatedUnchanged, x => pairLine(x, repository));
        if (!context.relatedUnchanged.length)
            out += '\nNo qualifying related unchanged files in the observed population. This does not prove independence.\n';
    }
    out += section('Unexplained coupling between declared components', report.facts.hiddenCouplingCandidates, x => `${pairLine(x, repository)} ${safe(x.reason)}`);
    out += section('Directory-only historical leads', report.facts.directoryCouplingLeads ?? [], x => `${pairLine(x, repository)} Directory grouping is not semantic ownership; this lead is intentionally withheld from CI findings.`);
    const assessmentCounts = new Map();
    for (const item of report.facts.couplingAssessments ?? []) assessmentCounts.set(item.kind, (assessmentCounts.get(item.kind) ?? 0) + 1);
    if (assessmentCounts.size) out += `\nCoupling explanations: ${[...assessmentCounts].sort(([a], [b]) => compareText(a, b)).map(([kind, count]) => `${safe(kind)}=${count}`).join(', ')}.\n`;
    out += section('Dependency cycles', report.facts.cycles, c => `- ${c.map(code).join(' → ')}. Inspect the cycle witness edges in JSON; a cycle is a structural fact, not an automatic architecture defect.`);
    out += section('Frequently changed, depended-on components', report.facts.unstableBoundaryCandidates, x => `- ${code(x.component)}: ${x.changes} changes, fan-in ${x.fanIn}, fan-out ${x.fanOut}. ${commits(x.evidence, repository)}.`);
    const trend = report.history.changeBreadthTrend;
    out += '\n## Evolution and exclusions\n\n';
    out += `Change breadth p90: previous ${trend.windowDays} days **${trend.previous.p90Components.toFixed(1)}** (${trend.previous.events} events); recent **${trend.recent.p90Components.toFixed(1)}** (${trend.recent.events} events). Different activity/sample sizes are not a causal before/after experiment.\n`;
    out += `Broad changes excluded from associations: **${h.excludedBroadEvents}**. They remain in the broad-change evidence and all-event breadth; large does not mean mechanical or harmless.\n`;
    const counts = new Map();
    for (const e of report.history.excluded)
        counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    out += `Selection reasons: ${[...counts].sort(([a], [b]) => compareText(a, b)).map(([r, n]) => `${safe(r)}=${n}`).join(', ') || 'none'}.\n`;
    out += `Pair shortlist: ${report.history.fileCoupling.length}/${h.selection.fileCouplingTotal} file pairs, ${report.history.componentCoupling.length}/${h.selection.componentCouplingTotal} component pairs. Focus queries are selected before truncation.\n`;
    out += section('Explicit law violations', report.violations, v => `- ${code(v.ruleId)}: ${code(v.from)} → ${code(v.to)} at ${source({ path: v.witness, line: v.line }, report, repository)}. ${safe(v.rationale)}`);
    if (ratchet)
        out += `\nRatchet: ${ratchet.newViolations.length} new violations, ${ratchet.staleAccepted.length} resolved entries to retire. ${ratchet.valid ? 'Baseline matches the observed violations.' : 'Baseline needs attention.'}\n`;
    out += section('Coverage limitations', report.coverage.limitations, l => `- ${l.path ? code(l.path) + ': ' : ''}${safe(l.reason)}`);
    out += '\n## Reproduce and act\n\n';
    out += `Use the pinned observer and collector from this run with subject ${code(report.subject.commit)}${comparison ? ` and base ${code(comparison.requestedBase ?? comparison.base)}` : ''}. JSON contains the full source graph, accepted history population, excluded events, identities and witness commits. No artifact service is needed to recalculate it.\n\n`;
    out += 'Follow a witness commit, identify the behavior that required both changes, and compare against ownership/contract requirements. Record confirmed defects or rejected signals in the existing PR/issue. A signal alone never authorizes a refactor or a new blocking rule.\n';
    return out;
}
