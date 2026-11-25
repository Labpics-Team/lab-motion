# Shared absolute phase and copy-on-write transport

Exploratory source branch based on integrated native seek and authored factoring dcf136a862fdce452d853950b9139fa4f40b66b7; not merged. Windows i9-12900K, Node 24.15.0, Chrome 158.0.8127.88. Base root ESM SHA-256 49b28bf2f58bf8683cde1b4ef259ce24ebf2a455ffef507ed32384c5fdb25bd1; candidate 9cc5f4490c7eda0611787909fc9520204623774eed2c86c39bef811b7ceec005.

Phase is an absolute wall/local time anchor with immutable rate and pause configuration. Tracks initially share it; independent transport replaces the reference. A batch captures one clock value lazily across preparation, publication, control or update. Pure CSS curve coefficients share an exact normalized input within the phase; custom easing remains effectful and uncached. Each Track retains its last sampled pose/velocity/local time for terminal and reentrant ownership. Native currentTime remains authoritative and detach reanchors JS. No new public API.

| Chrome workload | Base | Candidate | A/A control |
|---|---:|---:|---:|
| 1000 × 2 properties, 120 virtual frames, synchronous CPU/DOM-write interval | 136.9 ms | 73.2 ms | 134.4 / 131.3 ms |
| Same, clock reads during update | 240000 | 120 | 240000 / 240000 |
| Same, startup clock reads | 8000 | 2 | 8000 / 8000 |
| 100 × 2 properties, 120 virtual frames | 17.9 ms | 12.2 ms | 16.5 / 16.5 ms |
| 1000 × 2 properties, 120 seeks | 229.8 ms | 119.4 ms | not run |
| 100 × 2 properties, 120 seeks | 30.1 ms | 19.2 ms | not run |

Node headless style hosts, 1000 targets/2000 channels, 120 seeks: standard 278.2645→128.5767 ms, linear 90.3991→86.5526 ms, staggered standard 360.8449→289.7931 ms, custom 139.2728→127.4222 ms. These Node runs overlapped a separate local benchmark, so do not infer small changes as meaningful. Custom callback count remains exactly 1446000 per arm, styles and checksums match.

Reproduce from root with built dist directories: node bench/compare/cohort-frame-probe.mjs <base-dist> <candidate-dist>, node bench/compare/phase-browser-probe.mjs <base-dist> <candidate-dist>, node bench/compare/phase-runtime-probe.mjs <base-dist> <candidate-dist>. For frame A/A pass baseline twice. 2 warmup and 10 measured pairs, alternating ABBA/BAAB, upper medians. Frame probe drives the actual library scheduler with virtual timestamps and real DOM, verifies all targets at sampled phases, natural completion and no outstanding reservation. Time covers synchronous frame callbacks and CSS writes, not browser presentation, GPU or end-to-end FPS. No universal speedup or comparator leadership claim.

Typecheck, 776 motion/value tests (package spawn test excluded on Windows) and 18 Chrome conformance scenarios passed. Explicit new tests verify shared identity, one read/frame, divergence on adoption/control, frame-rate independent absolute time, backward host clock and native/JS handoff. Root closure 15987 B gzip, 387 B over unchanged 15600 cap; root animate consumer 12932 B. This exact variant is not release-qualified. Preserve the architecture; next simplify the production representation and native finalization rather than increasing the cap. Existing #581 and #580 retain their independent delivery/review status.

Design reference: https://www.w3.org/TR/web-animations-1/#timing-model (stateless time mapping); https://guillaumeblanc.github.io/ozz-animation/documentation/animation_runtime/ (batch-oriented sampling).
