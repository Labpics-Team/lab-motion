# Независимая проверка второго порядка: upstream runtime/package successor

**PASS в ограниченной оси владения, границ, совместимости, lifecycle и будущей стоимости. Подтверждённых текущих нарушений применимого runtime/package контракта — 0.** Upstream delta обновляет только React dev cohort и два test fixtures. Runtime, declarations, exports, recipes и их владельцы не меняются. Реальный consumer Node 22 проверен заново; прежняя квалификация «раннер Node 22» не перенесена как доказательство consumer floor.

Исходное намерение пользователя — полностью довести lab-colors/lab-motion по agents-config до производственного качества. Уточнение об отсутствии Android, нерепрезентативности мощного iOS и необходимости содержательной серверной альтернативы сохранено. Эта ось проверяет public server consumer boundary, но не принимает его за performance/server-method/device evidence. Scientific/numerical/runtime-correctness и timing verdict принадлежат другим проверкам. Product GO этим отчётом не даётся.

## Объект, identity и независимость

Immutable cut: `/workspace/lab-motion/scratchpad/runtime-upstream-final-cut-20261001T124549Z`.

| Input | SHA256 |
|---|---|
| `source-readset.json` | `8f5b59054b7bf088f8f312e0d9e1645a2c6579ed8a78ef28f1120b552c4c24f6` |
| Runtime fingerprint | `f04ad03aeaf49d4dd6cea882f1e56fec90502c1ed2c6b525aa6e923c2e7ffb78` |
| `runtime-base.diff` | `03f7507530b338f55f2403daed1eac2b0041b5bfce210fa7ad813c408b588d64` |
| `primary-evidence-manifest.json` | `a783473b106a206152b1e7c082e6e29225d6be172ad959101898af92bd6bee61` |
| `source-build-byte-proof.json` | `a930133462b96442f0a6aff46dfa2fa22e27bd395d57e47719a591f893d9fb34` |
| PNPM `actual-package.tgz` | `46c9067832760159d35ccd2166b28e6486a57602b1e96d6d23e1c4c06804a402` |
| npm `primary/current-browser-actual-package/labpics-motion-0.3.0.tgz` | `364f9ff8b505191965040eb17059a034e2cb39be5dd0b1468855ca7e9c61c524` |
| Source fingerprint, 117 rows | `5a6f0aaa5c562c6cecd5bc42ea990ce5988619934b50b1535a8a0d058e5d182f` |
| Dist fingerprint, 304 rows | `9c12239053f7833716b4cd0bb8960f1d794bad14ddd5d282e9adc5555a9a5b76` |

Самостоятельный hash-read подтвердил 935 snapshot files и 308 primary refs без расхождений. Runtime-bound — 925: 621 runtime-and-verification плюс 304 production-dist. Десять method-context-only файлов проверены только механически; их смысл и acceptance не принимаются. Runtime/source/dist fingerprints независимо пересчитаны по compact UTF8 JSON rows в исходном порядке и совпали.

Contextual HEAD — `30e73995002422376ec763d2026cbdee19a34f42`; immutable Git baseline — `0b6f537e148b7dadadfb9e3ce7c446d014975958`. Объект review — exact captured source/dist/tar tuple и указанные scopes, без blanket whole-HEAD acceptance. Все pack paths взяты из proof/manifest, без предположений по расположению архива.

Использованы exact source/diff/norm/raw primary и собственная прежняя цепочка. Author HANDOFF/rationale, чужие reports/verdicts и PR body/comments не читались. Live mutable repository runtime не используется как evidence. Node binary, TypeScript scanner и framework peers — явно выбранные, hash-bound harness inputs; все Motion runtime bytes взяты из frozen actual tarballs.

| Прежний собственный review | Report SHA256 | Output manifest SHA256 |
|---|---|---|
| df17 initial runtime cut | `2523ae3cb773d93315e75c957e6ec7d90a5f36f7c3846dc78c983db44065df4e` | `f5f70c2d741cf4e1bca7af69e76355b3d2d34539dbf26896834043335b78dca9` |
| 4e2 focus/resource cut | `a866f119e220b6b745ace7c5542ebf422606cdc61a8fc481c7f2346f2d2e7530` | `4aad8f432e4d4528317a2187b1312c35283814db588567e5e13123ca1d63360e` |
| 0253 closed-ancestor cut | `cb4ae4512746a77d60523003d55ed6a82227b164102709c653d9925fd5014055` | `da5cd8647efa4132edca4961260323c41229c414e43a5c5a4f68d144600ce5a0` |

