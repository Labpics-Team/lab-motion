# Publication-scoped native instruction sharing — 2026-11-25

Status: experimental, not production-qualified. No size limit changed. Final measured source 1aa0d516b16fb075667b7db5d4f61794162da036; comparison base 66045c7e86e9f4f235f2d6cb7a14ef82f523f25f (#586); earlier pure-template source 9b9d7036afddcf79c5968646bdd394b2588529ca. Receipt binds the artifacts by entry hash and stores measured rows, medians and metadata. Final benchmark harness is 3854cf0e8b3e895f54ccda7908147e01a295cbf7; pure diagnostics used its earlier probe revisions. Chrome 158 / Node 24.15.0. These are diagnostic comparisons, not the calibrated PROFILE/SELECT qualification.

## Architecture

A shared Program and its continuous native projection are materialized once per compatible shape within a publication. Same-program/pose matching avoids projection. Otherwise canonical frames are compared, with delay belonging to the instance rather than the shape. Only a repeated shape creates a detached KeyframeEffect template. A unique shape uses the existing native start. Clones receive their own target, document timeline, delay and Animation. No global template cache or cross-document sharing. Nonstandard hosts retain their original path. See https://www.w3.org/TR/web-animations-1/#the-keyframeeffect-interface.

## Final measured artifact

Median milliseconds, real browser. Task = main-thread CDP TaskDuration from API invocation through natural completion. API = synchronous return interval; Motion can defer effect creation beyond return, so this is not equivalent to readiness. Completion and cleanup checks are retained in the receipt. Eight measured rotations per scenario.

| Scenario | Lab base task | Lab final task | Motion.dev 14.5 task | Raw WAAPI task | Lab base API | Lab final API | Motion API |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cold 1000 | 85.556 | 80.613 | 101.859 | 71.963 | 20.7 | 13.9 | 6.6 |
| Warm 1000 | 74.992 | 74.730 | 85.517 | 67.857 | 14.0 | 8.9 | 2.3 |
| Stagger 200 | 145.347 | 141.964 | 147.894 | 121.123 | 6.3 | 7.1 | 2.8 |
| 4 frames × 500 | 247.120 | 44.428 | 69.516 | 39.339 | 5.2 | 9.4 | 8.8 |
| 129 frames × 100 | 84.201 | 31.432 | 81.219 | 46.625 | 3.3 | 8.4 | 6.7 |

One template + 999 clones for 1000 equal instructions; one template + 199 clones for stagger 200. Native timeline cases use no library rAF. Dense timeline Lab CPU is 2.58x lower than Motion in this run. Completion is later (529.3 vs 517.7 ms dense; 623.5 vs 608.2 ms four-frame), so this is not a claim of universally faster animation. Earlier pure-template diagnostic (44.094 vs 69.958 task and 8.1 vs 8.3 API on 500 four-frame targets) is not the final artifact result. Final artifact's stagger API regression is retained rather than hidden.

Independent raw-platform experiment: cloning 1000 two-frame effects reduces API 7.7 to 2.4 ms; 100 effects with 128 frames, 23.6 to 4.5 ms. This identifies the browser mechanism, not a library result.

## Correctness and decision

799 focused tests passed in the placement variant; final source adds a CSS availability guard and browser tests. 29 Chrome checks passed on final source, including real effect independence, stagger delays and seeks, heterogeneous static pose, retarget ownership and iframe/document timeline isolation. Endpoint and intermediate geometry validated against independent piecewise-linear oracles; no remaining effects. The alternative vector transform representation increased gzip from 16112 to 16163 bytes and was discarded without a performance claim.

Final gzip closure 16113 bytes versus 15600 allowed (+513); Brotli 14470. The consumer root animate bundle 13049 gzip meets its separate limit; full size gate fails. Ordinary API startup still loses to Motion and stagger API regresses versus Lab base. Do not merge or claim production leadership from this evidence. Next architecture boundary: represent geometry and placement independently in Program, removing serialized frame comparison rather than adding a new cache or relaxing the size budget. Then qualify on the existing full benchmark and conformance suite.
