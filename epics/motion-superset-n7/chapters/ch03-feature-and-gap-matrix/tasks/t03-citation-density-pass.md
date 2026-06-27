---
id: t03-citation-density-pass
chapter: ch03-feature-and-gap-matrix
epic: motion-superset-n7
title: ">=2-sources-per-claim citation density pass over feature-matrix.md"
status: placeholder
priority: 2
depends_on: [t01-build-feature-matrix]
blocks: [t01-cove-gate]
agent_profile:
  category: deep
  skills: [research-swarm, verification-cove]
started: null
completed: null
refine_after: [t01-build-feature-matrix]
---

# Citation density pass

Walk every non-obvious capability claim in `docs/research/feature-matrix.md` and ensure it is backed by >=2 distinct official sources (e.g. the competitor doc page + an API reference / changelog / MDN). Obvious primitives (a tween animates numbers) may carry one source. Record sources inline or in a per-dimension Cites block that lists >=2 URLs with retrieval dates. Flag any claim that cannot reach 2 sources as UNCERTAIN rather than asserting it — the CoVe gate will reject unsupported claims.

Will be refined after t01-build-feature-matrix completes.