Все три прежних manifests/reports и 1641 bound собственных файла сохранены и проверены неизменными. Unchanged source/recipe evidence переносится по bytes; изменённый metadata envelope и Node floor proof проверены заново. Перенос старой недоказанной PATH предпосылки исключён.

## Норма и границы полномочий

Manifest-bound `primary/norm/` содержит десять побайтно неизменных норм собственной прежней проверки. AGENTS требует one-axis independent immutable review, actual contract/falsifier для finding и последствия второго порядка существенного изменения.

| Норма | SHA256 |
|---|---|
| AGENTS | `0e1376312cedf91660b1c919ba4c1a9a6e067fe8719eb8daeb52113508b28f0a` |
| SPEC | `7488d5885ee2405d678e488e34a84ce48254978c3a6ad3de2e4d31dfe7b3f651` |
| Current r11 | `cbeef108b288502165437c375bb259f3f4d6dc8ae4ae9e926db133adeba40d4b` |
| Exact r11 activation bytes | `fd0529ff43365afc3bc6f34ae2be51aca1e18a2dad26d6fb2a640124aeba8306` |
| Activation→current status-only diff | `5d260bdf49ef1067e562b7c4ce3a984b18eb07559c47aa54e98b0da50204cb67` |
| ACTIVE | `42e36c2efa89912aa00395c938263c1bf35275325420df52ec736b0986606731` |
| ACTIVATION | `97e6b6ce4080b5c91d62e7ace5844a3c7aeeaa3bce04b21f832785bc807a4908` |
| CLAIM | `56ac2167795a81b9d1a60d2ebc1cb8830a2653cbc45026bbcb2d0b0f8e837fa8` |

Применены r11 INV-01/02/03/05/08/09/10, M-01/M-03/M-09/M-10 и rollback §7 в пределах этой оси: один numeric/time/output owner; app semantics, collection, geometry и focus остаются у владельцев; public packed consumer и прежние optimized paths сохраняются; core/recipes не требуют compiler/editor/AI; environment identity не выводится из имени команды.

r11 остаётся ACTIVE, CLAIM относится к PROFILE-01. Prepared r12 не является grant или active law. Caps, полный 59-cell vector, non-inferiority и Pareto не ослаблялись. Методные изменения, actual registered timings, full source→build→release acceptance и protected product merge/release/deploy этим review не закрываются. Source/norm/budgets/workflows не изменялись; product push/merge/release/deploy не выполнялись.

## Affected delta

Относительно собственного 0253 cut изменены четыре bound файла:

- `package.json`: dev React/react-dom 18.3.1 → 19.3.0, dev `@types/react` 18.3.12 → 19.3.0;
- `pnpm-lock.yaml`: согласованный dev graph, scheduler 0.23.2 → 0.28.0, удалённые ненужные dev transitives;
- `test/motion-value.test.ts`: test-owned fake timeout interval с прежними 3000 ms и отдельный real asynchronous boundary test;
- `test/profile-measurement.test.ts`: только русский комментарий.

Семь других changed files имеют method-context-only scope и не входят в смысловую проверку. Собственные old/new hashes — `affected-delta.json`; bounded diff — `affected-runtime.diff`.

Все 108 runtime source files, public declarations, 304 dist files, compiler/IR/wire code, recipes и lifecycle protocol совпадают с прежним cut. 921 из 925 bound paths неизменны. Оба actual tar имеют 312 members; в каждом относительно прежнего corresponding tar меняется только `package.json`. В npm metadata единственный changed key — `devDependencies`; `engines`, exports/imports, sideEffects, runtime dependencies, peers/meta и typesVersions сохранены. Между PNPM/npm по-прежнему отличается только `packageManager` projection.

## Владение и стоимость React dev cohort

`react >=18.0.0` остаётся optional peer contract, а React 19.3.0 — dev/test cohort. ReactDOM/Scheduler не становятся Motion runtime dependency или новым clock/solver owner. В packed headless consumer нет React installation; каждый независимый entry разрешён без него. Нового compiler/framework bootstrap требования нет.

