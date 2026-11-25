# Shared relative trajectories and binding placement — 2026-11-25

Status: exploratory integration, not production-qualified. Based on the preceding native-instruction experiment (source 1aa0d516, not accepted main). Final measured source 91e6eabb4756c6dac00a1dc66dbdcfaed4f13409. Exact source, entry, runtime-tree and adapter hashes, raw samples and medians in receipt.json. The recorded input hashes describe the final harness checkout; the initial measurements used earlier probe revisions.

## Representation

- A Program describes local numerical geometry and duration. A Draft/Track supplies placement; public completion is derived as placement + local duration. No per-stagger Program wrapper or serialized-keyframe comparison.
- The local shape retains a conservative lower bound on its positive interval spacing. A placement whose endpoint rounding error is below that bound needs no interval scan. Ambiguous extreme placements perform the exact endpoint check and reject collapsed positive intervals. Sample selection and endpoint snaps use placed boundaries; interpolation uses local segment duration.
- Sequence preparation shares matching immutable histories (same preceding history, Program and absolute placement). Each shared final history is flattened once in sequence time; distinct histories remain independent. This is publication-local sharing, not global interning or a claim of sharing every structurally equal independently compiled history.
- Native projection compares Program identity, surface pose, realm and aligned track time. Separate publication-local transform and opacity slots preserve sharing in mixed groups. Delay is instance placement; one detached template is cloned for repeats. Unsupported timelines retain numerical execution.

## Actual startup and retained heap

Windows, Node 24.15.0, built root API on fake style hosts; two warmups/eight alternating measured pairs, upper medians, explicit GC before and after startup+pause. Retained JS heap delta, not allocation count or browser memory. Every pair checks geometry, public duration and final cleanup. A/A uses identical previous artifact bytes.

| Workload | Previous ms | Final ms | Previous heap B | Final heap B |
|---|---:|---:|---:|---:|
| 100 × 960 staggered keys | 11.6050 | 2.4273 | 17269192 | 273472 |
| 1000 × 8 staggered keys | 4.8693 | 2.7168 | 2360312 | 867056 |
| 100 targets × 12 sequence steps × 8 keys | 1.8032 | 1.6269 | 236256 | 113320 |

Largest-workload A/A: 11.1122 / 10.8318 ms, 17261920 / 17262400 retained bytes. Sequence timing difference alone is modest; retained heap decreases by about 52%. Reproduce with node --expose-gc bench/compare/relative-program-node.mjs <base-dist> <new-dist>.

## Dense stagger in Chrome

Chrome 158.0.8127.88, installed Motion 14.5.0. 100 targets, 129 keys, 512 ms motion, 2 ms stagger. Real DOM and natural completion. Eight measured fresh-page rotations per arm. Independent piecewise-linear pose oracle at six times, endpoint and cleanup checks; no library rAF in any of the four native arms. The first measurement overlapped a browser conformance run, so use the separate repeat for the main comparison. CPU is main-thread CDP TaskDuration through completion, not FPS, GPU time, energy or cleanup CPU.

| Arm | API return ms | CPU ms | Completion ms |
|---|---:|---:|---:|
| Previous shared-instruction experiment | 17.4 | 111.146 | 739.2 |
| Relative Program experiment | 8.1 | 103.977 | 727.8 |
| Motion.dev 14.5.0 | 7.4 | 140.051 | 713.8 |
| Raw WAAPI | 27.0 | 105.880 | 746.3 |

Raw WAAPI directly instantiates every known-origin keyframe list; it is a platform control, not an equivalent controller library. Motion still returns slightly sooner and completes sooner than Lab. No calibrated confidence intervals, no general leadership claim. Initial startup/dense probes belong to the earlier placement-wrapper build and are explicitly retained as historical diagnostics. Reproduce browser repeat with node bench/compare/leadership-timeline-probe.mjs <base-dist> <new-dist> dense-stagger.

## Acceptance and limitations

1145 existing targeted tests plus four relative-program tests passed; 29 actual Chrome scenarios passed. Typecheck passed. The numerical placement tests compare the certificate with exact endpoint representability across ordinary, fractional, subnormal and extreme values. Native template isolation across documents and retarget owners is covered by the browser suite. Independent local Codex review did not produce a verdict (waiting for stdin; the owned task was stopped). The full closure is 16434 bytes gzip, 14742 Brotli, versus 15600 allowed: +834 B. Consumer root animate bundle is 13223 gzip; its separate cap passes. Full size gate fails. This is a draft for review, not a production delivery; do not enable automerge or relax the cap. Predecessor #585 remains blocked and #586 remains draft.

Sources: https://www.w3.org/TR/web-animations-1/#the-keyframeeffect-interface and https://guillaumeblanc.github.io/ozz-animation/documentation/animation_runtime/.
