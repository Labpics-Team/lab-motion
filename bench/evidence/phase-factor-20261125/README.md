# Factor the curve, not only identical programs

Exploratory numerical proof on Windows, Node 24.15.0, i9-12900K. Actual root program/sample from factor-production commit 8b47d832886bda7d736e3e05d67dcdf791e34afe bundled with esbuild. Run from the repository root with locked bench/compare dependencies: `node bench/compare/phase-factor-probe.mjs <factor-production-checkout>`.

1000 distinct scalar start/target pairs, common duration 1000 ms, delay 80 ms, rate .75. 360 seek phases per repetition, including the start, delay boundary and terminal pose. The baseline calls actual sample per binding; the experiment calls the same sampler once for a normalized unit trajectory and applies its progress and derivative in the original arithmetic order to each binding. Every binding at every tested phase agrees within relative tolerance 1e-12; checksums also agree. No persistent cache, no extra public API. Three warmup pairs, 15 measured pairs, alternating ABBA/BAAB, upper medians; raw timings in paired.jsonl.

| Curve | Per-binding sampling | Factored evaluation |
|---|---:|---:|
| linear | 4.5609 ms | 1.1097 ms |
| standard cubic | 57.4935 ms | 1.6662 ms |

This measures only arithmetic plus writing the same mutable numeric arrays, not DOM, rendering, runtime ownership, GC or full frame CPU. It excludes arbitrary user easing and springs whose actual serialized artifacts differ. No A/A run or release qualification. It is not a production implementation; the next design should represent shared phase identity (not memoize unbounded (time, program) tuples), fork on independent control, preserve browser-owned clocks and exact boundary/velocity rules. Stagger is a time translation of the curve only when absolute floating-point representability is preserved.
