# Gap Matrix — @labpics/motion v1.0.0 HAS vs Union

> The delta between what v1.0.0 ships and the union of competitor capabilities (the feature-matrix). Baseline grounded by reading `src/{index,spring,tween,drive,errors}.ts`. Generated 2026-06-26 via research-swarm. N7 source of truth.

## v1.0.0 actual surface (read from code, not prompt)
Public exports (pinned by `api-surface-pin.test.ts`): `spring`, `tween`, `drive`, `validateSpringParams`, `MotionParamError` + types `SpringParams`/`SpringResult`/`DriveOptions`. Single `.` export.

| HAS (confirmed in src) | Evidence |
|---|---|
| Analytical spring solver (underdamped/critical/overdamped) | `src/spring.ts:117` `springUnchecked` 3-regime closed form |
| Linear tween (exact endpoints) | `src/tween.ts:22` `tween()` exact-endpoint guarantee |
| Declarative driver `drive()` returning Promise | `src/drive.ts:114` `drive()` |
| Reduced-motion short-circuit (injected matchMedia) | `src/drive.ts:84` `prefersReducedMotion` |
| Injected platform seams (matchMedia, requestFrame) | `DriveOptions` |
| CSS-safe finite clamping (no NaN/Infinity) | `clampFinite`/`clamp` |
| Monotonic, convergence-bounded, MAX_FRAMES cap | `drive.ts` |
| Eager typed validation (`MotionParamError`) | `errors.ts` + `validateSpringParams` |
| Zero deps, SSR-safe, dual ESM/CJS, ~1.9kb | `package.json` + README |

## Union (everything above the primitive = GAP)
Each gap row: dimension · capability · who has it · severity (CORE = root primitive others depend on; HIGH = table-stakes; MED = differentiator; LOW = optional/heavy).

| Dim | Gap capability | Held by | Severity |
|---|---|---|---|
| D1 | Value types: units (px/%/deg/rem/vh) | C1 C2 C3 C5 | **CORE** |
| D1 | Value types: colors (hex/rgb/hsl) | C1 C2 C3 C5 | **CORE** |
| D1 | Value types: transforms (independent x/y/scale/rotate/skew) | C1 C2 C3 C5 | **CORE** |
| D1 | Value types: CSS variables | C1 C2 C3 | HIGH |
| D1 | Value types: complex strings/filters/gradients | C1 C2 C3 C5 | MED |
| D1 | Value types: JS objects / WebGL | C1 C2 C3 C4 | MED |
| D1 | Value types: HTML/SVG attributes | C1 C2 C3 C5 | MED |
| D1 | Relative values | C1 C2 C3 C5 | MED |
| D2 | Duration+bounce spring ergonomic API | C1 C3 C5 | HIGH |
| D2 | visualDuration | C1 C5 | MED |
| D2 | Spring from current velocity | C1 C4 C5 | HIGH |
| D2 | Spring presets | C4 | MED |
| D2 | Spring-as-easing | C1 C3 C4 C5 | HIGH |
| D2 | Multi-property springs | C1 C3 C4 C5 | HIGH |
| D3 | Easing catalog (named curves) | C1 C2 C3 C5 | **CORE** |
| D3 | cubic-bezier | C1 C2 C3 C5 | **CORE** |
| D3 | steps() | C1 C2 C3 C5 | HIGH |
| D3 | Custom JS easing fn | C1 C2 C3 C5 | HIGH |
| D3 | Per-keyframe easing | C1 C2 C3 C5 | HIGH |
| D4 | Keyframe arrays + offsets/times | C1 C2 C3 C5 | HIGH |
| D4 | repeat / loop / reverse / mirror / yoyo / repeatDelay | C1 C2 C3 C4 C5 | HIGH |
| D5 | Timeline sequence + labels + position param | C1 C2 C3 C5 | HIGH |
| D5 | Playback control (play/pause/reverse/seek/timeScale/progress) | C1 C2 C3 C4 C5 | **CORE** (scrubbable driver) |
| D5 | defaults / per-segment override | C1 C2 C3 C5 | MED |
| D6 | Stagger (delay/from/grid/axis/easing) | C1 C2 C3 C5 | HIGH |
| D6 | Trail (spring chain) | C4 | MED |
| D7 | Gestures: hover/press/focus | C1 | HIGH |
| D7 | Gestures: pan/drag + constraints/bounds | C1 C2 C3 | HIGH |
| D7 | Drag inertia/momentum (+ decay/inertia generator) | C1 C2 C3 C4 | HIGH |
| D7 | Keyboard-accessible gestures | C1 | HIGH |
| D8 | Scroll-linked (progress) | C1 C2 C3 C4 C5 | HIGH |
| D8 | Scroll-triggered (in-view) | C1 C2 C3 C4 C5 | HIGH |
| D8 | Scroll offsets / velocity / pinning / scrub | C1 C2 C3 C5 | MED |
| D8 | ScrollTimeline hw-accel path | C1 C3 C5 | MED |
| D9 | Layout/FLIP (auto) | C1 C2 C6 | MED (signature) |
| D9 | Shared-element (layoutId) | C1 C2 | MED |
| D9 | Enter/exit presence | C1 C4 C6 | HIGH |
| D9 | Reorder / group sync / scale-correction | C1 C2 C6 | MED |
| D9 | Zero-config drop-in FLIP | C6 | MED |
| D10 | SVG draw / stroke | C1 C2 C3 C5 | MED |
| D10 | SVG morph | C2 C3 | LOW (heavy, optional) |
| D10 | Motion-path (along path) | C1 C2 C3 C5 | MED |
| D10 | SVG attribute animation | C1 C2 C3 C5 | MED |
| D11 | WAAPI native emit path | C1 C3 C5 | MED |
| D11 | Hardware-accel / off-main-thread | C1 C3 C5 | MED |
| D11 | Shared rAF frameloop (`frame`) | C1 C2 C3 C4 C5 | MED |
| D12 | React binding + hooks | C1 C2 C3 C4 C6 | HIGH (DS is React/Next) |
| D12 | Vue/Svelte/Solid/Angular bindings | C2 C3 C6 | MED |
| D13 | Global reduced-motion config | C1 C2 C3 C4 C6 | MED |
| D13 | Per-animation always/never override | C1 C6 | MED |
| D13 | Reduced-motion reader hook/export | C1 C4 | MED |
| D13 | Reduce strategy (preserve opacity, drop transform) | C1 | MED |
| D14 | Subpath / modular exports | C1 C2 C3 C4 C6 | **CORE** (cross-cutting; gates bundle growth) |
| D14 | Lazy/opt-in feature loading | C1 C2 C3 C4 | MED |

## Severity rollup
- **CORE (5):** value types (units/colors/transforms), easing catalog+cubic-bezier, playback-controllable driver, subpath exports. Nothing else is buildable or shippable-at-budget without these.
- **HIGH (≈18):** spring ergonomics, keyframes, timeline, stagger, gestures, scroll, presence, React binding.
- **MED (≈22):** SVG, WAAPI, layout tiers, a11y surface, multi-framework.
- **LOW (1):** SVG morph.

## Invariants that constrain HOW gaps are closed (must NOT be descoped)
Every new capability must preserve: determinism · CSS-safety (no NaN/Infinity emitted) · SSR-safety (no `window` at import; injected seams) · reduced-motion honoured at entry · pinned/contract-tested public surface · zero runtime deps. These are lab-motion's unique moats (absent in all competitors) and are non-negotiable acceptance criteria, not features.
