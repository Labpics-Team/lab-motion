# Compact representation experiment — Windows, 2026-11-25

Baseline: 51792680ba2a473b573f9f40f3a610863b221d7c, already using shared phases, root ESM SHA-256 9cc5f4490c7eda0611787909fc9520204623774eed2c86c39bef811b7ceec005. Final candidate root SHA-256 e2bf0c09cb4066c41f050e5f44146d555a11e49143f3a0a1729cf3ba3c43e808. Exploratory paired measurements on Intel i9-12900K / Node 24.15.0; `node --expose-gc bench/compare/representation-probe.mjs <baseline-dist> <candidate-dist>`. Two warmup pairs and ten measured pairs; alternating arms, fresh style hosts and explicit GC; retained heap after pause, not allocated bytes or browser heap. CSS strings at multiple positions and final completion are checked for exact agreement. No calibrated significance or release qualification.

| 1000 targets | Retained bytes baseline | Retained bytes candidate | Startup ms | 120 seeks ms |
|---|---:|---:|---:|---:|
| Two scalar channels | 2887664 | 2364240 | 6.71 -> 6.41 | 76.49 -> 65.49 |
| Five transform channels | 6013680 | 4694456 | 10.19 -> 10.09 | 153.52 -> 163.49 |
| Color | 1863912 | 1597688 | 9.60 -> 5.22 | 64.38 -> 52.76 |
| Authored keyframes | 795808 | 717632 | 3.47 -> 2.70 | 36.48 -> 37.36 |

The memory reduction reproduced in the earlier build (f8a10c08a9f3a33081b7fe76365e46d2a1183dc6a6356792a6b82793ba1f5896, `packed-before-unit-guard.jsonl`); that earlier transform startup was 9.84 -> 11.12 ms. Final results are in `packed-final.jsonl`. Do not select only the favorable timing arm. The vector-only intermediate (`vector-frame.jsonl`, SHA 054b903c6635ad0c372b52b28ccd8ffed06adf76b5c12071d55a612ef725b8eb corresponds to vector plus clock simplification, not the timed vector-only build) is exploratory; 70.5 -> 68 ms on its 1000-target frame case is too small to rank. The final representation is 16085 gzip bytes against unchanged cap 15600, therefore not a release candidate.

Changes: immutable membership vector replaces surface map, phase owns monotonic time, first segment is inline and multi-segment trajectories allocate an optional tail, sampled values and velocities share one buffer. Reject inconsistent units/dimensions at sequence assembly before any DOM writes: the old final-unit interpretation could format earlier segments incorrectly; do not silently treat different authored units as compatible. A separate global monotonic clock experiment was rejected because unrelated new runs must not inherit an old clock clamp. Final local typecheck, 777 motion/value unit tests (Windows package-spawn test excluded), and 18 real Chrome regressions passed. The unchanged size gate remains the blocker; the exact transport/representation needs independent review and cross-browser CI before promotion.
