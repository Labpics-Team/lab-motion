# Feature Matrix — Competitive Capability Inventory

> N7 source of truth. Per-competitor feature inventory across 14 animation dimensions, grounded in official docs (Firecrawl/Context7), not memory. Every capability cites a competitor doc. Generated 2026-06-26 via research-swarm; Theatre.js/Rive/Lottie/scroll-driven CSS columns added 2026-06-27.

**Competitors:** C1 Motion (`motion`, ex-Framer Motion) · C2 GSAP (incl. now-free plugins) · C3 anime.js v4 · C4 react-spring · C5 Motion One / Motion mini · C6 AutoAnimate (FormKit) · C7 Theatre.js · C8 Rive · C9 Lottie · C10 native scroll-driven CSS (animation-timeline/@keyframes) · + native platform (WAAPI / ScrollTimeline / View Transitions).

**Legend:** ✅ documented · ➖ not in official docs / n/a · `lab` column = @labpics/motion v1.0.0 status (has / partial / —).

---

## D1 — Animatable Values
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Numbers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅(sheet values) | ✅(state machines) | ✅(JSON props) | ✅(property-based) | has |
| Units (px/%/deg/rem/vh) | ✅ | ✅ | ✅ | ✅(interp) | ✅ | ➖ | ➖ | ➖ | ✅(CSS props) | — |
| Colors (hex/rgb/hsl) | ✅ | ✅ | ✅ | ✅(interp) | ✅ | ➖ | ✅(fill/stroke) | ✅(color stops) | ✅(color properties) | — |
| Transforms (independent x/y/scale/rotate/skew) | ✅ | ✅ | ✅ | ✅(interp) | ✅ | ✅(3D transforms) | ✅(bones/transforms) | ✅(transforms) | ✅(individual transforms) | — |
| CSS variables | ✅ | ✅ | ✅ | ➖ | mini: registered only | ➖ | ➖ | ➖ | ✅(registered custom props) | — |
| Complex strings / filters / gradients | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(filter/gradient props) | — |
| JS objects / WebGL (Three.js) | ✅ | ✅ | ✅ | ✅ | ➖ | ✅(JS obj via extensions) | ➖ | ➖ | ➖ | — |
| HTML/SVG attributes | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ✅(SVG) | ✅(SVG/Lottie JSON) | ➖ | — |
| Relative values | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |

Cites: motion.dev/docs/animate; animejs.com/documentation/animation/animatable-properties; gsap.com (`/llmstxt/gsap_llms_txt`); react-spring docs.advanced.interpolation; theatrejs.com/docs/latest/getting-started; rive.app/docs/runtimes; airbnb.io/lottie; developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline.

## D2 — Springs
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Physics spring (stiffness/damping/mass) | ✅ | ➖(eases) | ✅ | ✅(tension/friction/mass) | ✅ | ➖ | ✅(physics constraints) | ➖ | ➖ | has |
| Duration+bounce spring | ✅(bounce 0.25) | ➖ | ✅(`spring({bounce})`) | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| visualDuration | ✅ | ➖ | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Spring from current velocity | ✅(`velocity`) | ➖ | ➖ | ✅ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| restSpeed/restDelta | ✅(0.1/0.01) | ➖ | ➖ | ✅ | ✅ | ➖ | ➖ | ➖ | ➖ | partial(0.005) |
| Presets | ➖ | ➖ | ➖ | ✅(default/gentle/wobbly/stiff/slow/molasses) | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Spring-as-easing | ✅ | ➖ | ✅ | native | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Multi-property springs | ✅ | ➖ | ✅ | ✅(useSprings) | ✅ | ➖ | ✅(multi-bone) | ➖ | ➖ | — |

Cites: motion.dev/docs/animate (stiffness 1/damping 10/mass 1/bounce 0.25/visualDuration/velocity/restSpeed/restDelta); animejs.com/documentation/easings; react-spring docs.advanced.config; rive.app/docs/runtimes (physics constraints).

