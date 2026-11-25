# Competitive diagnosis: from startup to native timelines

2026-11-25, Windows, Chrome 158.0.8127.88, Node 24.15.0, real installed Motion 14.5.0. Baseline is built draft #586, not accepted main. Runtime-tree, entry, vendor and adapter fingerprints and raw observations are retained. Eight measured fresh-page rotations per workload; upper medians. Diagnostic, not calibrated S1–S6 / PROFILE-01 qualification, GPU/energy measurement or a universal ranking.

## Startup

Initial cold linear transform 1000: baseline 21.5 ms API return, 90.9 ms CDP TaskDuration through natural completion; Motion 7.1 / 106.6 ms; raw WAAPI 9.2 / 69.6 ms. Initial warm rows are invalid as comparative work: Motion returned a no-op after external style reset on previously animated targets. The corrected probe warms distinct throwaway elements, uses fresh measured targets, requires effects, completion duration and final geometry. The first corrected attempt was invalidated by a concurrent build changing the dist path; not evidence. The repeat uses immutable copied artifacts and verifies hashes before/after.

| Linear scenario | #586 API ms | Rest-plan experiment API ms | Motion API ms | Baseline / rest / Motion TaskDuration ms |
|---|---:|---:|---:|---:|
| Cold 100 | 4.3 | 3.7 | 1.7 | 14.8 / 15.3 / 20.1 |
| Cold 1000 | 20.0 | 18.2 | 7.0 | 82.9 / 82.9 / 96.5 |
| Warm realm 1000 | 14.7 | 14.2 | 2.5 | 78.3 / 79.1 / 84.8 |
| Stagger 200 | 6.2 | 5.9 | 2.8 | 141.7 / 142.5 / 145.6 |

The root creates every native effect synchronously. Motion creates none before return, so API-return is not the same work boundary. On cold 1000 the root requests 2000 computed-style reads and 1000 inline writes before return; Motion requests 1000 computed-style reads over the measured interval. Raw WAAPI is an explicit-known-origin platform control, not a feature-equivalent library. TaskDuration is renderer main-thread time through completion; endpoint checks and cancel/removal are outside that interval. The rest experiment adds 77 B to the baseline closure, produces no material total CPU benefit, and is not included in the timeline candidate.

## Canonical timeline and native projection

The old program computes segment length and start independently; [0,.2,.7,1] at 600 ms yields a floating-point mismatch at a contiguous boundary. An exact projection correctly refused it. Canonical absolute endpoint arithmetic resolves this without a tolerance-based admission rule. Positive unrepresentable intervals fail before publication. Continuous scalar timelines with matched surface timing lower to one native effect. Gaps, discontinuities, incompatible axes, unsupported CSS easing and nonrepresentable offsets retain the numerical executor. Native controls and cleanup retain the same owner.

| Four keyframes, 600 ms | Baseline TaskDuration ms | Canonical candidate ms | Motion ms | Raw WAAPI ms |
|---|---:|---:|---:|---:|
| 100 targets | 103.7 | 16.8 | 24.3 | 12.4 |
| 500 targets | 250.2 | 49.1 | 69.3 | 39.0 |

All four arms match the independent authored piecewise-linear equation at six times for every target in a separate real DOM trial, and pass natural completion and final cleanup checks. Candidate library rAF reservations fall from 146/145 to zero. At 500, API return is 5.2 / 14.4 / 8.3 / 7.1 ms (baseline/candidate/Motion/raw); completion 606.5 / 625.6 / 609.9 / 618.7 ms. Candidate CPU is about 29% lower than Motion in this diagnostic, but loses on API return and completion. No general non-regression claim; no calibrated confidence intervals. Root closure 15828 B exceeds unchanged 15600 cap by 228 B. 795 targeted tests, four additional native timeline tests and 26 real Chrome scenarios passed. Not release-qualified.

Reproduce from the experimental checkout with locked benchmark dependencies and built immutable artifact folders using `node bench/compare/leadership-startup-probe.mjs <base-dist> <rest-dist> candidate` and `node bench/compare/leadership-timeline-probe.mjs <base-dist> <canonical-dist>`. Exact measured revisions in receipt.json and Git history. Initial invalid warm controls explicitly retained as rejected evidence.

## Next selection

Do not chase API-return by merely delaying the same work. Factor one immutable native instruction from the canonical Program and reuse it across identical bindings, with independent Track ownership. Compare cold/warm/stagger and authored/sequence work, keep the size cap, then run the existing calibrated S1–S6 and PROFILE-01/SELECT-01. Accepted source and packed consumer results are required before a leadership statement. References: [Motion performance](https://motion.dev/docs/performance), [Motion animate](https://motion.dev/docs/animate), [Web Animations timing model](https://www.w3.org/TR/web-animations-1/#timing-model).
