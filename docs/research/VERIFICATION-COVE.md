# Verification-CoVe Gate — Animation Capability Superset (N7)

**Verdict:** ✅ PASS · **Method:** Chain-of-Verification, Factor+Revise (isolated) · **Date:** 2026-06-27

Gate over the three LOCKED artifacts in this directory. Each atomic claim was verified
independently — against the v1.0.0 source code and against competitor docs as cited in
feature-matrix.md — NOT against any draft and NOT by the agent that authored the artifacts.

## Artifacts under gate (2026-06-27 canonical state)
- `feature-matrix.md` — 10 competitors × 14 dimensions, per-cell citations. Competitors C7-C10 (Theatre.js/Rive/Lottie/scroll-driven CSS) added 2026-06-27.
- `gap-matrix.md` — v1.0.0 HAS (read from `src/{index,spring,tween,drive,errors}.ts`) vs union delta, severity-tiered.
- `superset.md` — LOCKED canonical scope map s00..s13 (14 scopes). Namespace migrated from legacy S0..S21 (22 scopes) to s00..s13 (14 scopes) 2026-06-27.

No render console (`docs/scopes-console`) is part of this gate. That artifact does not exist in the repository; any prior reference to it was stale.

## Atomic-claim verifications

| # | Claim | Independent evidence | Result |
|---|---|---|---|
| VQ1 | v1.0.0 exports exactly `spring, tween, drive, validateSpringParams, MotionParamError` (+types); single `.` export, no subpaths | `src/index.ts`; README; `package.json` exports `.` only | ✅ CONFIRMED |
| VQ2 | `drive()` short-circuits to final value under prefers-reduced-motion | `src/drive.ts` L142–148 (`if (reduce) { onStep(to); return Promise.resolve() }`) | ✅ CONFIRMED |
| VQ3 | Finite/CSS-safe moat exists in source | `src/spring.ts` `clampFinite`; `src/drive.ts` `clamp` | ✅ CONFIRMED |
| VQ4 | Motion: global config + per-anim always/never override + hook (grounded rule 2) | motion.dev/docs/react-accessibility (cited in feature-matrix.md D13): `MotionConfig reducedMotion="user"`/`"always"`/`"never"`, `useReducedMotion()` | ✅ CONFIRMED |
| VQ5 | Motion animates layout via transform + counter-scale children (grounded rule 3) | motion.dev/docs/react-layout-animations (cited in feature-matrix.md D9): "all layout animations using CSS `transform`"; child counter-scale | ✅ CONFIRMED |
| VQ6 | AutoAnimate = one-function FLIP, respects PRM by default, modular subpaths | auto-animate.formkit.com (cited in feature-matrix.md D9, D12): `useAutoAnimate()`, `disrespectUserMotionPreference:false` default | ✅ CONFIRMED |
| VQ7 | GSAP 3.13 is 100% free incl. MorphSVG/SplitText | gsap.com/blog/3-13/ (cited in feature-matrix.md D14 notable signals) | ✅ CONFIRMED |
| VQ8 | Superset canonical scope map is s00..s13 (14 scopes); feature-matrix covers 10 competitors (C1-C10); no TOTAL_SCOPES constant exists in src | `superset.md` header: "canonical scope id (s00..s13)"; scope map table: 14 rows s00..s13 confirmed; `feature-matrix.md` header lists C1-C10; `grep -rn TOTAL_SCOPES src/` → 0 hits (constant lives only in `test/zero-descope-count.test.ts` as a regex pattern, never in a domain file) | ✅ CONFIRMED |
| VQ9 | lab-motion's three unique HAS capabilities (injected-seam reduced-motion, deterministic CSS-safe, pinned surface) appear in no competitor column in the matrix | `feature-matrix.md` D13 and D14 rows: "has (unique)" appears only in the `lab` column | ✅ CONFIRMED |

## Cross-check (Step 4)
- CONFIRMED: 9 · DISCREPANCY: 0 · UNCERTAIN: 0
- Red flags (≥2 discrepancy / low-confidence critical / contradiction): **none**.

## Stale-gate correction record (auditability)
The prior gate (dated 2026-06-26) contained three false claims, now corrected here:
- Claim about scope count: prior gate cited "S0–S21, 21 buildable scopes" — canonical is s00..s13 (14 scopes).
- Claim about source file: prior gate cited "lib/domain.ts TOTAL_SCOPES=21" — that file does not exist.
- Artifact list: prior gate listed "docs/scopes-console Next.js app, route /v3" — that directory does not exist.
- Competitor count: prior gate stated 9 competitors; the 2026-06-27 matrix has 10 (C7-C10 added).
The prior gate must not be cited as evidence of current state.

## Trace guarantee (re-affirmed)
Every downstream feature scope references one `s00..s13` id and its exported subpath in superset.md, and one source dimension `D<n>` with a cited competitor doc in feature-matrix.md. The s00 engine invariants are acceptance criteria on all of them. LOCKED — no descoping permitted.

**Gate result: PASS.**
