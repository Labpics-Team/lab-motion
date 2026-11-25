# Direct channel preparation and shared clock snapshots — 2026-11-25

Main baseline b29e214de450ff78292257b8b3bf0f9c8e710c61; measured production source 7c60aacd878296214ac1a9c28471adf7b03b21fd. Both builds used one frozen dependency installation in the same isolated Windows checkout. Source revision, runtime-tree, entry, toolchain and raw-row fingerprints are in receipt.json. The inputs record observed Windows working-tree bytes (mixed LF/CRLF); canonicalGitInputs gives portable exact Git-blob hashes for the pinned revision. The baseline root hash also matches the accepted #581 build. Complete root ESM closure 15582 -> 15595 gzip bytes, unchanged 15600-byte cap; Brotli 13996 -> 13977. Full size gate passed.

A prepared channel becomes the live Track in place, with the current registered Surface winning over a retired prepared Surface. Unpublished non-transform surfaces need not be recreated. Allocation of Surface is pure; preparation, publication and each successful update frame obtain a single clock snapshot. Each native effect still supplies its own currentTime. Failed clock/sample reads follow the existing per-surface failure path. No extra scheduler, public API, or global cache.

Fresh Chrome 158.0.8127.88 pages on Windows, Node 24.15.0. Two warmup and ten measured paired observations per workload, alternating arms. The startup probe measures the synchronous animate return and counts actual performance.now / getComputedStyle calls; an initial warmup is excluded. It checks intermediate and final geometry for exact equivalence across artifacts, verifies finished status and absence of leaked native effects. Independent expected-pose correctness is covered by the existing conformance suite, not by this equivalence probe. A/A runs use the same baseline artifact in both arms.

| Startup workload | Base ms | New ms | A/A ms | Clock reads before -> after |
|---|---:|---:|---:|---:|
| Native 1 | 0.2 | 0.2 | 0.2 / 0.2 | 6 -> 2 |
| Native 100 | 3.0 | 3.2 | 3.0 / 3.0 | 600 -> 2 |
| Native 1000 | 22.2 | 21.3 | 23.3 / 23.2 | 6000 -> 2 |
| Width/height 1000 | 8.7 | 6.8 | 9.0 / 8.7 | 8000 -> 2 |
| Native + width/height 1000 | 32.8 | 30.6 | 34.3 / 34.5 | 14000 -> 2 |
| Authored width/height 1000 | 6.3 | 4.6 | 6.5 / 6.4 | 8000 -> 2 |

The mixed workload's isolated finish was adverse (5.3 -> 6.1 ms, A/A 5.6 / 5.6). No universal non-regression or competitor leadership claim. The frame probe manually invokes captured requestAnimationFrame callbacks synchronously using virtual timestamps and actual DOM. The measured wall-clock interval covers those callback computations and CSS writes, not the browser frame scheduler, presentation latency or FPS. It checks intermediate geometry for equivalence and final geometry against expected endpoints.

| 120 virtual frames | Base ms | New ms | A/A ms | Clock reads before -> after |
|---|---:|---:|---:|---:|
| 100 elements, 2 properties | 18.7 | 14.4 | 16.7 / 16.8 | 24000 -> 120 |
| 1000 elements, 2 properties | 130.6 | 104.0 | 131.3 / 132.6 | 240000 -> 120 |

Reproduce with clean checkouts at the revisions in receipt.json, using frozen root dependencies and the same toolchain; build both and run from a checkout containing the probes:
`node bench/compare/direct-preparation-probe.mjs <base-dist> <new-dist>`
`node bench/compare/direct-frame-probe.mjs <base-dist> <new-dist>`
For A/A pass the same baseline dist twice. All expected arms, workloads, rounds and upper medians were validated before publishing the four raw files. Diagnostic measurements are not calibrated PROFILE/SELECT or packed-consumer release qualification.

Local typecheck, full size gate, docs drift and 771 targeted motion/value tests passed (Windows package-spawn test excluded; canonical package test belongs to CI). New tests pin identity of accepted prepared bindings, registry rebinding after intervening adoption, synchronized startup timestamps, one successful read per frame, and failure isolation.
