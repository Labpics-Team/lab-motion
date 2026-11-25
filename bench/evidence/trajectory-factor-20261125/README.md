# Authored trajectory factoring (2026-11-25)

Production-source commit 8b47d832886bda7d736e3e05d67dcdf791e34afe, based on main b14f9a7d280429fd1faf60492c9c907be0668fc4; no dependency on PR #580 or native timeline experiment 41d02058. No new public API or cache. One explicit literal program per property per call when stagger is zero; distinct Track state, variable-resolved values and staggered schedules. Stream points into segments, share implicit zero velocity, derive final point and draft key from the program. Normalized-channel collisions have one validation rule.

Windows i9-12900K, Node 24.15.0, Chrome 158.0.8127.88. Baseline built root SHA256 8f06c32ed45fb974f25cc583448ba5baa770b8ddbc36a3bef37d97da484f8515; candidate 72032c02b39d6f8b0b8558f47b6cf7074781954673ad2ae3d1ca8b1d8f3164a6. Complete root ESM graph 15592 → 15582 gzip bytes, unchanged cap 15600; root animate import 12479 → 12476 B (previous baseline measurement). Size gate PASS.

| Real Chrome workload | Baseline startup ms | Candidate startup ms | A/A startup ms | Baseline → candidate retained JS heap bytes |
|---|---:|---:|---:|---:|
| 1 × 2 frames | 0.2 | 0.2 | 0.2 / 0.2 | 18816 → 8192 |
| 100 × 64 frames | 2.8 | 0.8 | 3.0 / 3.0 | 844784 → 53664 |
| 100 × 960 frames | 15.7 | 1.0 | 15.6 / 15.4 | 12081572 → 140516 |
| 1000 × 8 frames | 6.4 | 4.2 | 6.5 / 6.4 | 1400860 → 404412 |
| 1000 to-only x+opacity | 22.2 | 22.0 | 22.9 / 22.9 | 825840 → 817228 |

Node fake style hosts, 100 × 960: startup 11.4157 → 0.7538 ms, retained 22639128 → 260408 B, A/A startup 11.2343 / 11.2744 ms and retained 22637920 / 22639416 B. These are upper medians of diagnostic paired samples; not generic engine acceleration or total browser memory. Small-case heap deltas are noisy. To-only startup is essentially unchanged; not a formal non-inferiority claim. Browser startup measures animate() return, not first paint. Paused retained JS heap after explicit GC, not allocations, GPU memory or process RSS.

Reproduce from a checkout containing the probe scripts, with locked benchmark dependencies installed: `node bench/compare/trajectory-factor-run.mjs <clean-base-checkout> <clean-candidate-checkout> <output-dir>`. Both source checkouts require locked root dependencies. The runner uses the existing provenance implementation to rebuild and fingerprint clean revisions, actual runtime trees and toolchain, verifies the unchanged size gate, runs all four paired probes, and revalidates checkout/byte hashes before writing rows and `receipt.json`. Use the recorded revisions in that receipt, not arbitrary dist directories. Size outputs are included with their hashes. Node 2 warmup + 8 measured pairs; Chrome 2 warmup + 10 measured pairs, fresh page per arm with an initial warmup run, alternating ABBA/BAAB order. Every target checked at three intermediate times and at finish, including both translation and opacity in the mixed case; all browser effects removed. These are the receipt-bound follow-up observations. The earlier exploratory rows remain in commit 8b47d832 for historical comparison. No global leadership, untested mobile performance or native timeline delivery claimed.

Local typecheck, build, unchanged size gate, 765 runtime/value tests plus mixed declaration regression, docs drift passed. Full packed/browser/CI qualification remains the normal acceptance path.
