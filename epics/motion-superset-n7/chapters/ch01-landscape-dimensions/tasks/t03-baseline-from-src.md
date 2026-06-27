---
id: t03-baseline-from-src
chapter: ch01-landscape-dimensions
epic: motion-superset-n7
title: "Re-read the v1.0.0 HAS baseline from src with file:line evidence"
status: ready
priority: 1
depends_on: []
blocks:
  - t01-build-gap-matrix
agent_profile:
  category: deep
  skills: [research-swarm, craft-arch]
started: null
completed: null
---

# Re-read the v1.0.0 HAS baseline from src with file:line evidence

## What
Read `src/index.ts`, `src/spring.ts`, `src/tween.ts`, `src/drive.ts`, `src/errors.ts` and reproduce the v1.0.0 HAS list into `chapters/ch01-landscape-dimensions/baseline.md`, each row carrying `src/<file>.ts:<line>` evidence. This is the authoritative input to the gap matrix (CH-03) — the gap is measured against CODE, never against the prompt. Confirm: 3-regime analytical spring solver (underdamped/critical/overdamped), linear tween (exact endpoints), `drive()` Promise driver, reduced-motion short-circuit at the drive boundary, injected matchMedia/requestFrame seams, finite/CSS-safe clamps (clampFinite + interval clamp), MAX_FRAMES convergence cap, eager `validateSpringParams` + `MotionParamError`, zero-dep + dual ESM/CJS. Also pin the public surface against `test/api-surface-pin.test.ts` (5 runtime + 3 type exports, single `.` export).

## Must NOT Do
- Do NOT modify any `src/` or `test/` file — read-only.
- Do NOT carry forward a HAS claim that you cannot point to at a specific line.
- Do NOT exceed 10 tool-steps.

## Verification
- [ ] `baseline.md` reproduces every HAS row with `src/<file>.ts:<line>`.
- [ ] Public surface matches `api-surface-pin.test.ts` exactly (named, no extras/omissions).
- [ ] The "partial" rows (e.g. restDelta default) are recorded with their literal value from source.

## References
- `src/index.ts`, `src/spring.ts`, `src/tween.ts`, `src/drive.ts`, `src/errors.ts`
- `test/api-surface-pin.test.ts` — the contract pin.