## D3 — Easings
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Named curves | ✅(linear,easeIn/Out/InOut,circ,back,anticipate) | ✅(power,sine,expo,circ,elastic,back,bounce,steps) | ✅(out,inOut families) | ➖ | ✅ | ✅(Theatre built-in curves) | ➖ | ➖ | ✅(ease/ease-in/ease-out/ease-in-out) | — |
| cubic-bezier (4 nums) | ✅ | ✅(CustomEase) | ✅(`cubicBezier`) | ➖ | ✅ | ✅ | ➖ | ➖ | ✅(cubic-bezier()) | — |
| steps() | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(steps()) | — |
| Custom JS easing fn | ✅ | ✅ | ✅ | ➖ | ✅ | ✅(custom curves) | ➖ | ➖ | ➖ | — |
| Spring-as-easing | ✅ | ➖ | ✅ | native | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Per-keyframe easing array | ✅ | ✅(easeEach) | ✅(playbackEase) | ➖ | ✅ | ✅(per-keyframe) | ➖ | ➖ | ✅(animation-timing-function per keyframe) | — |

Cites: motion.dev/docs/animate (full named list + cubic-bezier + fn); gsap.com/resources/keyframes; animejs.com/documentation/easings; theatrejs.com/docs/latest/concepts/sequences; developer.mozilla.org/en-US/docs/Web/CSS/animation-timing-function.

## D4 — Keyframes
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Keyframe arrays | ✅ | ✅ | ✅ | ➖ | ✅ | ✅(sequence keyframes) | ✅(animation keyframes) | ✅(Lottie keyframe format) | ✅(@keyframes) | — |
| Offsets / times | ✅(`times`) | ✅(`%`) | ✅ | ➖ | ✅ | ✅(time units) | ✅(time offsets) | ✅ | ✅(percentage offsets) | — |
| Per-keyframe easing | ✅ | ✅ | ✅ | ➖ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| repeat / Infinity | ✅ | ✅(-1) | ✅(loop) | ✅ | ✅ | ➖ | ✅(loop) | ✅(loop) | ✅(animation-iteration-count:infinite) | — |
| loop/reverse/mirror/yoyo | ✅(repeatType) | ✅(yoyo) | ✅(alternate) | ✅ | ✅ | ➖ | ✅(ping-pong) | ✅ | ✅(animation-direction:alternate) | — |
| repeatDelay | ✅ | ✅ | ✅(loopDelay) | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(animation-delay on iteration) | — |

Cites: motion.dev/docs/animate; gsap.com/resources/keyframes; animejs.com/documentation/animation/keyframes/tween-values-keyframes; theatrejs.com/docs/latest/concepts/sequences; rive.app/docs/runtimes; airbnb.io/lottie (lottie keyframe format); developer.mozilla.org/en-US/docs/Web/CSS/@keyframes.

## D5 — Timeline / Sequencing
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Sequence | ✅ | ✅ | ✅ | ➖ | ✅ | ✅(Sequence editor) | ✅(state machine transitions) | ➖ | ➖ | — |
| Labels | ✅ | ✅(addLabel) | ✅ | ➖ | ✅ | ✅(named sequences) | ➖ | ➖ | ➖ | — |
| Relative position (+/-/</>) | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Absolute position | ✅(`at`) | ✅ | ✅ | ➖ | ✅ | ✅(absolute time) | ➖ | ➖ | ➖ | — |
| Per-segment override | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| defaults | ✅(defaultTransition) | ✅(defaults) | ✅(defaults) | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Nested timelines | ✅ | ✅ | ✅ | ➖ | partial | ➖ | ✅(nested state machines) | ➖ | ➖ | — |
| Playback control (play/pause/reverse/seek/timeScale/progress) | ✅(time/speed/stop/complete/cancel/then) | ✅ | ✅ | ✅(api) | ✅ | ✅(full playback API) | ✅(play/pause/reset) | ✅(play/pause/seek) | ➖ | partial(Promise only) |

Cites: motion.dev/docs/animate (sequences/labels/at/controls); gsap.com/docs/v3/GSAP/Tween; animejs createTimeline; theatrejs.com/docs/latest/concepts/sequences; rive.app/docs/runtimes (playback); airbnb.io/lottie (playback controls).

