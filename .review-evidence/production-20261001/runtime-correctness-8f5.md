# Независимая program correctness проверка: PASS в указанной оси

Subject: `/workspace/lab-motion/scratchpad/runtime-upstream-final-cut-20261001T124549Z`, readset `8f5b59054b7bf088f8f312e0d9e1645a2c6579ed8a78ef28f1120b552c4c24f6`. Подтверждённых нерешённых blockers по runtime correctness, public package, lifecycle, wire law и literal compositor recipes не обнаружено. Этот PASS не закрывает полный ordinary/global production GO: в current ordinary raw остаётся один 30s method test failure, отдельно от рассматриваемой оси.

Исходная цель пользователя — полностью довести lab-motion по agents-config до production quality. Серверный аналог авторизован вместо недоступных телефонов; это не отменяет numerical/semantic/lifecycle/caps обязательства и не предоставляет mobile/FPS/energy/field доказательства. Reviewer не автор изменений; author HANDOFF/reasoning и чужие reviewer verdicts не читались. Выполнена только одна correctness ось, без делегирования и product/source edits.

## Exact identity, норма и scope

935 readset entries проверены по SHA-256 и длине, файловый набор exact, extras отсутствуют. В рассматриваемой оси 925 runtime/verification/dist entries; 10 method-context-only взяты из committed `30e73995002422376ec763d2026cbdee19a34f42` и исключены из verdict. Все 308 primary files проверены независимо. Compact JSON SHA-256 runtime rows самостоятельно пересчитан: `f04ad03aeaf49d4dd6cea882f1e56fec90502c1ed2c6b525aa6e923c2e7ffb78`. Тем же кодированием пересчитан собственный previous0253 fingerprint `295162a139dfacda25a9ffaf5501bfdf1c602c1fef348197e18302dc0a03272d`.

| Вход | SHA-256 |
| --- | --- |
| source-readset.json | `8f5b59054b7bf088f8f312e0d9e1645a2c6579ed8a78ef28f1120b552c4c24f6` |
| runtime-base.diff | `03f7507530b338f55f2403daed1eac2b0041b5bfce210fa7ad813c408b588d64` |
| source-build-byte-proof.json | `a930133462b96442f0a6aff46dfa2fa22e27bd395d57e47719a591f893d9fb34` |
| primary-evidence-manifest.json | `a783473b106a206152b1e7c082e6e29225d6be172ad959101898af92bd6bee61` |
| pnpm actual-package.tgz | `46c9067832760159d35ccd2166b28e6486a57602b1e96d6d23e1c4c06804a402` |
| actual npm browser tar | `364f9ff8b505191965040eb17059a034e2cb39be5dd0b1468855ca7e9c61c524` |
| actual-package browser bundle | `0cf981af25f70cad91450d763a40723f2fcd7c7d00b6df6838d8afe107415e8d` |
| packed recipes.md | `53e241c1aa75f842c173051fd0d8e90da39dc19813867802d33f5c6b513b3fa5` |
| current dependency lock | `0389cfa8ad9586f8cafccfb831acc29c89a3bc7ea00c409cce8634b5727f1740` |

Оба tar имеют ровно 312 уникальных members, включая все 304 dist. Npm members полностью byte-equal frozen source readset; pnpm отличается только удалением `packageManager` из package.json. Собственный consumer физически извлечён из текущего actual npm tar, без product workspace alias. Optional peers разрешены к current supplied realpaths, включая React 19.3.0; lock проверен. Source proof содержит 117 source и 304 dist records, все bytes совпали; source/dist fingerprints пересчитаны самостоятельно. Текущий build и size receipts имеют terminal 0 и связаны exact hashes. Dist fingerprint остался `9c12239053f7833716b4cd0bb8960f1d794bad14ddd5d282e9adc5555a9a5b76`.

Норма прочитана/сверена из `primary/norm`: AGENTS, SPEC, ACTIVE, ACTIVATION, CLAIM, original activation r11 и current r11. Шесть current файлов agents-config byte-equal frozen norm. ACTIVE authoritative r11. Original r11 SHA `fd0529ff43365afc3bc6f34ae2be51aca1e18a2dad26d6fb2a640124aeba8306`; current SHA `cbeef108b288502165437c375bb259f3f4d6dc8ae4ae9e926db133adeba40d4b`. Activation→current полный diff меняет только Status/Exit evidence существующих строк §5, разрешённые SPEC 47–58. AGENTS SHA `0e1376312cedf91660b1c919ba4c1a9a6e067fe8719eb8daeb52113508b28f0a`; SPEC SHA `7488d5885ee2405d678e488e34a84ce48254978c3a6ad3de2e4d31dfe7b3f651`. Применены qa/verify, независимость AGENTS, G-CONTRACT/G-COMPOSE и сохранённые numerical/package/lifecycle/caps контракты r11. Draft r12 не использован как норма/permission.

