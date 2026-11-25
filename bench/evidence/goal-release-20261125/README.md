# Accepted trajectory demand — 2026-11-25

The earlier experiment is retained separately on perf/goal-demand-20261125. This release build is 387ca2ec594cc3a02e44a17de2866aa359c25255; baseline f2b9eb3bd4a6b96149dc840a510d99ab6dc58b9c (#585). Both were rebuilt with the locked installed toolchain. Root SHA-256 and full runtime-tree fingerprints, exact measured source and harness revisions, canonical file-content SHA-256, observed checkout bytes and installed toolchain fingerprints are in receipt.json. No stale artifact substitution.

The canonical horizon is validated before acceptance, cache hits reuse ready artifacts and misses return a numerical request. Only accepted playable segments materialize stops before publication. Endpoint-only projection does not materialize. Native eligibility is derived, not stored; reduced transient tracks cannot be adopted by a reentrant normal request. RDP uses the guaranteed protected spring frontier, so small-grid and arbitrary protected-index handling stays with the diagnostic adapter. Exact canonical CSS/wire output is preserved.

Chrome 158.0.8127.88, Windows, Node v24.15.0. Fresh real DOM pages, two warmups and ten measured pairs alternating arms; upper medians. The controlled clock preserves the exact moving phase while wall-clock startup is measured. This is synchronous animate return, not FPS or first paint. Paused controls measure zero velocity; moving cases are at 12.5% duration. Changed goals, repeated goals, intermediate poses, state, duration and cleanup are compared exactly between artifacts. A/A uses the same baseline bytes, same harness inputs and environment, taken immediately before the terminal-adoption correctness fix; the final A/B is separately repeated.

| Workload / targets | Before ms | After ms | Same-artifact A/A ms |
|---|---:|---:|---:|
| spring-repeat / 100 | 0.5 | 0.5 | 0.6 / 0.6 |
| spring-repeat / 1000 | 2.0 | 1.9 | 2.1 / 2.1 |
| spring-change / 100 | 7.4 | 7.6 | 7.7 / 7.6 |
| spring-change / 1000 | 63.2 | 64.9 | 65.8 / 64.8 |
| linear-repeat / 1000 | 1.7 | 1.7 | 1.9 / 1.9 |
| moving-repeat / 100 | 15.0 | 0.5 | 15.9 / 16.1 |
| moving-repeat / 1000 | 113.3 | 2.2 | 116.2 / 114.9 |
| moving-change / 1000 | 128.2 | 130.3 | 131.6 / 133.4 |

Cold compiler: 160 distinct curves, 3 warmups, 12 paired observations; 7.0951 -> 7.0271 ms, exact CSS string equality, 7083 median stops. Small timing differences are not a speedup claim. Compiler observations carry the same exact runtime-tree fingerprints as the respective browser measurements. Root closure 15598 -> 15582 B gzip (limit 15600), Brotli 13996 -> 13967. Full size gate, typecheck, 1145 targeted tests, 18 Chrome scenarios passed. Windows package-spawn test excluded; package CI remains required. No general claim of non-regression or competitor leadership.

Reproduce from the measured candidate checkout, with freshly built clean baseline and candidate checkouts, using `node bench/compare/goal-demand-probe.mjs <baseline-dist> <candidate-dist>`; repeat the baseline twice for A/A. For cold curves use `node bench/compare/spring-compiler-probe.mjs <baseline-dist> <candidate-dist> exact`. Each raw file is hashed in receipt.json; the initial A/B before the terminal-track fix remains historical. Reference: https://www.w3.org/TR/web-animations-1/#timing-model.