## D6 — Stagger
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Fixed delay | ✅(`stagger()`) | ✅ | ✅ | ✅(useTrail) | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| from (first/center/last/index/random) | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Grid (2D) | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Axis lock | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Easing over stagger | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |

Cites: motion.dev/docs/animate#stagger; animejs.com/documentation/utilities/stagger(+stagger-from); GSAP utils stagger; theatrejs.com/docs/latest; rive.app/docs/runtimes.

## D7 — Gestures
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Hover | ✅(whileHover) | ➖ | ➖ | use-gesture | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Press/tap | ✅(whileTap) | ➖ | ➖ | use-gesture | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Focus | ✅(whileFocus) | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Pan | ✅ | ✅(Draggable) | ✅ | use-gesture | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Drag + constraints/bounds | ✅ | ✅(`bounds`) | ✅(`container`) | use-gesture | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Drag inertia/momentum | ✅ | ✅(`inertia`/InertiaPlugin) | ✅(`releaseEase:spring`) | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Keyboard accessible | ✅(Enter→tap) | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | — |

Cites: motion.dev/docs/react-gestures; gsap.com/resources/svg (Draggable); animejs createDraggable; theatrejs.com/docs/latest; rive.app/docs/runtimes.

## D8 — Scroll
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Scroll-linked (progress) | ✅(`scroll()`) | ✅(scrub) | ✅(`onScroll`) | useScroll | ✅ | ➖ | ➖ | ➖ | ✅(scroll-driven animation native) | — |
| Scroll-triggered (in-view) | ✅(inView) | ✅ | ✅ | useInView | ✅ | ➖ | ➖ | ➖ | ✅(animation-range:entry/exit) | — |
| Axis x/y | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(x/y scroll timeline) | — |
| Container/element | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(scroll-timeline on element) | — |
| Target + offsets | ✅(offset intersections) | ✅ | ✅ | rootMargin | ✅ | ➖ | ➖ | ➖ | ✅(animation-range offsets) | — |
| Velocity | ✅ | ✅(getVelocity) | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Pinning | ✅(sticky) | ✅(`pin`) | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Scrub sync modes | ✅ | ✅(`scrub:1`) | ✅(`sync`) | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(native sync no JS) | — |
| ScrollTimeline hw-accel | ✅ | ➖ | ✅(waapi) | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(native compositor thread) | — |

Cites: motion.dev/docs/scroll; gsap.com/docs/v3/Plugins/ScrollTrigger; animejs.com/documentation/events/onscroll; developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline (scroll-driven); developer.chrome.com/docs/css-ui/scroll-driven-animations.

## D9 — Layout / FLIP / Presence
| Capability | C1 | C2 | C3 | C4 | C6 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Auto layout (FLIP) | ✅(`layout`) | ✅(Flip) | ➖ | ➖ | ✅(zero-config) | ➖ | ➖ | ➖ | ➖ | — |
| Shared-element (layoutId) | ✅ | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Enter/exit presence | ✅(AnimatePresence) | ➖ | ➖ | ✅(useTransition) | ✅ | ➖ | ➖ | ➖ | ✅(view-transition) | — |
| Reorder | ✅ | ✅ | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Group sync | ✅(LayoutGroup) | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Scroll/fixed-aware | ✅(layoutScroll/Root) | ➖ | ➖ | ➖ | auto | ➖ | ➖ | ➖ | ➖ | — |
| Scale-distortion correction | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Zero-config drop-in | ➖ | ➖ | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |

Cites: motion.dev/docs/react-layout-animations; auto-animate.formkit.com; react-spring useTransition; GSAP Flip; theatrejs.com/docs/latest; rive.app/docs/runtimes; developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API.

