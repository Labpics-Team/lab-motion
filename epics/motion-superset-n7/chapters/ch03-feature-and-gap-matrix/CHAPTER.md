---
id: ch03-feature-and-gap-matrix
epic: motion-superset-n7
title: "Assemble feature-matrix.md + gap-matrix.md from the deep-dive sheets"
user_story: "technical enabler"
enabler_for: "superset.md lock (CH-04) and the N7 golden thread — the matrix is the union, the gap is the delta the superset must close."
status: draft
priority: 2
depends_on: [ch02-parallel-deep-dive]
refine_after: [t01-gsap, t02-motion, t03-anime-reactspring, t04-theatre-rive, t05-lottie-native, t03-baseline-from-src]
parallel_group: wave-3
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
---

# Assemble feature-matrix.md + gap-matrix.md

## User Story
Technical enabler for the superset lock. It folds the per-competitor sheets into the two N7 matrices: the union (what the field can do) and the delta (what v1.0.0 lacks).

## Purpose
Phase 4 (Insight Extraction) applied to the artifacts. Rewrite `docs/research/feature-matrix.md` so it has a column per required competitor (adding Theatre.js, Rive, Lottie, native scroll-driven CSS) with >=2 citations per non-obvious claim, and rewrite `docs/research/gap-matrix.md` so v1.0.0 HAS (from `baseline.md`, file:line) is contrasted with the union, severity-tiered, with everything above spring/tween/drive+safety marked a gap. The union row-set produced here is the exact membership the superset must preserve with zero descope.

## Tasks
| Task | Status | Agent | Depends On |
|------|--------|-------|------------|
| `tasks/t01-build-feature-matrix.md` | placeholder | deep | (all CH-02 sheets) |
| `tasks/t02-build-gap-matrix.md` | placeholder | deep | t01-build-feature-matrix, t03-baseline-from-src |
| `tasks/t03-citation-density-pass.md` | placeholder | deep | t01-build-feature-matrix |

## Exit Criteria
- [ ] Given the CH-02 sheets, When feature-matrix.md is rebuilt, Then it has a column per required competitor (GSAP, Framer Motion, Motion One, Anime.js v4, React Spring, Theatre.js, Rive, Lottie, native WAAPI/View-Transitions/scroll-driven CSS) across all 14 dimensions, every capability cited.
- [ ] Given the >=2-source rule, When the citation pass runs, Then every non-obvious capability claim carries >=2 distinct official sources (recorded inline or in a per-dimension Cites block referencing >=2 URLs).
- [ ] Given baseline.md, When gap-matrix.md is rebuilt, Then HAS rows carry src:line evidence, the union delta is severity-tiered (CORE/HIGH/MED/LOW), and everything above the v1.0.0 primitive is a gap row.
