# Native seek — Windows, 2026-11-25

Exploratory paired measurement, not a release qualification or competitor ranking.

- Baseline: `b14f9a7d280429fd1faf60492c9c907be0668fc4`, built with the repository's normal build.
- Candidate: the production source in the commit introducing this evidence.
- Windows, Intel i9-12900K, Node 24.15.0, pnpm 11.11.0, installed headless Chrome 158.0.8127.88.
- Baseline `dist/motion/index.js` SHA-256: `8f06c32ed45fb974f25cc583448ba5baa770b8ddbc36a3bef37d97da484f8515`.
- Candidate `dist/motion/index.js` SHA-256: `acb8403936db3a5b476651fe6c7b8c2133c021c758e869b3b852e4e743993869`.
- Run `node bench/evidence/native-seek-20261125/probe.mjs <baseline-dist> <candidate-dist>` after installing dependencies. Pass the same build twice for A/A.
- Two warmup pairs and eight measured pairs per workload, alternating order in ABBA blocks. JSONL contains all per-arm samples. Medians in this diagnostic are the upper middle observation.
- The seek scenario starts two native effects per element, makes 60 interior seeks with a computed-transform check after each seek, finishes, checks all targets' geometry/opacity and effect cleanup. The timer includes creation, commands and final validation. Effects count actual calls to Element.animate.

| Workload | Baseline ms | Candidate ms | Effects before → after |
|---|---:|---:|---:|
| 1 element, 60 seeks | 5.4 | 1.2 | 122 → 2 |
| 100 elements, 60 seeks | 856.5 | 108.6 | 12200 → 200 |

For one element A/A total was 4.8 / 7.1 ms, so the single-target ratio is particularly noisy. The historical keyframes rows contain 1000 DOM nodes but animate only 100; new probe rows include the animated count. For 100 elements the A/A control was 765.9 / 727.2 ms and 12200 effects in both arms. The deterministic effect-count reduction is 61×; the measured elapsed ratio is 7.9× for the 100-element scenario. No generic runtime acceleration is inferred.

Other scenarios are preserved in `final.jsonl` rather than selecting favorable results. Some show adverse/noisy timings (notably start 1000, frames 1000 and keyframes); they are not yet qualified as non-regressions. The probe is not a substitute for the existing calibrated PROFILE/SELECT or browser conformance. No claim about Motion.dev is made.

The existing size gate passed: complete root ESM closure 15598 gzip bytes against the unchanged 15600-byte cap. Root animate consumer 12506 gzip bytes vs baseline 12479; the extra control behavior is not a 10× package-size reduction.

## Follow-up: preserve the existing numeric parser

The speculative root numeric parser shortcut was removed. The rest of the runtime change remains identical. The resulting build (`dist/motion/index.js` SHA-256 `2a78d51e41a645f2294d4a155599d58da795dc027372fc2544472dbfeed56c98`) retains the 15598 B gzip closure and passes the unchanged size gate; consumer cost is 12509 B gzip. `after-parser-revert.jsonl` preserves all eight paired samples. Seek 100: 763.2 → 86.5 ms (8.82×), 12200 → 200 native effects. Seek 1: 5.2 → 1.3 ms. The startup-1000 total and frames-1000 still show adverse measurements (152.9 → 229.4 and 271.8 → 331.5 ms respectively); they prevent a non-regression claim. Keyframe preparation and completion return to parity. An alternate pure phase helper was discarded because its gzip closure exceeded the cap; no threshold changed.

## Integrated factoring and review fixes

Baseline is the independent factoring commit 8b47d832886bda7d736e3e05d67dcdf791e34afe (root ESM SHA-256 72032c02b39d6f8b0b8558f47b6cf7074781954673ad2ae3d1ca8b1d8f3164a6). Candidate is its source merge with 93e05f0a (a4f99620, root ESM SHA-256 49b28bf2f58bf8683cde1b4ef259ce24ebf2a455ffef507ed32384c5fdb25bd1). Root closure 15586 gzip bytes, unchanged size cap PASS. Same Chrome and machine; updated probe performs untimed geometry verification for every seek target before the timed trial. `integrated-factor.jsonl` retains all eight paired observations. The earlier A/A used the earlier probe; no calibrated non-inferiority claim for this integration.

100-target seek: 858.3 → 95.7 ms total, 12200 → 200 effect creations. The 1000-target JS seek scenario: 267.9 → 248 ms. To-only startup 1000: 26 → 18.7 ms API-return, but total 167.2 → 211.4 ms (includes immediate finish and all-target validation). This adverse measurement still needs isolated cleanup/render diagnosis. Keep draft; merge only after independent factoring acceptance and review of the residual regression. Targeted 12 tests, typecheck, and two real Chrome seek regressions (including pending rate and phase) passed.

## Explicit native finish: publish once before cancellation

Candidate root SHA-256: e8501dfde50982a0dc8dd10e6e17ca639855e0cab97d9c051d9d8564295fb117. Full size gate PASS, root closure 15597 gzip bytes / unchanged cap 15600; root animate consumer 12544 bytes. The previous implementation published a temporary sampled pose before cancelling and then the final pose. Explicit finish now publishes only the selected endpoints (with the siblings' synchronized pose) before cancellation, then settles only the channels still owned by the command. Native eligibility uses the already-computed nativeEase invariant instead of repeating its single-segment check. Three regressions cover one write, partial ownership, and adoption during cancel.

`finish-probe.mjs` uses fresh real Chrome pages, two warmup pairs and ten measured pairs, alternating ABBA/BAAB. It independently times creation and finish, counts actual CSSStyleDeclaration.setProperty calls during finish, verifies all final x/opacity values and effect cleanup. Run `node bench/evidence/native-seek-20261125/finish-probe.mjs <baseline-dist> <candidate-dist>`.

| 1000 targets | Startup ms | Finish ms | Total ms | Finish writes |
|---|---:|---:|---:|---:|
| dcf136a8 (root SHA 49b28bf2...fd1), before change | 27.6 | 6.9 | 63.9 | 4000 |
| Candidate, same run | 27.8 | 6.3 | 62.9 | 2000 |
| 8b47d832 factoring (root SHA 72032c02...a6), independent run | 28.4 | 7.0 | 64.4 | 4000 |
| Candidate, independent run | 27.6 | 6.4 | 64.0 | 2000 |

Raw pairs: `finish-once.jsonl` and `finish-vs-factor.jsonl`. The deterministic halving of writes is the result; elapsed differences are diagnostic, not calibrated significance. In the broader single-page probe (`finalization-integrated.jsonl`, vs factoring), 100-target seek was 881.8 -> 94.2 ms total, 12200 -> 200 native effects; 1000-target API return was 19.9 -> 17.2 ms but total was 171.4 -> 200.6 ms. That noisy adverse total is retained, not declared resolved universally by the separate fresh-page experiment. No release-ranking claim. Existing PROFILE/SELECT remains authoritative.