Это проверено через четыре own headless consumer cases, а не только по строкам package.json. В каждом до import выполняется `require.resolve('react')` и наблюдается MODULE_NOT_FOUND. Затем реальные 36 ESM и 36 CJS public entries импортируются из соответствующего unpacked npm/PNPM package. Actual Motion resolution path и version/execPath дочернего процесса записаны.

Для mixed cohort отдельно проверены настоящие React/react-dom 18.3.1 и 19.3.0, с их явными scheduler/transitive peers. Peers скопированы из точно названных локальных package dirs; версии, все copied bytes и consumer resolution paths связаны harness readset. Каждый consumer использует actual npm Motion package через обычный public export, без source alias или surrogate React implementation.

На Node 22.0.0 ESM/CJS binding SSR обоих cohort прошёл: app-owned `<span>` содержит значение 7, SSR не запросил frame, созданный owner явно уничтожен. Это falsifies предположение, что обновление dev cohort делает React 19 обязательным consumer runtime. Проверка не является полным React client/StrictMode lifecycle verdict, React 18.0.0 floor proof или всеми допустимыми mixed-version историями. Generated declarations побайтно сохранены; test compiler cohort не переписал public type ABI.

Обновлённый dev Scheduler не переносит authority времени от MotionValue/CompositorSpring к React render scheduling. Полная будущая стоимость здесь — поддерживать прежний peer range при смене dev cohort, а не расширять consumer protocol. Public metadata и реальные старый/новый peer consumers согласованы в описанной области. Стоимость deps install для разработчика не объявляется runtime или performance improvement.

## Actual Node floor и подтверждённая квалификация старого evidence

Exact `scripts/pack-smoke.mjs` проверяет `process.versions.node` родителя, но запускает ESM/CJS/shared-frame children через строку `node` из PATH. Поэтому отдельный explicit Node22 invocation не удостоверяет actual consumer Node22.

Own counterfactual это воспроизвёл на текущем actual packed consumer: parent `v22.0.0`, inherited PATH, child `v24.19.0` с execPath runtime Node24. Исторические runner22 receipts не используются как consumerfloor22 evidence. Это подтверждённое ограничение прежнего доказательства, а не найденная runtime incompatibility пакета.

Новый primary environment receipt `32eb05f603cf96a6e19ae27794b896ad36760f35bd2ad266051e4552707f7f20` фиксирует runner/spawnedNode `v22.0.0`, floor bin первым в PATH. Новый raw smoke receipt связан digest `6dc38f740958c91592e335a2022a11442772de7f5453159e351b224a4f89dfd4`, exit 0. Для собственного принятия выполнен actual child probe с прямой записью child.version и child.execPath:

| Own case | npm | PNPM |
|---|---|---|
| Floor binary первым в PATH; дочерний `node` | Node 22.0.0, PASS | Node 22.0.0, PASS |
| Дочерний `process.execPath`; inherited PATH | Node 22.0.0, PASS | Node 22.0.0, PASS |

В каждом случае 36 ESM/36 CJS headless imports, без DOM и React. Обе React peer SSR cases также исполняются actual Node22 child. Node22 executable SHA256 — `0570891fc6e07540b25f18b753445fc16d4428b8a894cca5cf9805c2feee230f`; сам binary не является Motion artifact.

Canonical CI floor job уже получает тот же готовый tarball и применяет actions/setup-node для matrix 22.0.0/24. Release floor также применяет setup-node 22.0.0 после получения готового tarball. Такой путь закрепляет нужный PATH owner и отделяет pnpm producer от consumer runtime floor; нового permanent path или server prerequisite не требуется. Ни workflow configuration, ни удалённые результаты этой проверкой не менялись и не объявлялись passed.

Существенно более простой law для отдельного launcher — передавать children `process.execPath`, что own probe подтвердил даже при PATH на Node24. Это устраняет скрытое исполнение под другим binary без нового CLI flag, registry или producer/build policy. Текущий PATH-floor receipt принимается только с его environment premise; script name сам по себе не является future floor guarantee.

## Test harness boundary