## Самостоятельная delta проверка

От собственных previous0253 bytes изменились четыре in-axis файла:

- package.json/pnpm-lock: dev React, react-dom и @types/react заменены с 18 на 19.3.0; exports, peer ranges, engines и public API unchanged.
- test/motion-value.test.ts: реальный первый асинхронный timer tick проверяется отдельно; полный исходный интервал 3000ms fallback теперь исполняется fake timers с проверкой settlement и отсутствия pending timers. `finally` уничтожает owner и гарантированно восстанавливает real timers. Это semantic sequence proof, не wall-clock completion/performance proof.
- test/profile-measurement.test.ts: изменён только комментарий, исполнение прежнее. Method/statistics/cost source этой проверкой не рассматриваются.

Все `src/**`, 304 dist, literal recipes, actual-package browser producer, resource fixture, wire encoder/parser и production caps byte-equal previous0253. Сохраняются Node ≥22, ES2022/WeakRef browser, все 44 exports, 9 binding source areas, один analytic solver/state owner, без нового behavior façade API. Пять других изменённых method-context files не использованы для correctness выводов.

11 собственных actual-package probes свежо выполнены на Node24.19.0 с current peers, все PASS: 44 ESM/CJS runtime surfaces и declaration targets; stale frame после stop/restart/destroy; `throw undefined` при healthy sibling/progress; live/native/serialized/live transfer с независимым CSS piecewise-linear oracle и различными native/JS clocks; successor rejection и healthy retry; nested animate intent/stale cancellation; zero-span/RAF/reduced controls; nested behavior intent; late callback getters/terminal guards/original receiver. Это light custom semantic probes, не full test suite.

Отдельный прямой consumer исполнился exact `/workspace/lab-motion/scratchpad/node-floor/node-v22.0.0-linux-x64/bin/node`, runtime `v22.0.0`, без child spawning. 36 public entries без optional peers прошли прямой ESM/CJS parity; spring value совпал с независимой underdamped closed-form формулой; handle=0 сохранил синхронно только initial value, затем реальный timer дал progress. Nested destroy в delivery сделал owner terminal; последующий intent/host turn не дали stale writes. Полная compatibility всех восьми optional peers на этом floor из проверки не выводится. Первое исполнение собственного floor harness ошибочно вызывало несуществующий `MotionValue.start`; сохранены incomplete harness/error note, затем исправлен только harness и проверка прошла. Это не продуктовый finding.

## Свежий actual-package React19 browser witness

После явно согласованного свободного окна выполнены два собственных Chromium153.0.8010.12 consumers на frozen bundle `0cf981…` / npm tar `364f9ff8…`: client StrictMode и SSR→hydration StrictMode. Оба PASS. Setup/cleanup/setup создали четыре реальные native effects, осталось два healthy active effects. Предыдущий setup корректно освобождён. Active click создал ещё два effects и сохранил два текущих; sibling `.motion-target` вне root получил ноль. Hydration сохранила конкретный server DOM node. Cleanup оставил ноль effects и отсоединил target; retained late detached click не создаёт новых effects. Console/pageerrors отсутствуют.

Oracle — прямые retained DOM/native Animation identities/counts и различение healthy active click/terminal stale click; production helper/fixture oracle не переиспользован. Actual package producer unchanged: literals берутся из packed cookbook, consumer boundary исключает source self-reference, motion inputs — установленный dist. Tar/cookbook/manifest/bundle/SSR HTML hashes независимо сопоставлены. Browser/pages/local server закрыты; explicit executor END отправлен до дальнейших чужих heavy checks. Full browser/build/pack/Vitest/mutation/timing reviewer не запускал.

## Own-chain closure и floor qualification

Собственные B1/B2/B2a/B2b остаются закрытыми в этой оси. Runtime guards и focus recipes имеют прежние проверенные bytes. Previous0253 source/model/real Chromium proofs применимы к conserved bytes: 32 current focus cases, previous RED controls, real parent-open/same-closed/parent-closed controls. Текущая primary three-engine matrix дополнительно содержит все 60 focus outcomes PASS, включая доступные parent/ancestor closed owners. Shared wire law/source bytes unchanged; применимы собственные прежние hand-written binary controls (empty/ASCII/surrogate-pair 65535 UTF-16 units принимаются, 65536/aggregate excess ранне отклоняются). Новый wire/focus execution здесь не заявляется; прежний verdict автоматически не перенесён, conservation и затронутые package/React/timer/floor свойства проверены заново.

