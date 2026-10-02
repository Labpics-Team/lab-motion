# Независимая correctness дельта fixture/types/tests: PASS в указанной оси

Subject — immutable candidate `185f02c2a85972a531627e14b7e0207e27855f95`, tree `d2b7d736ba9a37b930a0bd4cfa3cae92f12a92bc`, parent `7f9b85d82bdf531455a8eb0fae4406484205ef83`. Подтверждённых нерешённых blockers в шести рассматриваемых fixture/types/tests файлах — **0**. Декларации соответствуют существующим executable recipes, повторная extraction очищает собственный package directory, reduced-motion regression теперь различает настоящий синхронный путь и ошибочно подключённую factory.

Исходная цель пользователя — довести lab-motion до production quality по действующему agents-config r11. Этот независимый own-chain review закрывает только необходимую функциональную дельту после прежних runtime/upstream/React-floor проверок. Статистический метод, стоимость, adoption/mobile/field и whole production GO не рассматриваются. Author HANDOFF/triage/reasoning и чужие reviewer verdicts не читались; CodeRabbit receipt в packet проверен только по checksum. Library, планы, worktree и старые отчёты не изменялись. Собственные результаты находятся только в этом `/tmp` scratch.

## Exact identity, норма и readset

PRIMARY packet SHA проверен первым. В согласованном коротком окне проверены все 34 primary файла: 625844B. Source archive содержит 631 regular file; SHA-256, длина, Git blob SHA-1 и mode каждого файла independently совпали с реальным candidate Git tree. Commit→tree и commit→parent установлены через Git, не только из author metadata. Source packet, source manifest, patch и freeze receipts сверены по hashes.

| Вход | SHA-256 |
| --- | --- |
| PRIMARY-PACKET.json этого фронта | `e25ef4518e8a14732909558b0494bb5b366e3c67e8d883cc04ee27a669f6ba84` |
| referenced source PRIMARY-PACKET.json | `9c5bbb20ca1c9e8442cbe692710f9d62bf91d3d1865b58d6eba4a2365831bc9a` |
| immutable source.tar.gz | `8c7d68e4a045f71a5059fce689e31747165d2ce7b332b26a1ade9eef9cf89019` |
| source-and-checks.json | `8485c2ed0523b03366dbbfb7adb01d0b0990dcb2784804553681e015a97efe7a` |
| source-delta.diff | `cb6b0ebc6855be9ace2aef710a60100c1a6d43d40e7397eb3452ce9956c99149` |
| previous runtime readset | `8f5b59054b7bf088f8f312e0d9e1645a2c6579ed8a78ef28f1120b552c4c24f6` |
| actual npm tar | `364f9ff8b505191965040eb17059a034e2cb39be5dd0b1468855ca7e9c61c524` |
| own qualified current readset | `8782f1e91e3e10f173a57435b8e8876e15a2bdb2642009b9a901ff803a8734fb` |

Actual tar имеет ровно 312 уникальных regular members, включая 304 dist. Все source-owned package members byte-equal current source; 304 dist совпадают с previous bound readset. Объединённый identity каталог 631 source +304 dist сопоставлен со старым 935-file readset: 913 файлов conserved, 22 changed. **Это identity inventory, не перенос verdict на global935.** Шесть изменений входят в текущую correctness ось; остальные 16 — method/benchmark context вне этой оси, независимо от прежнего технического `scope` label. От parent изменены 17 файлов, включая эти же шесть; другие 11 parent changes не оценивались. Все `src/**`, package.json, docs/recipes.md и dist имеют прежние проверенные bytes. Публичные 44 exports, девять bindings и library API не менялись.

Authoritative norm осталась r11: ACTIVE/CLAIM прямо указывают r11. Текущие AGENTS, SPEC, ACTIVE, CLAIM, ACTIVATION и r11 byte-equal frozen norm предыдущего8f5 packet. AGENTS SHA `0e1376312cedf91660b1c919ba4c1a9a6e067fe8719eb8daeb52113508b28f0a`; SPEC `7488d5885ee2405d678e488e34a84ce48254978c3a6ad3de2e4d31dfe7b3f651`; ACTIVE `42e36c2efa89912aa00395c938263c1bf35275325420df52ec736b0986606731`; CLAIM `56ac2167795a81b9d1a60d2ebc1cb8830a2653cbc45026bbcb2d0b0f8e837fa8`. Original activation r11 `fd0529ff43365afc3bc6f34ae2be51aca1e18a2dad26d6fb2a640124aeba8306`, current r11 `cbeef108b288502165437c375bb259f3f4d6dc8ae4ae9e926db133adeba40d4b`; прежний status-only diff и SPEC47–58 qualification сохранены. Применены qa/verify, AGENTS independence и r11 G-CONTRACT/G-COMPOSE. Draft r12 не использован как norm или permission.

## Шесть изменений и независимое closure

