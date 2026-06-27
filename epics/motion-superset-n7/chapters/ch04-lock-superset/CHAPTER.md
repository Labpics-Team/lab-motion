---
id: ch04-lock-superset
epic: motion-superset-n7
title: "LOCK superset.md in the canonical s03..s13 namespace, zero descope"
user_story: "technical enabler"
enabler_for: "Every downstream feature epic — the golden thread (capability -> s03..s13 scope id -> subpath -> cited competitor) that authorizes feature work."
status: draft
priority: 2
depends_on: [ch03-feature-and-gap-matrix]
refine_after: [t01-build-feature-matrix, t02-build-gap-matrix]
parallel_group: wave-4
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
---

# LOCK superset.md in the canonical s03..s13 namespace

## User Story
Technical enabler for all downstream feature epics. It produces the LOCKED capability superset where every capability has a stable scope id in the brief's canonical s03..s13 namespace and an exported subpath, so any later feature scope can trace itself to a row here.

## Purpose
Rewrite `docs/research/superset.md` so that: (1) every union capability appears exactly once, ZERO descoped/simplified; (2) each capability maps to a scope id in the canonical lowercase **s03..s13** namespace (s00=invariants, s01=spring built, s02=tween+drive built; s03..s13 = the eleven buildable scopes) AND an exported subpath; (3) each capability names >=1 competitor that has it; (4) a published S->s mapping table preserves the prior S0..S21 work for auditability (folding 21 clusters into 11 scopes is regrouping, NOT descoping — record which sub-capabilities live under each s-id). Apply craft-arch to the subpath/layer design: dependency direction must be acyclic (s03 values/easing roots -> driver -> sequencing -> gestures/scroll -> compositor/layout -> svg/bindings/a11y).

## Tasks
| Task | Status | Agent | Depends On |
|------|--------|-------|------------|
| `tasks/t01-lock-scope-map.md` | placeholder | deep | t01-build-feature-matrix, t02-build-gap-matrix |
| `tasks/t02-trace-and-nodescope-audit.md` | placeholder | deep | t01-lock-scope-map |

## Exit Criteria
- [ ] Given the union in feature-matrix.md, When superset.md is locked, Then every union capability appears exactly once with ZERO marked descoped/simplified (a programmatic check: union-row-count == superset-capability-count, no "descope"/"simplified"/"dropped" token on a capability row).
- [ ] Given the canonical namespace, When scopes are assigned, Then every capability carries a scope id in s03..s13 plus an exported subpath plus >=1 competitor that has it, and an S->s mapping table reconciles the prior S0..S21.
- [ ] Given any later feature scope, When it claims a capability, Then that capability traces to exactly one superset row (scope id) -> one source dimension -> >=2 cited competitor docs (golden thread closed).
- [ ] Given craft-arch, When the subpath dependency graph is drawn, Then it is acyclic and matches Clean-Architecture direction (roots have no inbound deps from leaves).
