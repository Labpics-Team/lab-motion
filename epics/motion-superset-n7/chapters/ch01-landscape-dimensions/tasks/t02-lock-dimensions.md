---
id: t02-lock-dimensions
chapter: ch01-landscape-dimensions
epic: motion-superset-n7
title: "Verify and lock the 14-dimension taxonomy against the brief"
status: ready
priority: 1
depends_on: []
blocks:
  - t01-gsap
  - t02-motion
  - t03-anime-reactspring
  - t04-theatre-rive
  - t05-lottie-native
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
started: null
completed: null
---

# Verify and lock the 14-dimension taxonomy against the brief

## What
Map every dimension word in the brief — values, springs, easings, keyframes, timeline, stagger, gestures, scroll, layout, SVG, compositor, framework-bindings, accessibility, perf-budget — onto the existing D1..D14 in `docs/research/feature-matrix.md`. Append the result to `chapters/ch01-landscape-dimensions/roster.md` as a dimension-lock table: brief-word -> D-id -> one-line scope. If a brief word has no D, add a dimension (renumber) and record why. If a D has no brief word, keep it but mark it as an extension. Output is the FROZEN dimension list the deep-dive subagents will fan out over (one subagent reads each competitor across ALL 14 dimensions).

## Must NOT Do
- Do NOT write into `docs/research/*`.
- Do NOT invent dimensions not implied by the brief or the existing matrix.
- Do NOT exceed 10 tool-steps (this is a mapping/check task, mostly reading the existing matrix headers).

## Verification
- [ ] Every one of the 14 brief dimension-words maps to exactly one D-id (table in roster.md).
- [ ] No D-id is left unmapped without an explicit "extension" justification.

## References
- `docs/research/feature-matrix.md` — current D1..D14 headers.
