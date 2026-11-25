# Shared curve coefficients in the real runtime — exploratory

Base 8b47d832886bda7d736e3e05d67dcdf791e34afe (PR #581); candidate is the program.ts change introducing this evidence. Windows i9-12900K, Node 24.15.0, Chrome 158.0.8127.88. Root ESM SHA-256 base 72032c02b39d6f8b0b8558f47b6cf7074781954673ad2ae3d1ca8b1d8f3164a6; candidate 7533523ccf58c7ec772c6e244092f5b6059e7bee3a93864410823cb7164d471e.

Two exact coefficient registers reuse a pure CSS curve's eased progress and finite-difference numerator/width at identical normalized phases. This is bounded scratch, not a new clock or per-target cache. The derivative division and application of each binding's rate/extent retain their original arithmetic order. Arbitrary user functions bypass it; nested sampling and varying durations are covered by new unit tests. No native effect, ownership or scheduling changes.

| Workload, 120 seeks | Base ms | Candidate ms |
|---|---:|---:|
| Node 1000 targets / 2000 channels, standard | 167.6411 | 80.5706 |
| Node 1000 targets, linear | 80.1455 | 78.4740 |
| Node 1000 targets, staggered standard | 239.5550 | 193.4192 |
| Node 1000 targets, custom | 94.8346 | 90.8743 |
| Chrome 100 targets, standard | 27.4 | 22.1 |
| Chrome 1000 targets, standard | 231 | 164.4 |

Run from repository root: `node bench/compare/phase-runtime-probe.mjs <base-dist> <candidate-dist>` and `node bench/compare/phase-browser-probe.mjs <base-dist> <candidate-dist>`. Two warmup and ten measured pairs per case, alternating ABBA/BAAB, upper medians. Node fake style hosts exercise actual built animate/pause/seek/finish, compare exact style outputs and checksums; custom callback count exactly 1446000 per arm. Chrome uses actual DOM widths/heights with diverse origins, compares geometry at three phases outside timed interval, exact CSS strings/checksum, and all final geometry and cleanup. The timed interval covers synchronous commands and style writes, not displayed frame throughput or full renderer lifetime. No A/A control for this diagnostic, no formal non-regression claim.

518 targeted unit tests (including two new exactness/reentrancy tests) and typecheck passed. Candidate root closure 15728 gzip bytes vs unchanged cap 15600; not eligible for merge. A separate compact scratch experiment (15677 bytes) was discarded: observed custom-easing slowdown (123.3 to 154.1 ms), despite identical callback count. Its diagnostic rows are retained as a negative result, not a production artifact; root SHA256 2187dbf9f95adad5cb6c3639fa98ff359f23622400acccc148e1d7b047e8337d.

Next: the major remaining cost is whole-runtime control/write work, not cubic arithmetic. A shared frame phase with one sample per mathematically equal cohort, independent per-binding ownership and divergence at control boundaries should replace repeated work without a broad new cache. Preserve native clocks, user callback semantics, and existing numerical invariants. See Web Animations timing model https://www.w3.org/TR/web-animations-1/#timing-model.