## D10 — SVG
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Path draw / stroke | ✅(pathLength/Spacing/Offset) | ✅(DrawSVG) | ✅(createDrawable `draw:'0 1'`) | ➖ | ✅ | ➖ | ✅(SVG path animation) | ✅(shape layers) | ➖ | — |
| Path morph | ➖ | ✅(MorphSVG) | ✅(morphTo) | ➖ | ➖ | ➖ | ✅(bone/mesh morph) | ✅(shape morph) | ➖ | — |
| Motion-path (along path) | ✅(`arc()`) | ✅(MotionPath: align/autoRotate) | ✅(createMotionPath) | ➖ | ✅ | ➖ | ✅(path constraint) | ➖ | ✅(offset-path) | — |
| SVG attribute animation | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ✅ | ✅ | ➖ | — |
| transform-origin/alignOrigin | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ✅ | ✅ | ➖ | — |

Cites: motion.dev/docs/animate#svg-paths; gsap.com/docs/v3/Plugins/{MotionPathPlugin,MorphSVGPlugin}+resources/svg; animejs.com/documentation/svg; rive.app/docs/runtimes (vector graphics); airbnb.io/lottie (shape layers); developer.mozilla.org/en-US/docs/Web/CSS/offset-path.

## D11 — Compositor / WAAPI / Perf
| Capability | C1 | C2 | C3 | C4 | C5 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| WAAPI native | ✅(mini 2.3kb) | ➖ | ✅(`waapi.animate`) | ➖ | ✅ | ➖ | ✅(WASM-accelerated) | ✅(Bodymovin WAAPI) | ✅(native WAAPI integration) | — |
| Hardware-accel transforms | ✅ | transforms | ✅ | ➖ | ✅ | ✅(GPU renderer) | ✅(GPU renderer) | ✅ | ✅(native compositor) | — |
| ScrollTimeline hw-accel | ✅ | ➖ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ✅(native) | — |
| Off-main-thread | ✅ | ➖ | ✅ | ➖ | ✅ | ➖ | ✅(WASM) | ✅(WASM player) | ✅(compositor thread) | — |
| Shared rAF frameloop | ✅(`frame`) | ✅(ticker) | ✅ | ✅(rafz) | ✅ | ✅(Theatre frameloop) | ➖ | ➖ | ➖ | partial(injected seam) |

Cites: motion.dev/docs/animate (mini 2.3kb/hybrid 18kb, `frame`); motion.dev/docs/scroll (ScrollTimeline off-main-thread); animejs.com/documentation/web-animation-api; rive.app/docs/runtimes (WASM renderer); theatrejs.com/docs/latest (Theatre frameloop); developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API.

## D12 — Framework Bindings
| Capability | C1 | C2 | C3 | C4 | C6 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Vanilla JS | ✅ | ✅ | ✅ | ➖ | ✅ | ✅ | ✅ | ✅ | ✅(pure CSS) | has |
| React | ✅ | ✅(useGSAP) | ✅ | ✅(hooks) | ✅(useAutoAnimate) | ✅(React bindings) | ✅(React runtime) | ✅(React Lottie) | ➖ | — |
| Vue | ✅(community) | ✅ | ✅ | ➖ | ✅(v-auto-animate) | ➖ | ✅(Vue runtime) | ✅(Vue Lottie) | ➖ | — |
| Svelte | community | ✅ | ✅ | ➖ | ✅(action) | ➖ | ✅(Svelte runtime) | ✅(Svelte Lottie) | ➖ | — |
| Solid | ➖ | ➖ | ✅ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Angular | ➖ | ➖ | ✅ | ➖ | ✅(directive) | ➖ | ➖ | ✅(ngx-lottie) | ➖ | — |
| Preact | ➖ | ➖ | ➖ | ➖ | ✅ | ➖ | ➖ | ➖ | ➖ | — |
| Imperative hooks | ✅ | ➖ | ➖ | ✅(useSpring/Trail/Transition/Chain/Scroll/InView) | ➖ | ✅(useVal/useObject) | ➖ | ➖ | ➖ | — |
| SSR-safe | ✅ | ✅ | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | ✅(pure CSS) | has |

Cites: motion.dev/docs/react-*; react-spring github; auto-animate.formkit.com; animejs.com/documentation/getting-started/using-with-react; theatrejs.com/docs/latest/getting-started; rive.app/docs/runtimes; airbnb.io/lottie.