Новая fake-timer установка находится только в одном test case и перехватывает только setTimeout/clearTimeout. Motion runtime, numeric clock law и public scheduling API не изменены. Cleanup уничтожает созданный MotionValue до возврата real timers в nested finally. Original 3000-ms interval сохранён в test input; отдельный настоящий timer test оставляет проверку asynchronous host boundary с явным deadline/cleanup. Это локальный владелец тестовой среды, без нового product mechanism.

Данная ось не принимает fake interval за equivalence/performance proof численной динамики и не выносит general correctness verdict. Raw current motion-value suite имеет status passed, 46 assertions; это ограниченный receipt, не собственный suite run.

Comment-only fixture независимо проверена TypeScript scanner с пропуском trivia: 1872 executable tokens совпадают побайтно как token pairs. Paths/allowlist/provenance actions не меняются. Ни clone fixture, ни profile methodology не исполнялись; semantic method acceptance не выводится из такого token check.

## Сохранённая собственная runtime closure

По exact byte equality сохраняются прежние проверенные owner boundaries:

| Решение | Владелец | Consumer obligation |
|---|---|---|
| Scalar value/velocity, live/native state, explicit loan revoke | MotionValue/CompositorSpring и общий numeric owner | Старые scalar calls; native return opt-in |
| Gesture state/tracker/runner | Private behavior base | Прежняя behavior facade |
| Spring physical defaults | Один internal constant owner и public token projection | Нового semantic policy нет |
| Sheet snaps, pager index, RTL, semantic labels | Application/component | Прежние callback/select/resize |
| Geometry/membership/reorder | DOM/application и прежний resolver/projection | ABI сохранён |
| Focus lifetime | Component recipe и platform focus owner | Одна прежняя destroy boundary |

Прежний собственный AST baseline comparison не находил removed/modified MotionValue/behaviors/tokens/compositor public signatures. Additive method `CompositorSpring.handoffToCompositor(number?): void` усиливает существующий scalar owner. Старый live retarget остаётся live; explicit native return отзывает loan, host refusal сохраняет live state, fallback сохраняет тот же MotionValue. Это было проверено через actual ESM/CJS consumers собственной цепочки. Перенос не основан на чужом verdict.

Core/compiler/runtime/surface и MotionProgram IR совпадают с immutable baseline в собственном evidence. Сохранён guard того же допустимого wire cap; новый serialization ABI/writer generation не появляется. Always-live или implicit return через старый retarget не сохраняют одновременно native no-own-frame и loan semantics; отдельный successor controller у consumer потребовал бы ручного velocity/cancel/lifetime protocol. Новый solver/store/tier не требуется.

Exact recipes совпадают с own 0253 cut: ранее 50 ownership cases PASS, 8 old closed-ancestor counterexamples. Helper использует доступные ancestor roots, включая closed roots, без global observer. Destroy сохраняет чужой новый focus и disconnected target, восстанавливает принадлежащий компоненту connected previous максимум один раз. Этот evidence перенесён только на unchanged recipes; arbitrary inaccessible closed sibling leaf не объявляется поддержанным новым contract.

Observed WeakRef-less counterexample собственной цепочки остаётся: baseline callback path выполнялся, candidate при `WeakRef = undefined` бросал TypeError. Current README явно требует ES2022+native WeakRef, Node ≥22. Применимый исторический contract для WeakRef-less supported realm не установлен; перенос на такую среду остаётся **INCOMPLETE**, без current confirmed finding. Новая документация не даёт разрешения сузить уже обещанную поддержку, если такой premise появится.

## Receipts, readsets и ограничения

Новые actual build/size/pack receipts присутствуют в primary; sourceFiles 117/distFiles 304 и оба tar member readsets механически совпали. Собственных heavy builds не выполнялось. This-axis byte conservation не заменяет final source→build→package acceptance и registered actual timings. Declared caps и 59-cell vector не менялись; неизменный dist не является blanket all-budget PASS.

Raw ordinary Vitest **FAIL сохранён**: 4890 total, 4889 passed, 1 failed, success false, exit 1. Reported numFailedTestSuites — 2; фактически failed suite entry находится в `test/server-profile-contract.test.ts`, assertion о четырёх независимых reviewer counterexamples public admission. Анализ/исправление этого method gate вне данной оси. Raw browser receipt: expected 489, unexpected/skipped/flaky 0, exit 0. Он не является whole-head CI/product GO или собственной browser проверкой.

