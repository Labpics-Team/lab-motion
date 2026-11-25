# Demand-driven terminal spring projection — 2026-11-25

Baseline main 381fb2614130270aae8fdae43d555c78721664c7 (#584), source-identical to built bfca17c4. Final measured source 1ac32d100531e256f3a486c9c3f14afd7808fe82; prior measured source 858b7f949a5f0b06a3fd08e766387648f40ac9ca. Exact root hashes, raw-file SHA256 and row counts in receipt.json. Every observation binds to root and full runtime-tree hashes, checked before and after measurement. Root closure 15567 -> 15598 B gzip, unchanged 15600 cap; complete size gate passed.

A terminal-only spring uses the same canonical horizon and grid-feasibility preflight without constructing the sample grid, RDP nodes or CSS artifact. All range, unit, duration and overlap validation stays. Ordinary animation, per-step reduced flags in a mixed sequence and retargets still materialize their exact trajectory when needed. Sequence captures one system preference for the operation; it never produces a partially materialized globally reduced sequence. Reduced layout commits once without compiling its spring. Public duration remains zero for reduced playback.

Real Chrome 158.0.8127.88, Windows, Node 24.15.0. Fresh page for each arm; distinct initial CSS widths, common target, same physics. Cold cache; two warmups, ten measured pairs alternating arms; upper medians for synchronous animate/sequence return. Reduced paths must already be finished, duration zero, exact final inline CSS, no remaining effects. Normal paths compare duration, sampled intermediate poses and final values across artifacts (not an independent intermediate correctness oracle). A/A uses the same accepted baseline bytes twice. The measured metric is startup/terminal application, not animation FPS or presentation latency.

| Workload | Baseline ms | Final ms | A/A ms |
|---|---:|---:|---:|
| Reduced, 100 targets | 35.3 | 2.8 | 34.7 / 35.3 |
| Reduced, 1000 targets | 223.8 | 8.9 | 224.5 / 225.4 |
| System reduced, 1000 targets | 224.8 | 8.9 | 224.0 / 223.3 |
| Reduced sequence, 200 targets x 2 steps | 62.0 | 4.9 | 60.2 / 61.5 |
| System reduced sequence, 200 targets x 2 steps | 63.0 | 4.9 | 60.9 / 61.2 |
| Normal, 100 targets | 35.1 | 34.7 | 35.2 / 34.9 |
| Normal, 1000 targets | 224.7 | 225.5 | 223.7 / 224.9 |

The earlier measured build showed 224.9 -> 8.9 ms for reduced 1000 (25.3x) and 225.3 -> 224.7 ms for normal 1000; initial-ab.jsonl retains those observations; initial-aa.jsonl is the corresponding same-artifact control. The final build extends the same optimization to system-reduced sequences and repeats the full matrix. Normal cold compile is not accelerated; its small differences fall within observed A/A variation. No general non-regression or competitor leadership claim.

Typecheck, 1129 motion/value/compositor tests and docs drift passed. New tests compare exact horizon for 36 physical/input combinations, no grid requests in reduced paths, mixed-step playback, overflow/overlap rejection, system preference snapshot and reduced layout mutation. Windows package spawn test excluded as usual; canonical package verification remains CI's responsibility.

Reproduce from the final measured checkout (the baseline predates this probe) with clean built artifacts at the revisions in receipt.json, using `node bench/compare/demand-spring-probe.mjs <baseline-dist> <candidate-dist>`; repeat baseline twice for A/A. Initial six-case probe belongs to the initial measured revision. Accessibility rationale: https://www.w3.org/WAI/WCAG22/Techniques/client-side-script/SCR40 and https://motion.dev/docs/react-use-reduced-motion.
