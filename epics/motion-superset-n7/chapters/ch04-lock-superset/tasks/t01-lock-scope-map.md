---
id: t01-lock-scope-map
chapter: ch04-lock-superset
epic: motion-superset-n7
title: "Map every union capability to an s03..s13 scope id + subpath, zero descope"
status: placeholder
priority: 1
depends_on: [t01-build-feature-matrix, t02-build-gap-matrix]
blocks: [t02-trace-and-nodescope-audit]
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
started: null
completed: null
refine_after: [t01-build-feature-matrix, t02-build-gap-matrix]
---

# Lock the scope map

Rewrite `docs/research/superset.md`. Fold the prior S0..S21 clusters into the canonical s00..s13 namespace: s00 invariants, s01 spring (built), s02 tween+drive (built), s03..s13 = eleven buildable scopes covering the full union. Each capability row: capability · scope id (s03..s13) · exported subpath (e.g. `@labpics/motion/scroll`) · source dimension (D1..D14) · >=1 competitor that has it. Include an explicit `S<n> -> s<n>` mapping table so the prior work stays auditable and reviewers can confirm regroup != descope. State the locking rule and the build-order (dependency-respecting).

Will be refined after the rebuilt feature-matrix and gap-matrix exist (their final union row-set defines membership).
