# Capability Superset — LOCKED (no descope)

> The complete, no-descope capability superset for @labpics/motion v-next. Every capability maps to a canonical scope id (s00..s13) and an exported subpath. This is the N7 source of truth every downstream feature scope MUST trace to. Derived from `feature-matrix.md` (union of competitor official docs) and `gap-matrix.md` (v1.0.0 delta). Generated 2026-06-26 via research-swarm; namespace migrated to s00..s13 2026-06-27. LOCKED — capabilities may be reordered or split, never dropped.

## Locking rule
A capability present in the union (feature-matrix) appears here exactly once, mapped to one scope id `s00..s13` and one exported subpath. Removing a row = descope = forbidden. Splitting a row into finer scopes is allowed. Sizing/ordering may change; membership may not.

## Legacy S-namespace → canonical s-namespace mapping (S0..S21 → s00..s13)

The prior draft used uppercase S0..S21 (22 scopes). The canonical N7 namespace consolidates these into s00..s13 (14 scopes). This table is required for auditability of prior work.

| Legacy | Canonical | Notes |
|---|---|---|
| S0 | s00 | Engine invariants (cross-cutting) |
| S3 | s01 | Spring ergonomics (BUILT root) |
| S5 | s02 | Scrubbable driver / tween (BUILT root) |
| S1 | s03 | Value model |
| S2 | s04 | Easing catalog |
| S4 | s05 | Keyframes |
| S6 | s06 | Timeline / sequencing |
| S7 | s07 | Stagger |
| S8, S9 | s08 | Gestures + inertia/decay |
| S11 | s09 | Compositor / WAAPI path |
| S10 | s10 | Scroll |
| S12, S14 | s11 | Layout / FLIP + auto-animate |
| S13 | s12 | Presence (enter/exit) |
| S15, S16, S17, S18, S19, S20, S21 | s13 | SVG, framework bindings, a11y, packaging |

## Cross-cutting invariants (apply to EVERY scope, s00)
**s00 — Engine invariants** · subpath `@labpics/motion` (root, re-exports).
Determinism · CSS-safe (no NaN/Infinity emitted) · SSR-safe (no `window` at import; injected seams) · reduced-motion honoured at entry · pinned/contract-tested public surface · zero runtime deps · dual ESM/CJS. Every scope below inherits s00 as acceptance criteria.

## Scope map

| Scope | Capability cluster | Exported subpath | Source dims | Severity | Depends on |
|---|---|---|---|---|---|
| **s00** | **Engine invariants** — determinism, CSS-safety, SSR-safety, reduced-motion, zero-deps, dual ESM/CJS, pinned surface | `@labpics/motion` (root) | D13, D14 | CORE | — |
| **s01** | **Spring ergonomics** — keep analytical solver; add duration+bounce API, visualDuration, velocity injection, presets, spring-as-easing, multi-property | `@labpics/motion/spring` | D2 | HIGH | s00 |
| **s02** | **Scrubbable driver / tween** — extend `drive`: play/pause/reverse/seek/time/timeScale/progress/complete/cancel/stop; linear tween with exact endpoints | `@labpics/motion` (core driver) | D4, D5 | CORE | s00, s01 |
| **s03** | **Value model** — units, colors (hex/rgb/hsl), transforms (independent), CSS variables, complex strings, JS objects, attributes, relative values | `@labpics/motion/values` | D1 | CORE | s00 |
| **s04** | **Easing catalog** — named curves (linear/easeIn-Out-InOut/circ/back/anticipate/elastic/bounce/power/sine/expo), cubic-bezier, steps(), custom JS fn | `@labpics/motion/easing` | D3 | CORE | s00 |
| **s05** | **Keyframes** — arrays, offsets/times, per-keyframe easing, repeat/loop/reverse/mirror/yoyo, repeatDelay | `@labpics/motion/keyframes` | D4 | HIGH | s03, s04 |
| **s06** | **Timeline / sequencing** — sequence, labels, position param (+/-/</>, absolute), nested, defaults, per-segment override | `@labpics/motion/timeline` | D5 | HIGH | s02 |
| **s07** | **Stagger** — delay distribution, from (first/center/last/index/random), grid (2D), axis, easing-over-stagger; trail | `@labpics/motion/stagger` | D6 | HIGH | s05, s06 |
| **s08** | **Gestures + inertia/decay** — hover/press/focus, pan, drag (axis/constraints/bounds), inertia/momentum (+decay generator), keyboard-accessible, gesture→animation binding; velocity-based deceleration | `@labpics/motion/gestures` | D7 | HIGH | s01, s02 |
| **s09** | **Compositor / WAAPI path** — WAAPI native emit, hardware-accel transforms, off-main-thread, shared rAF frameloop (`frame`) | `@labpics/motion/waapi` | D11 | MED | s03, s04, s05 |
| **s10** | **Scroll** — scroll-linked (progress), scroll-triggered (in-view), axis, container/target, offsets, velocity, pinning, scrub sync, ScrollTimeline hw-accel | `@labpics/motion/scroll` | D8 | HIGH | s02, s09 |
| **s11** | **Layout / FLIP + auto-animate** — auto `layout`, shared-element `layoutId`, group sync, scroll/fixed-aware, scale-distortion correction, reorder; zero-config drop-in FLIP | `@labpics/motion/layout` | D9 | MED | s02, s09 |
| **s12** | **Presence (enter/exit)** — mount/unmount enter/exit/update lifecycle | `@labpics/motion/presence` | D9 | HIGH | s02 |
| **s13** | **SVG · Framework bindings · A11y · Packaging** — path draw/stroke, motion-path, SVG morph; React/Vue/Svelte/Solid/Angular bindings + hooks; global reduced-motion config, per-animation override, reader hook, reduce strategy; subpath/modular exports, tree-shaking, lazy/opt-in feature loading | `@labpics/motion/{svg,react,vue,svelte,a11y}` | D10, D12, D13, D14 | MED-LOW | s02, s04, s09, s12 |

## Build-order (dependency-respecting, no forward-deps)
1. Roots: **s00 engine invariants**.
2. **s01 spring ergonomics**, **s03 value model**, **s04 easing catalog**.
3. **s02 scrubbable driver/tween**.
4. **s05 keyframes**, **s06 timeline**.
5. **s07 stagger**, **s08 gestures+inertia**, **s09 compositor/WAAPI**.
6. **s10 scroll**, **s11 layout+auto**, **s12 presence**.
7. **s13 SVG / bindings / a11y / packaging**.

## Trace guarantee
Every downstream feature scope MUST reference one `s00..s13` id and its subpath here, and one source dimension `D<n>` in `feature-matrix.md`. No feature is authorized that does not trace to a locked capability + a cited competitor doc. The s00 invariants are acceptance criteria on all of them.

## What is intentionally NOT in scope (and why — these are out-of-superset, not descopes)
- Native (React Native) / canvas-only / WebGL-first engines — out of the web-library remit (the value model s03 still allows animating JS objects incl. Three.js, which covers the WebGL bridge use-case without a separate renderer).
- A visual transition editor (Motion+ paid) — tooling, not engine capability.
These exclusions are scope boundaries decided at lock time, documented for auditability; they are not silent drops of union capabilities.