## D13 — Accessibility (Reduced Motion)
| Capability | C1 | C2 | C3 | C4 | C6 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Honor prefers-reduced-motion | ✅(`reducedMotion`) | ✅(`gsap.matchMedia`) | ✅(scope mediaQueries) | ✅(useReducedMotion+skipAnimation) | ✅(default) | ➖ | ➖ | ➖ | ✅(@media prefers-reduced-motion) | has |
| Global config | ✅(MotionConfig) | ✅(contexts) | scope | ✅(Globals) | ✅ | ➖ | ➖ | ➖ | ✅(media query scope) | partial |
| Per-animation always/never | ✅ | branch | branch | manual | `disrespectUserMotionPreference` | ➖ | ➖ | ➖ | ➖ | — |
| Reader hook | ✅(useReducedMotion) | matchMedia | self.matches | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ | — |
| Reduce strategy (keep opacity, drop transform) | ✅(auto) | manual | manual | jump-to-goal | n/a | ➖ | ➖ | ➖ | manual | partial(snap to final) |
| Injected/testable seam | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | **has (unique)** |

Cites: motion.dev/docs/react-accessibility; gsap.com/resources/a11y; react-spring docs.utilities.use-reduced-motion; auto-animate.formkit.com; developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion; theatrejs.com/docs/latest; rive.app/docs/runtimes.

## D14 — Perf Budget / Packaging
| Capability | C1 | C2 | C3 | C4 | C6 | C7 | C8 | C9 | C10 | lab |
|---|---|---|---|---|---|---|---|---|---|---|
| Small core | mini 2.3kb/hybrid 18kb | modular | lightweight | per-pkg | tiny | ~50kb+ | runtime varies | lottie.min ~60kb | 0kb (native) | ~1.9kb |
| Zero runtime deps | mostly | ✅ | ✅ | React peer | ✅ | ➖ | ✅(WASM self-contained) | ➖ | ✅(native) | has |
| Tree-shaking | ✅ | ✅ | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | ✅(no JS) | partial |
| Subpath/modular exports | ✅(`/mini`,`/react`) | ✅(per-plugin) | ✅(named) | ✅(`/web`,`/native`,`/three`) | ✅(`/react`,…) | ➖ | ➖ | ➖ | ➖ | — |
| Lazy/opt-in features | ✅ | ✅ | ✅ | ✅ | ➖ | ➖ | ✅(lite vs full) | ✅(player types) | ✅(native) | — |
| SSR-safe | ✅ | ✅ | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | ✅(pure CSS) | has |
| ESM+CJS dual | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ➖ | has |
| Deterministic / CSS-safe (no NaN/Inf) | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | **has (unique)** |
| Pinned/contract-tested surface | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | **has (unique)** |

Cites: motion.dev/docs/{animate,scroll,react-layout-animations} (sizes); gsap.com/blog/3-13 (free, modular); react-spring github (packages); auto-animate.formkit.com; theatrejs.com/docs/latest; rive.app/docs/runtimes; airbnb.io/lottie; lab-motion README+package.json.

---

### Notable competitive signals
- **GSAP is now 100% free** including MorphSVG/SplitText/all former Club plugins (v3.13, Webflow, 2025) — gsap.com/blog/3-13/.
- **Native morph** exists only in GSAP & anime.js; Motion has no native SVG morph.
- **AutoAnimate** proves a zero-config FLIP primitive can be ~one function and respect reduced-motion by default.
- **Theatre.js** targets professional-quality, scrubable timeline animations with a studio GUI — not a runtime library for interactions.
- **Rive** is a state-machine + vector animation runtime (WASM) — compile-time design-to-code, not a web animation library; strengths are GPU renderer, physics constraints, nested state machines.
- **Lottie** (Airbnb/LottieFiles) is a JSON-based After-Effects player — no JS animation API; strengths are designer workflow and cross-platform reach.
- **Native scroll-driven CSS** (`animation-timeline: scroll()`) ships in Chrome 115+/Firefox 110+/Safari 18+ — zero-JS, compositor-threaded; weakness is no JS API for dynamic control or velocity, no pinning.
- **lab-motion's three unique HAS** (injected-seam reduced-motion, deterministic CSS-safe, pinned surface) appear in no competitor and are invariants to preserve.
