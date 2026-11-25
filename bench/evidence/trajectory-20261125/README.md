# Factorized trajectory and native timeline — exploratory evidence

2026-11-25, Windows Intel i9-12900K, Node 24.15.0, installed Chrome 158.0.8127.88; Motion 14.5.0 via the existing locked comparison workspace. Base: 9767b1402d0e0393e334870a59be00b205b5d57b (PR #580). This is an experiment, not a release or a global performance ranking.

## Representation

An authored literal declaration without stagger has one immutable Program per property per call. Tracks retain independent values, clocks and ownership. Variable-resolved and staggered trajectories retain target-specific preparation. Sequence assembly copies the segment container before extending it. Native capability is derived from actual segment easing, continuity and compatible surface timing; no stored native-ease flag. Multi-segment native projection includes gaps and terminal holds; unsupported or discontinuous programs use the numerical path.

## Measurements

- `native.jsonl`: projection-only build; `full.jsonl`: projection + factoring; `factor.jsonl`: full build, Node headless fake style hosts.
- Base root ESM SHA-256 `2a78d51e41a645f2294d4a155599d58da795dc027372fc2544472dbfeed56c98`; projection-only `f5b497101fa2fabb2f7a69ebc3a03d3ce363aec11d338a1708711a5013509f60`; full `53209cc5ed964c68c062dade11c56ee715758ea115b74360ac8beb577893a21a`.
- Reproduce from repository root with `node bench/compare/trajectory-probe.mjs <base-dist> <candidate-dist>` (install locked bench/compare packages) and `node --expose-gc bench/compare/trajectory-factor-probe.mjs <base-dist> <candidate-dist>`.
- Browser: 1 warmup and 4 measured rotations, fresh pages, 600 ms nominal duration, 4 x-keyframes and explicit offsets. All target geometry checked at six times in a separate trial and at natural completion; zero remaining effects required. CDP TaskDuration covers the full renderer interval including creation and final validation; not frame CPU time, GPU, or energy. The comparator may defer startup (initial effects counts are not a lifetime count).
- Node: 2 warmup and 8 ABBA/BAAB pairs, fake style targets, forced GC before and after start+pause, all target geometry checked after seeks and finish. Memory is observed heap delta, not allocation count or a browser footprint. Values are upper medians.

| Node workload | Base start ms | Full start ms | Base retained bytes | Full retained bytes |
|---|---:|---:|---:|---:|
| 100 × 64 keyframes | 2.3697 | 0.4996 | 1603752 | 106128 |
| 100 × 960 keyframes | 11.1745 | 0.8656 | 22638640 | 314144 |
| 1000 × 8 keyframes | 5.6376 | 2.8095 | 2787984 | 848288 |

| Chrome task duration (ms) | Base | Full | Motion | Raw WAAPI |
|---|---:|---:|---:|---:|
| 100 targets | 91.662 | 15.764 | 19.768 | 14.218 |
| 500 targets | 261.689 | 86.481 | 65.236 | 76.145 |

The full candidate eliminates library rAF reservations for this native workload (146/145 to zero). Startup becomes more expensive: 1.2→2.7 ms (100) and 4.4→12.9 ms (500). At 500 the candidate loses to Motion in TaskDuration and has a longer completion interval. Raw WAAPI itself is not free. No universal gain or non-inferiority established. The 519 targeted runtime tests and 19 Chrome browser checks passed. Full root gzip closure 15781 B exceeds unchanged cap 15600 B, so this exact variant is not ready for merge. Projection-only closure 15753 B. No cap changed.