Исполняемые собственные commands и все attempts записаны в `commands.json`. Основные commands:

```text
python3 /workspace/scratch/motion-runtime-second-order-final-20261001-upstream-delta/inspect-inputs.py
python3 /workspace/scratch/motion-runtime-second-order-final-20261001-upstream-delta/prepare-consumers.py
/workspace/lab-motion/scratchpad/node-floor/node-v22.0.0-linux-x64/bin/node /workspace/scratch/motion-runtime-second-order-final-20261001-upstream-delta/node-floor-parent.mjs
node /workspace/scratch/motion-runtime-second-order-final-20261001-upstream-delta/comment-conservation-probe.mjs
python3 /workspace/scratch/motion-runtime-second-order-final-20261001-upstream-delta/record-closure.py
```

Все final commands — exit 0. Повтор лёгкого floor probe обоснован добавлением наблюдаемого peer-absence и actual resolution checks; initial result сохранён. Начальная exploratory query с устаревшим JSON key завершилась exit 1 до integrity work; corrected manifest field — files. Эта schema ошибка не выдана за artifact drift. Времена tool execution не используются как performance evidence.

| Own evidence | SHA256 |
|---|---|
| `input-integrity.json` | `a00b03547935fad0a9ce7e67280ef2a2bed9bbaeef9dd70841887d8255dd0ef7` |
| `semantic-input-readset.json` | `1f0e3cc819360eab5a430baca659c705207caa495cfb600e8aef98c3159fec38` |
| `affected-delta.json` | `980b9877b690e6008905fb409c0ad67208182b6b684715e020ddc5f07fd3affb` |
| `affected-runtime.diff` | `ba4bb9f436a3c42e61460a1daa1424191675dc8870a146ac10de2ffb246d9844` |
| `package-member-readsets.json` | `ca809908304539cdc2c0d442d5a7dcc32570e87d926b22a98682b35bbc422e3a` |
| `package-delivery-delta.json` | `6a0c717b31f0d25fd4e2b5a976ef72d22a1ce59ec5d1ab5aa648c08477a0be9f` |
| `harness-inputs.json` | `9f37d33667d4f92e4c4baa5a093f11f19a4583fb152ee2001efb6458aa930864` |
| `node-floor-consumer-result.json` | `8e81be77d2d60965c169d9993ab50897e2c0c9c80de9d4067b3e8657d94296aa` |
| `comment-conservation-result.json` | `1326bb6bd38804f0755bff719e57cbe8b4854e9a166aa017b876a4cdc5297b8a` |
| `fingerprint-readback.json` | `1167f9a82232b2fb7e868baeb660061f4890ac1bb769e64f199198db36923aab` |
| `own-chain-transfer.json` | `3e97269d1def41d053bcfed2207acb06a53d8a7eb42d46f9d10d10c65c52a339` |
| `primary-receipt-readback.json` | `803bc002472313bb9f192697bbc1aeffc9144ef5535f3920af236df3ed382e52` |

Точный direct/transferred semantic readset отделён от механического hash-read. Full 935-file readback не объявляется semantic acceptance всех строк. No numerical/method/performance/device/general-correctness verdict; no heavy build/full suite/browser/full-N run. Серверный consumer floor здесь проверен содержательно через исполняемые package consumers, но transfer server cost model/device representativeness остаётся отдельным обязательством.

Scope PASS переносится только на exact bytes и описанные package/ownership histories. Changed runtime/types/recipes/exports/peers/build/support envelope или предъявленный исторический support premise аннулируют затронутый перенос. Подтверждённых unresolved current findings — 0. Исторический PATH-floor inference отклонён actual counterfactual и заменён новым actual consumer evidence; предположения о mandatory React19, universal closed-tree support и WeakRef-less supported consumers не выданы за нарушения.

Все outputs/scripts/copied peer inputs/packed members связаны `review-output-manifest.json`. `terminal-receipt.json` отдельно связывает report, manifest и final readback без self-hash cycle. Предыдущие artifacts сохранены. **Все собственные процессы завершены. END; слот свободен.**
