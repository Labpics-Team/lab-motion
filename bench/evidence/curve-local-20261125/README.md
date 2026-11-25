# Normalized curve-local phase evaluator — 2026-11-25

Exploratory implementation, not release-qualified. Baseline source 37a1e2c9e3a6ee7e87768422d018a4355671c815 (updated #582 including merged #580); root ESM SHA256 7133d2bcde7340a9bba6237a21fb0df1268fd5e6be93feff67027878c23b2aa1. Candidate source f669125e1397439ea0824aff1d15472862d3709f; root ESM SHA256 7b35501bf20c9dab552fe7d2723553145c92c16664d765148fd324831a1a620d. Root closure 15598 -> 15659 gzip bytes (unchanged cap 15600, exceeds by 59 B), Brotli 14008 -> 14070. No size waiver.

A normalized curve contains its CSS identity (or the original effectful user function identity) and its evaluator. Pure CSS easing stores two exact normalized samples local to the curve: input, output, finite-difference numerator and width. The second slot covers alternating old/new phases of seek; rates and durations are applied per binding in the original arithmetic order. User callbacks always execute high, low, current input; no mutation of user functions, no global target/program registry, no allocations on phase lookup. The default implicit spring is identified by the internal default object; explicit springs retain distinct configuration. The same endpoint selection path handles terminal time and ordinary segment endpoints. The unshared original user function remains the same-goal identity.

| Workload, 1000 targets x 2 channels | Before ms | After ms |
|---|---:|---:|
| Node, 120 seeks, linear | 81.8871 | 76.5463 |
| Node, 120 seeks, standard | 177.7881 | 99.2171 |
| Node, 120 seeks, standard stagger | 237.7100 | 173.8237 |
| Node, 120 seeks, custom | 116.3324 | 113.9457 |
| Chrome, 120 seeks, standard | 230.6 | 159.8 |
| Chrome, 120 virtual frames, standard | 103.1 | 68.5 |

Node 24.15.0 fake style hosts; Chrome 158.0.8127.88 real DOM; two warmups and ten paired measured observations per workload, alternating arms, upper medians. Raw rows in node.jsonl, seek-browser.jsonl, frame-browser.jsonl. CSS strings/checksums and custom callback counts compared exactly (1,446,000 calls per arm for custom). Browser compares intermediate poses across artifacts, checks expected final endpoints and cleanup. Frame probe manually drives captured rAF callbacks with virtual timestamps, measuring synchronous computation and writes, not actual browser frame delivery or FPS. No fresh A/A control for this particular pair, no calibrated non-regression or leadership claim.

Reproduce from built checkouts at these revisions using node bench/compare/phase-runtime-probe.mjs <base-dist> <new-dist>, node bench/compare/phase-browser-probe.mjs <base-dist> <new-dist>, node bench/compare/direct-frame-probe.mjs <base-dist> <new-dist>. Targeted typecheck and 786 motion/value/token-isolation tests passed (Windows package spawn test excluded). New curve tests compare the exact value and velocity against direct cubic solver calls at multiple phases, rates and durations; check two-slot identity and effectful call order including nested evaluation and frozen user functions.

Earlier #582 integration result is retained in preparation-integrated-frame.jsonl: #580 main 5b92195567f44a9ebc2cf8d5081821b274ab936d (root ESM SHA256 e8501dfde50982a0dc8dd10e6e17ca639855e0cab97d9c051d9d8564295fb117) vs 37a1e2c9, 129.5 -> 102.8 ms for 1000x2 channels / 120 virtual frames, clock reads 240000 -> 120, startup 8000 -> 2. Historical #582 receipts remain associated with their own exact measured revisions.

Next: remove redundant data/paths in the normalized motion plan instead of raising the cap or weakening exactness. Validate the final curve representation independently and preserve mutation isolation of defaults. Design references: https://www.w3.org/TR/web-animations-1/#timing-model and https://guillaumeblanc.github.io/ozz-animation/documentation/animation_runtime/.
