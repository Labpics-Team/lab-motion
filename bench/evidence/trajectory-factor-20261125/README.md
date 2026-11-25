# Authored trajectory factoring (2026-11-25)

Independent production candidate based on main b14f9a7d280429fd1faf60492c9c907be0668fc4; no dependency on PR #580 or native timeline experiment 41d02058. No new public API or cache. One explicit literal program per property per call when stagger is zero; distinct Track state, variable-resolved values and staggered schedules. Stream points into segments, share implicit zero velocity, derive final point and draft key from the program. Normalized-channel collisions have one validation rule.

Windows i9-12900K, Node 24.15.0, Chrome 158.0.8127.88. Baseline built root SHA256 8f06c32ed45fb974f25cc583448ba5baa770b8ddbc36a3bef37d97da484f8515; candidate 72032c02b39d6f8b0b8558f47b6cf7074781954673ad2ae3d1ca8b1d8f3164a6. Complete root ESM graph 15592 → 15582 gzip bytes, unchanged cap 15600; root animate import 12479 → 12476 B (previous baseline measurement). Size gate PASS.

| Real Chrome workload | Baseline startup ms | Candidate startup ms | A/A startup ms | Baseline → candidate retained JS heap bytes |
|---|---:|---:|---:|---:|
| 1 × 2 frames | 0.2 | 0.2 | 0.2 / 0.2 | 18828 → 8192 |
| 100 × 64 frames | 2.9 | 0.8 | 3.1 / 2.9 | 844784 → 53664 |
| 100 × 960 frames | 15.8 | 1.1 | 16.6 / 16.7 | 12081480 → 140516 |
| 1000 × 8 frames | 6.4 | 4.3 | 6.8 / 6.8 | 1401204 → 403908 |
| 1000 to-only x+opacity | 22.4 | 22.6 | 22.4 / 22.5 | 825868 → 817288 |

Node fake style hosts, 100 × 960: startup 14.1704 → 1.0199 ms, retained 22639616 → 260368 B, A/A startup 14.3223 / 14.7626 ms and retained 22639824 / 22639656 B. These are upper medians of diagnostic paired samples; not generic engine acceleration or total browser memory. Small-case heap deltas are noisy. To-only startup is essentially unchanged; not a formal non-inferiority claim. Browser startup measures animate() return, not first paint. Paused retained JS heap after explicit GC, not allocations, GPU memory or process RSS.

Reproduce: build the immutable base and candidate into separate dist directories. From repository root run `node --expose-gc bench/compare/trajectory-factor-probe.mjs <base-dist> <candidate-dist>`; install locked dependencies in bench/compare then run `node bench/compare/trajectory-factor-browser.mjs <base-dist> <candidate-dist>`. Pass baseline twice for A/A. Node 2 warmup + 8 measured pairs; Chrome 2 warmup + 10 measured pairs, fresh page per arm with an initial warmup run, alternating ABBA/BAAB order. Every target checked at three intermediate times and at finish; all browser effects removed. Raw rows and summaries retained in four JSONL files. No assertion of global leadership, untested mobile performance or native timeline delivery.

Local typecheck, build, unchanged size gate, 765 runtime/value tests plus mixed declaration regression, docs drift passed. Full packed/browser/CI qualification remains the normal acceptance path.
