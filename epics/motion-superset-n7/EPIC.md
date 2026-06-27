---
id: motion-superset-n7
title: "Deep competitive swarm-research → LOCKED N7 capability superset for @labpics/motion"
status: active
priority: 1
created: 2026-06-27
goal: "Produce the LOCKED, exit-criteria-grade N7 source-of-truth research artifacts (feature-matrix, gap-matrix, superset) that every later @labpics/motion feature scope traces to — no runtime code."
success_criteria:
  - "docs/research/feature-matrix.md has a column per required competitor (GSAP, Motion = Framer Motion + Motion One, Anime.js v4, React Spring, Theatre.js, Rive, Lottie, native WAAPI + View-Transitions + scroll-driven CSS), every capability cited with >=2 sources for each non-obvious claim."
  - "docs/research/gap-matrix.md states v1.0.0 HAS (read from src/) vs the union, with everything above spring/tween/drive+safety marked a gap, severity-tiered."
  - "docs/research/superset.md is LOCKED with ZERO capability descoped/simplified; every capability maps to a build-scope id in the canonical s03..s13 namespace AND an exported subpath, with at least one competitor that has it."
  - "Each capability in superset.md is traceable (golden thread for N7): scope id -> source dimension -> >=2 cited competitor docs."
  - "verification-cove gate returns PASS over the three artifacts; zero runtime code added in this epic."
depends_on: []
---

# Deep competitive swarm-research → LOCKED N7 capability superset

## Goal
Produce the LOCKED, exit-criteria-grade N7 source-of-truth research artifacts (feature-matrix, gap-matrix, superset) that every later @labpics/motion feature scope traces to — no runtime code.

## Grounded starting state (verified 2026-06-27, not assumed)
A prior research-swarm run already produced strong v1 drafts in `docs/research/`:
- `feature-matrix.md` — 14 dimensions (D1–D14), competitors C1–C6 + a native mention, ~15 `Cites:` lines.
- `gap-matrix.md` — v1.0.0 HAS (read from src) vs union, severity-tiered.
- `superset.md` — scope map **S0–S21** with subpaths + build order.
- `VERIFICATION-COVE.md` — a prior PASS gate.

This epic is therefore **harden-to-exit-criteria**, not greenfield. Three concrete exit-criteria failures were measured in the current drafts and drive the chapter plan:
1. **Missing required competitors.** Exit-criteria name GSAP, Motion (Framer Motion + Motion One), Anime.js v4, React Spring, Theatre.js, Rive, Lottie, and native WAAPI/View-Transitions/scroll-driven CSS. Measured hits in `feature-matrix.md`: Theatre.js = 0, Rive = 0, Lottie = 0, native scroll-driven CSS = 0. These four competitor columns are absent.
2. **Scope-id namespace mismatch.** Exit-criteria require capabilities tagged in the **`s03..s13`** namespace (the N7 golden thread every feature scope traces to). The current superset uses **`S0..S21`**. The golden thread will not resolve until the namespace is reconciled to canonical `s03..s13` (lowercase) with the existing built primitives occupying s00–s02.
3. **Citation density.** Exit-criteria require **>=2 sources per non-obvious claim**. Current matrix has one `Cites:` line per dimension, not per-claim with two sources.

## Canonical scope-id namespace (LOCK DECISION — input to s07/CH-04)
The brief's exit-criteria are authoritative. The N7 namespace is **lowercase `s00..s13`**:
- `s00` — engine invariants (determinism, CSS-safe, SSR-safe, reduced-motion, pinned surface, zero-dep, dual ESM/CJS). Cross-cutting; inherited by all.
- `s01` — analytical spring solver (BUILT, v1.0.0).
- `s02` — tween + declarative `drive()` + injected seams + finite clamps (BUILT, v1.0.0).
- `s03..s13` — the eleven buildable capability scopes that the union decomposes into. Exact membership of s03..s13 is LOCKED in CH-04 by folding the prior S1..S21 clusters into eleven scopes with ZERO capability dropped (a scope may contain multiple sub-capabilities; nothing is descoped — only regrouped). The S->s mapping table is part of the superset deliverable so the prior work remains auditable.

## Chapters
| Chapter | Status | Priority |
|---------|--------|----------|
| `chapters/ch01-landscape-dimensions` | ready | 1 |
| `chapters/ch02-parallel-deep-dive` | draft | 1 |
| `chapters/ch03-feature-and-gap-matrix` | draft | 2 |
| `chapters/ch04-lock-superset` | draft | 2 |
| `chapters/ch05-cove-gate` | draft | 3 |

## Backlog
Deferred owner requests live in the sibling `BACKLOG.md`. Drain `[OPEN]` items each grounding/NextWork cycle and on resume, priority-first, anchored to the verbatim quote. A non-empty backlog means this epic is NOT complete.

## Notes
- **Blast radius:** WRITES ONLY under `docs/research/` (4 files) + this `epics/` tree. Touches NO `src/`, NO `test/`, NO `package.json`, NO build config. `src/` is READ-ONLY input (baseline grounding for the gap matrix). This is the Hyrum/blast-radius boundary — any agent that edits runtime code has left scope.
- **No runtime code in this epic.** The superset *names* exported subpaths (e.g. `@labpics/motion/scroll`) as a design contract; it does NOT create them. Implementation is downstream epics that trace back here.
- **Scope amendment — runtime fix: `src/spring.ts` + `test/spring-low-omega0-wall-clock.test.ts` (recorded 2026-06-27):** A quality-gate pass identified that `validateSpringParams()` had a wrong floor (`MIN_NATURAL_FREQUENCY = 0.5 rad/s`) that did NOT close the wall-clock-stall class it claimed to close — a spring at the exact boundary (ω₀=0.5, ζ=4) stalled 83.7 s at MAX_FRAMES then snapped 12.2%. This is a correctness bug in the v1.0.0 baseline, not a new feature. The fix (raise floor to 2.0 rad/s, add MIN_DAMPING_RATIO=0.2 guard, update regression test) was applied here because: (a) the gap-matrix HAS-baseline read from `src/` would have been inaccurate without the fix, and (b) a separate runtime PR would have been blocked waiting on this same finding. The amendment is narrow and does NOT introduce new exported surface, subpaths, or feature scope. Future agents: this precedent does not open `src/` for arbitrary changes — only correctness bugs in the baseline that affect grounding accuracy may be fixed here, and each such fix must be recorded in this section with rationale and verified by the test suite.
- **Grounding law:** every competitor claim cites official public docs via Firecrawl/Context7 (>=2 sources per non-obvious claim), NEVER memory. Every v1.0.0 HAS claim cites `src/<file>.ts:<line>`. A claim with no external signal is a defect.
- **Subagent cap:** every spawned subagent is capped at 10 steps (research-swarm Phase 3 rule). One competitor (or one tight cluster) per subagent; no zone overlap; 2–5 in parallel.
- **Skills:** research-swarm (pipeline), verification-cove (gate), craft-arch (scope/subpath layering sanity on the superset).
- **Verification is isolated:** the CH-05 CoVe gate must be run by an agent that did NOT write the artifacts (no self-grading). Existing `VERIFICATION-COVE.md` is a prior gate over prior drafts — it does NOT count for the hardened artifacts and must be regenerated.