**Уточнение прежней floor premise, добавленное без переписывания истории.** `pack-smoke.mjs` запускает ESM/CJS/shared-frame consumers через bare `node …` и наследует PATH. Поэтому прежние receipts с explicit top-level Node22/PATH24 удостоверяют runner22; строка «раннер 22.0.0» не устанавливает Node версию дочерних consumers. В частности, формулировки previous own0253 report о Node22 smoke следует читать с этой границей, а не как independently established child-floor execution. Прежние logs/reports сохранены unchanged.

Current `pack-smoke-node22-pathfloor-environment.json` устанавливает runner `v22.0.0`, `spawnedNode=v22.0.0`, npm `10.5.1` и floor bin в начале PATH; соответствующий current raw smoke terminal0 и 36 ESM/CJS/shared-frame consumers PASS. Fresh own direct process22 probe выше независимо закрывает такую же exact-package seam для текущего tuple. All44 с optional peers исполнялись самостоятельно на Node24 с current React19; these domains не смешаны. Current pack-compat/native types primary на Node24 также terminal0: TS NodeNext/CJS/headless/floor/legacy, SSR/bundler и минимальный Preact peer; это прочитанные primary receipts, не собственный новый запуск этих suites.

## Primary readback и пределы verdict

Current actual-package full browser raw: Chromium/Firefox/WebKit, 489 PASS, 0 skipped/flaky/unexpected. Текущие React lifecycle, focus, Solid и resource outcomes прочитаны и привязаны к текущему tuple; full suites исполнял другой owner. Resource raw сохраняет real healthy live/deliberate native controls, 10 000 циклов, 30 000 effects, максимум один cycle effect, 20 host turns, 20 000 retained terminal owners и нулевые terminal jobs/animations во всех трёх движках. Эти данные подтверждают ownership, не GPU/raster/heap bytes, latency или performance.

Current ordinary Vitest raw **не GREEN**: один test failure, «серверный PROFILE: независимые sabotage controls … четыре независимых reviewer counterexamples», timeout30000ms. Primary JSON/exit сохранены; source/statistical/cost оценка этого теста принадлежит другой оси. Ни этот review, ни passing browser/node/package subset не разрешают global GO. Подробные exact primary paths/hashes и scope qualification — в `primary-program-readback.json`.

Excluded: method source/statistics/performance review, second-order cost, hardware/mobile/FPS/energy, GPU bytes, human DX/preference/field adoption/M05 и глобальная production готовность. Finite probes не устанавливают математическую всеобщность или всякую optional-framework/floor/browser комбинацию. Confirmed unresolved blockers в точной рассматриваемой оси — 0; иных осей PASS не присваивается.

## Собственные evidence hashes

| Артефакт | SHA-256 |
| --- | --- |
| identity.json | `7925abce6d1cdade3bbbb3b9722e6f6b2443e22503d461e06914f3e4dc773262` |
| probe.json | `735fe0c2185c70e33423e79971dc48a9e7eb785e1f66a607a140468d27c353dd` |
| probe.log | `67bffe3be032fec754f0d49b8ea03547a13a1fd2dd53faa12a61d90ad479b735` |
| node22-floor-probe.json | `23da2b85a235c90d0be47e63e1f3e4355fad57628bf5320be9dfd747ea032f10` |
| node22-floor-probe.log | `45be9ee330141a4fba852f642e7c2bfe3d99d86e8178abfdb09cf06ae8d4ff16` |
| browser-react19-witness.mjs | `8271ee5e05513329bcdb739e94134f93fefdd6c93a0c47308bfb42911073115d` |
| browser-react19-witness.json | `cc6b405f83fb74f047707f6289154d4d46d49c9b323e107a02e75354485fa539` |
| browser-react19-witness.log | `877adf9ee47ce87011b30a873ffb79a5a9da5035c5abb570cab48f24db19bdbc` |
| primary-program-readback.json | `55b2fb9fa275117a359943e8bc734240220a41b0514f635b85e95f5c07dd31f8` |

Повторение из собственного scratch: `python identity.py`; `node consumer/probe.mjs`; exact floor binary `consumer/node22-floor-probe.mjs`; `python summarize-primary.py`; в согласованном окне `node browser-react19-witness.mjs`. Scripts/JSON/log содержат fixed immutable input digests и direct executor identities. Исторический own0253 PASS SHA `22fbda0c19105c51af6b7ef30c43850ba8e9ccb3614ea19190e86027d1769d28`, preceding Russian FAIL SHA `e6c5bb35a3d75588b1d48c7683b59e122bdc7b341dde3c5d9ca7c825a07c6524`, и ранние English reports preserved. MANIFEST связывает этот report, code/raw/readbacks/input hashes и добавленную floor qualification; внешний digest передаётся отдельно.