| Файл | Current SHA-256 | Проверенная семантика |
| --- | --- | --- |
| browser/fixtures/packed-recipes.d.ts | `bbc33fcc80530684a66c68ea90d4b8596784b729717880c984a36a6a06ac96ac` | Полный type boundary существующего generated artifact |
| browser/fixtures/scope-recipes.mjs | `661a591b92e2995e7f4c4a0b1a843e548a094970955a0063f6cdac89f0a58247` | Очищается только node_modules/@labpics/motion перед extraction |
| browser/presence-transition.spec.ts | `cb4dc7b7787be4cdf68f10f8381c8e0804ba575cd9468b08cecf8dd3ab51581e` | Два импорта объединены до создания любых проверяемых owners |
| browser/reorder.spec.ts | `5932c471f230b11833c76a87291c16aaee39da0dba8883e78ab1f9c1cae6fe24` | Убран missing-export suppression; null assertions относятся к реально созданным fixture nodes |
| test/behaviors-late-callback-owner.test.ts | `5b62dae47e9dd35c1c026f91a3a782300e0655439c1f906122c3ee083503527b` | Factory вызывается; до drain проверены reduced/ordinary различители |
| test/resource-actual-package-retention.test.ts | `f59866843a86c85adef6781cc9abf7b624a11ae4d3f0988ecb799b739176a12f` | Изменены только комментарии, executable checks прежние |

Декларации самостоятельно сопоставлены с immutable literal cookbook и generator entry: `mountCardMotion`/`mountReorder` возвращают cleanup; sheet требует числовые snapPoints, имеет selected getter и resize(points); pager измеряет геометрию сам и имеет resize(); оба используют реальный generic `CompositorSpring`. requestFrame type получен из существующего constructor, а Solid container — из существующего render signature. React wrapper действительно возвращает destroy/commits и принимает createRoot/hydrateRoot container domain. Это приватный browser artifact boundary, не новый публичный behavior façade API.

Primary strict type witness содержит положительные вызовы всех шести ранее отсутствовавших exports и отрицательные `@ts-expect-error` controls: обязательные sheet options, числовой индекс/геометрия, readonly selected, отсутствие selected у generic motion owner, pager resize без app geometry, non-null reorder nodes, boolean hydration. Before raw compiler output содержит missing-export diagnostics для всех шести; after output пуст, exit0. After declaration/fixture hashes равны exact candidate bytes. Witness labels сохраняют parent7f9 provenance: это audited primary transfer по совпавшим bytes, не объявленный fresh reviewer typecheck.

Extraction law выведен из source: `rmSync(packageRoot,{recursive:true,force:true})` выполняется после получения и integrity проверки actual tar, перед mkdir/extraction; scope удаления — только owned packageRoot. Primary distinguishing history дважды извлекает один неизменённый tar, добавив между извлечениями `dist/stale-receipt-witness.js`, которого нет в tar. Before sentinel сохраняется и реально bundle-resolves, хотя prefix guard его допускает; after отсутствует и не разрешается. Healthy actual CompositorSpring import продолжает работать; sibling package и consumer marker сохранены в обеих фазах. Тар312/SRI/байты одинаковы, поэтому контроль различает stale extraction provenance, не изменение library runtime. Собственный pack/build/новый extraction replay не запускался.

Reduced witness закрывает реальный coverage дефект: helper `reduceMedia(matches=true)` возвращает matchMedia function. Переданная без вызова factory при library query возвращала функцию без `.matches===true`; прежняя надпись reduced=true фактически покрывала ordinary branch. Frozen RED с добавленными pre-drain assertions имеет ровно шесть reduced=true failures: rafCalls expected0/received1. Fixed test использует `reduceMedia()`; GREEN12 при том же library source SHA `5f9cf1338496dc339bc941c58d53bf609a172aab38faf806b6ade7b75d372385`. Старые logs/reports сохраняются; прежний label сам по себе не удостоверял zero-frame reduced branch.

## Собственный короткий причинный probe

В отдельно разрешённом окне выполнены 12 public actual-package cases на pinned Node24.19.0, с удалёнными NODE_PATH/NODE_OPTIONS. Использован уже физически извлечённый npm364f `@labpics/motion/behaviors`, CJS SHA `57aaeae1a3e89b4503c4dcda20d5c15cea78e8c9362ff8c12513c4e3c17d6b5e`; source/dist conservation проверена выше. Production clock/fixture assertions не импортированы: собственные точки31/threshold12, step17 и clock/data oracle отличны от regression20/threshold10/step16.

Для dismiss/refresh в healthy/destroy/cancel состояниях wrong uninvoked factory до drain дала ровно request1/pending1/reads0/calls0. Correct factory result дала request0/pending0/reads1 синхронно. Healthy callbacks исполнились один раз с original options receiver; getter-triggered destroy/cancel отозвали callback, calls0. Во всех случаях были полезные положительные gesture values, queue окончилась pending0; reduced route не запросил ни одного кадра. Публичный callback.call accessor намеренно throws и не читался. Healthy refresh вернулся в idle. Это distinguishing semantic controls, не performance/FPS измерение.

