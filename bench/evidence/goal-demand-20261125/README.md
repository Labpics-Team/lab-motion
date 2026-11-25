# Demand-driven spring materialization — 2026-11-25

Experimental, not release-qualified. Baseline #585 measured source 1ac32d100531e256f3a486c9c3f14afd7808fe82, root SHA256 2ada976b14e9ec16dca137de012a50ebe46bea9eb9eae67cddf74588e6d240d8, closure 15598 B gzip. #585 is still awaiting review/merge at publication.

Same-goal-only version ce4ba73459293f718c8c9b4a2cf1c075eec49658, root SHA256 66dc8347c038435cedca0434f9c94df4d452b8c0bae5e836ea9b4dda20660eea, 15688 B gzip. It validates the exact horizon but postpones reconstruction of a discarded spring trajectory until it is actually needed. Preserves resolved-goal equality and materializes the original snapshot if another goal intervenes. 791 targeted tests passed.

Generalized demand version ea26ddf52a268bcbcc4218e82752481669d7ab32, root SHA256 301794e3fc93b04f3f35ffd4d8307e2ca99ce5f14362c2f66a4cf9e52e3ae01f, 15625 B gzip (25 B over unchanged 15600 cap), 1137 targeted motion/value/compositor/token-isolation tests passed. The compiler returns a cached artifact or a validated numerical request. Only accepted playable paths materialize stops; terminal paths and discarded same-goal paths need none. Native easing is derived from the accepted artifact. The shared immutable implicit spring eliminates a redundant flag. The generalized version still needs final architectural/size acceptance and broader regression/performance checks.

Real DOM Chrome 158.0.8127.88 / Node 24.15.0, two warmups and ten paired observations per workload, fresh pages, upper medians. Actual synchronous repeat/retarget startup, controlled clock to hold the exact phase while measuring wall time. Moving cases sample at 12.5% of run duration with nonzero velocity; paused cases sample at 37.5% with zero velocity. All compared intermediate CSS strings, duration, state, final pose and cleanup match. A/A available for the initial paused matrix only; no fresh A/A for moving cases. Diagnostic, not FPS or calibrated competitive qualification.

| Workload | Same-goal-only ms (base/new) | Generalized ms (base/new) |
|---|---:|---:|
| Paused repeat 1000 | 2.1 / 2.3 | 2.1 / 2.0 |
| Moving repeat 100 | 15.7 / 0.6 | 19.0 / 0.6 |
| Moving repeat 1000 | 114.1 / 2.5 | 117.0 / 2.3 |
| Moving changed goal 1000 | 129.2 / 127.8 | 131.3 / 132.9 |
| Paused changed goal 1000 | 62.4 / 62.7 | 63.3 / 63.8 |
| Linear repeat 1000 | 2.1 / 2.2 | 1.8 / 1.7 |

Paused initial A/B and A/A: paused-ab.jsonl, paused-aa.jsonl (earlier five-case probe, before adding controlled clock and moving cases). Moving A/B: moving-ab.jsonl; generalized A/B: combined-ab.jsonl. Raw rows carry actual artifact fingerprints before/after run. Reproduce moving matrix from this experimental checkout with built artifacts: `node bench/compare/goal-demand-probe.mjs <baseline-dist> <candidate-dist>`. Do not attribute the same-goal-only timing to the generalized artifact. No size waiver or universal speed claim. Reference: https://www.w3.org/TR/web-animations-1/#timing-model.
