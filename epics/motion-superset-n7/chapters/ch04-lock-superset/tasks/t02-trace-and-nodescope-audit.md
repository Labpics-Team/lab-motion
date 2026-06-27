---
id: t02-trace-and-nodescope-audit
chapter: ch04-lock-superset
epic: motion-superset-n7
title: "Golden-thread trace audit + zero-descope count check"
status: placeholder
priority: 2
depends_on: [t01-lock-scope-map]
blocks: [t01-cove-gate]
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
started: null
completed: null
refine_after: [t01-lock-scope-map]
---

# Trace + no-descope audit

Run the verifiable checks the exit-criteria demand:
1. **Zero descope:** count union capabilities in feature-matrix.md vs capability rows in superset.md; assert equal and assert no row carries a "descope/simplified/dropped" marker. Record the two counts.
2. **Golden thread:** for a sample (and ideally all) superset rows, confirm capability -> exactly one s-id -> one D-dimension -> >=2 cited competitor docs resolves. List any broken thread.
3. **Acyclic subpath graph:** list scope deps and confirm no cycle (craft-arch / Clean direction).
Output the audit as a section appended to superset.md (or a sibling `superset-audit.md`) so the CoVe gate can read the evidence.

Will be refined after t01-lock-scope-map completes.