Первый собственный identity запуск завершился1 до проверки первого member content: harness ошибочно ожидал bare archive paths, actual archive имеет fixed `source/` root. Initial code/log/execution/cause сохранены в `harness-initial`. После отдельного grant исправлена только эта path premise; exact631 path set/GitBlob/SHA/length и package assertions не ослаблены. Corrected identity завершился0; Node probe также0. Это reviewer harness error, не product finding и не retry calibration до GREEN. Все процессы закрыты; root и parent получили START/END до report prose. Далее только metadata/readback/seal; broad Node/type/browser/build/pack/fullsuite/mutation не запускались.

## Current functional primary и ограничения

Current affected browser execution sourceHead185, workers1/retries0, terminal0: 62 expected passing cases на каждом Chromium/Firefox/WebKit, итого186, skipped/flaky/unexpected0. Каждый raw result именно passed с expectedStatus passed, не ожидаемый failure. Шесть suites покрывают presence/reorder/animate scope/compositor recipes/journey/resource и actual npm364f; bundle SHA `0cf981af25f70cad91450d763a40723f2fcd7c7d00b6df6838d8afe107415e8d` совпадает с предыдущим actual-package witness. Library/recipes conserved, поэтому нет необходимости заново запускать весь runtime/browser корпус для private fixture/type/test дельты.

Local static receipt sourceHead185 имеет terminal0 для static/docs-facts/diff; package script static включает browser typecheck. Свежая hosted metadata и raw связывают merge commit `19b0eeb0c52da96275e5493054e33f4a74672480` с exact candidate tree d2b7… и parent185. Raw содержит344 test files/4975 tests passed, отдельные12 late-callback cases,4 resource cases и111 finiteness tests; metadata фиксирует successful browser typecheck/conformance на всех трёх движках. Это readback функциональных primary observations, не запуск reviewer и не verdict статистического метода.

**Local ordinary exit1 сохранён.** Один отдельный unchanged-original resource control завершился0, но не заменяет whole ordinary failure и не устанавливает причину исходного отказа. Hosted same-tree fullsuite success — отдельное наблюдение; histories не удалены и не переименованы в local GREEN. Registered performance samples остаются0/HOLD; эта correctness ось не разрешает performance admission или globalGO.

Пределы: только перечисленная необходимая дельта; не global935/925 PASS, не новая статистическая/стоимостная ось. Fresh собственный runtime execution ограничен reduced seam; strict types/extraction и three-engine186 — independently audited primary, не собственный новый type/build/browser запуск. Весь method code вне verdict, даже если его bytes входят в identity catalog. Прежние Node-floor PATH/runner qualification и React18 runtime/type/browser ограничения сохранены. Mobile/FPS/energy/heap/GPU/field/humanDX/adoption и будущие API promises не добавлены.

Own-chain report79dcc и React18 report88e455 сохранены с прежними SHA; более ранние English/Russian FAIL/PASS history не редактировались. Runtime B1/focus closures переносятся только на подтверждённо conserved library/recipe bytes; новая reduced coverage предпосылка проверена независимо выше. Подтверждённых нерешённых blockers в **точных шести файлах этой оси** —0.

## Собственные доказательства

| Артефакт | SHA-256 |
| --- | --- |
| identity.json | `a46f64f0c57f9572dc94b6e5ececbd0fd036377f5a055dc8a874e349511ce8ce` |
| reduced-probe.mjs | `75e4da5cf7e326e21e15a43920fb38192c1fdc317d2bab70c5e3af250c0ff568` |
| reduced-probe.json | `dafcd7b62291d54d69ddeb9d639c6c7d870bac2abc2accf9772c17f51428bd47` |
| reduced.log | `2d27bd1bab03cc37fb8a9cfdeec566b5182e12fb31974ea81f9815d891a4f4a6` |
| successful execution receipts | `ebed8758e619c8114552479fec5f51b31669c484e24c70d95cdb6b9ce112b69f` |
| primary-readback.json | `596fe8963dedaf4ec4371beca96cc76a06becc9602b72d8a8d0a590384618baa` |
| initial harness code | `baf38df6143d9f9bc5bb3bbdafe522c245e09759ccfecf30a8edb6584bec4dba` |
| initial harness failure raw | `13729aeb8473986f578ac5c0a5aadb998e0363d8535110c6f9cd5dd42723e049` |

MANIFEST связывает этот report, самостоятельный source/readset/probe code/raw, initial failure, шесть дополнительных raw compiler/RED/GREEN logs и frozen source/PRIMARY refs. Дополнительные logs скопированы из original directories, прямо referenced frozen witness entries; они additive raw и не выдаются за исходные34 manifest files. Внешние report/manifest SHA передаются отдельно. Повторение только в свободном согласованном окне: `python3 identity.py`, затем pinned Node24.19 `reduced-probe.mjs` с NODE_PATH/NODE_OPTIONS unset. Ни library source, ни старые reports для повторения не изменяются.
