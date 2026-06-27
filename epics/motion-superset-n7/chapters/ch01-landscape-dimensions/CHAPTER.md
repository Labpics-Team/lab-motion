---
id: ch01-landscape-dimensions
epic: motion-superset-n7
title: "Lock the competitor roster, the 14 dimensions, and the v1.0.0 baseline"
user_story: "technical enabler"
enabler_for: "Every later feature scope (s03..s13) — without a locked competitor roster, dimension taxonomy, and an accurate v1.0.0 baseline, the matrix/gap/superset cannot be exit-criteria-complete."
status: ready
priority: 1
depends_on: []
refine_after: []
parallel_group: wave-1
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
---

# Lock the competitor roster, the 14 dimensions, and the v1.0.0 baseline

## User Story
Technical enabler for s03..s13. It produces the three frozen inputs (roster, dimension taxonomy, v1.0.0 HAS baseline) that every downstream chapter consumes; without them the deep dive fans out against a moving target.

## Purpose
Phase 1+2 of research-swarm (Landscape Scan + Dimension Decomposition), reconciled with the existing drafts. Three outputs, all written to a working scratch note under the chapter (NOT yet into the deliverables): (1) the FINAL competitor roster matching the exit-criteria exactly, with each competitor's canonical official-docs entry URL confirmed reachable; (2) the LOCKED 14-dimension list (already D1–D14 in the draft — verify it covers values/springs/easings/keyframes/timeline/stagger/gestures/scroll/layout/SVG/compositor/framework-bindings/accessibility/perf-budget and rename/merge only if a brief dimension is unmapped); (3) the v1.0.0 HAS baseline re-read from `src/{index,spring,tween,drive,errors}.ts` with file:line evidence, so the gap matrix is grounded in code not in the prompt.

## Tasks
| Task | Status | Agent | Depends On |
|------|--------|-------|------------|
| `tasks/t01-roster-and-doc-urls.md` | ready | deep | — |
| `tasks/t02-lock-dimensions.md` | ready | deep | — |
| `tasks/t03-baseline-from-src.md` | ready | deep | — |

## Exit Criteria
- [ ] Given the exit-criteria competitor list, When the roster is locked, Then a working note lists exactly {GSAP, Framer Motion, Motion One, Anime.js v4, React Spring, Theatre.js, Rive, Lottie, native WAAPI, native View-Transitions, native scroll-driven CSS} each with a reachable official-docs URL (HTTP 200 recorded), and flags the 4 currently-missing columns (Theatre.js, Rive, Lottie, native scroll-driven CSS).
- [ ] Given the 14-dimension taxonomy, When checked against the brief's dimension words, Then every brief dimension maps to exactly one D1..D14 (no brief dimension unmapped, no dimension invented), recorded in the working note.
- [ ] Given `src/*.ts`, When the baseline is re-read, Then the v1.0.0 HAS list is reproduced with `src/<file>.ts:<line>` evidence per row and matches the pinned public surface (`spring, tween, drive, validateSpringParams, MotionParamError` + 3 types).
