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
