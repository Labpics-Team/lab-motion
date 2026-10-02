# Допустимость свежей preregistration после preparation refusal

**PASS в узкой области predata/environment admissibility.** Новая preregistration epoch6 перед первым pilot допустима на текущих стабильных toolchain bytes при неизменных guards. Подтверждённого блокирующего пробела для этой смены среды не найдено. Это не sampling/quiet grant и не фактический performance PASS: зарегистрированных performance samples **0**, pilot/A/A/2×work/A/B **UNPROVEN**.

Пользователь требует production качества и содержательного серверного аналога без Android/нерепрезентативного мощного iPhone. Здесь решён единственный вопрос: можно ли после сохранённого отказа подготовки начать новый before-data epoch без выбора удачной timing серии. Метод, программа и другая ось не переаттестованы. Норма — own frozen agents-config85a AGENTS/SPEC/r11 G-PERF; r11 active, r12 prepared only. Никаких main merge/npm/deploy полномочий не выдано.

| Объект | Identity |
|---|---|
| Source / tree | `185f02c2a85972a531627e14b7e0207e27855f95` / `d2b7d736ba9a37b930a0bd4cfa3cae92f12a92bc` |
| Baseline | `0b6f537e148b7dadadfb9e3ce7c446d014975958` |
| Profile | `7016c19aa7a763fee68687327ef489abb119acd2a43d397b8485ca56e4cea15f` |
| Clock | `7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f` |
| Refusal PRIMARY,9198B | `b7271ff08f9506882093190c7380a6dc0e2a7cecf7b8e05962392139a3c09ad5` |
| Epoch6 PRIMARY | `85d86f01d2fdc729a702dcbb3c60f8d5732c9b23a1e683736c9ec0d76ea02a6e` |
| Epoch6 predata tuple | `e9687480c8ce7d2028a55275e84a77f9ce195cdbae783170573bf63035c52f31` |
| Epoch5 raw | `f47e7301d8f02c9cfef415ab9523cd3f7474253df9888aa02fa4a8a12858314d` |
| Epoch5 journal | `3e86013c0b7dcea8debd3f107df711b9fe1f31dace2bc14e43f3823056aebe57` |

34 исходных primary refs и7 новых metadata refs независимо rehashed/retained, mismatch0. Никаких Node executors, builds, timing/probes или новых package-tree hashes reviewer не запускал. Сравнивались только сохранённые небольшие bytes/JSON и два source owner файла.

## Почему повторная регистрация относится к подготовке, а не к отбору результата

Epoch5 single launch закончился exit1 между23:07:07.631980Z и23:07:45.710793Z. Raw сохраняет verdictUNPROVEN, warmup=[], stages=[], gc=[]; journal имеет только registration-before-any-sample, failure, failure, finished. Первая и final-provenance ошибки одинаковы: «tsup изменился во время benchmark-прогона». Нет sample/failed-sample, pilot, A/A или candidate timing. Связь registration→raw, полная failure union, внешний SHA raw и final journal raw digest непосредственно проверены по retained JSON. Journal body validation всего метода заново не исполнялась.

Точный `prepareBenchmarkCheckout` captures source/environment до canonical build, затем проверяет clean source/revision/worktree и возвращает captured tool trees. Точный `runServerProfile` после подготовки обоих участников записывает registration, затем `verify()` проверяет source/dist, все root+bench package trees, harness, tar/unpacked consumer и browser tree **до baseline raw controls/warmup**. `assertInstalledPackageTreesUnchanged` сравнивает exact version, file count и full tree SHA. Поэтому старый captured tsup digest правильно вызвал отказ до данных. Source/provenance bytes (`51881a…`) и runner (`5d0f11…`) совпадают с собственным immutable185 readset; guard не изменён.

После отказа owner выполнил **один** canonical baseline `pnpm run build` с Node24.19/CItrue/unsetNODE_PATH/NODE_OPTIONS. Первичные argv/cwd/start/end/stdout и before/after snapshots сохранены. Diagnostic duration23:10:38.381Z→23:10:51.320Z, exit0; полные before/after snapshots tsup/typescript/esbuild и distRuntime равны. Это bounded наблюдение отсутствия **net drift в этом build**, не универсальная гарантия стабильности или точный причинный эксперимент над отсутствующими историческими байтами. Сохранённые member hash maps старого опубликованного baseline и actual epoch5 baseline package равны для312 paths; добавленных/потерянных/changed members нет. Речь о unpacked member identity, не произвольной equivalence полного gzip/tar контейнера.

Изменение перед epoch6 одно: baseline tsup8.5.1,25files SHA
`0069fb7e1c74f8ad7960292641dfe1d71f2d86eac24f803ed5c9adcba9a1058e` →
`897380bc5824e41999cad580dee5670f791646847cbdb01a741bbccd94ae8847`.
Новый digest совпадает с независимыми диагностическими snapshots. Candidate environment целиком, baseline Node/pnpm/bench packages/typescript/esbuild, machine identity, source/protocol/clock/owner hashes/source pins/browser refs/N/seed/stopping сохраняются.18 значимых tuple fields сравнены напрямую. Fresh clockRegistration содержит именно свежие environments/machine, а не старый tsup aggregate.

Обновлены дата и observational machine fields, disk budget, absent новый output path, linkage к immutable failed predecessor и отметка epoch6. Эти metadata не выбирают выигравшие timing effects: performance/semantic cost series ещё не наблюдалась. Прежняя registration digest `6cf88bb8b09dfb3abbf608cc202dd9cc76f7a6dd3856c7a8156ee6c42f91727d` и её negative result остаются immutable; epoch6 tuple не переписывает их и не переносит выборку.

## Условия и пределы

Новый отдельный отсутствующий output и новая реальная registration должны предшествовать первым warmup/pilot samples. Runner вновь захватывает текущие tool/browser bytes и сохраняет прежние after-preparation/after-block/final-provenance guards. Любой новый drift вновь даёт UNPROVEN с retained raw/journal. Baseline-only pilot, freezeN292…1024 по прежнему правилу, один actualA/A и actual2×work, conditional A/B только при годной calibration, запрет добора/повтора к GREEN сохранены. Здесь не санкционируется новый запуск; separate fresh root/parent quiet/admission остаётся вне этой оси. Root quiet grant как доказательство не читался.

Два существенных causal limits сохранены без приукрашивания:

- До **initial epoch5 build** не сохранены per-file tsup/shim bytes. Доказан aggregate captured→post-refusal drift. Есть14 текущих baseline/candidate `.bin` файлов и их diff, совпадающие с post-refusal manifest; этого недостаточно назвать точный исторический «7-file cause», writer или доказать, что именно initialbuild сделал каждый такой diff. Историческая точная причина **UNPROVEN**.
- Diagnostic success stderr не получен wrapper из успешного execFileSync. Нулевой diagnostic-build.stderr.log — явный authored placeholder, а не наблюдение отсутствия stderr. Полный actual epoch5 stderr сохранён. Helper сохранён с квалифицированной заменой относительного import на эквивалентный absolute provenance path; второе исполнение для восстановления лога не выполнялось.

Epoch6 browser-tree/pins/package references частично исторические. Новый predata не заявляет fresh hash всего browser package; реальный runner до данных захватывает и проверяет полный browser/prepared environment. Никакие700MB archives, program/method/SO sweeps, чужие reports/verdicts/PRbody/comments/HANDOFF/CLOCK rationale или ROOT quietgrant не читались. Никакого физического FPS/energy/mobilefeel/adoption/globalGO вывода нет.

Исторический refusal не становится успешным: epoch5 остаётся UNPROVEN. Повтор **до данных** с новой точной средой не является повтором A/A или A/B до удачного результата. Если выяснятся наблюдённые warmup/pilot/control outcomes predecessor, иная source/tool delta или ослабление guard, этот bounded вывод потребует пересмотра. Будущая статистическая допустимость реальных данных проверяется отдельно.

## Долговечность и команды

`commands.jsonl` хранит реальные read/compare команды, UTC/exit/stdout/stderr; `derive-predata.py` воспроизводит сравнения только retained primary JSON/bytes. Один собственный metadata-parser отказ (integer oldMembers ошибочно принят за array) сохранён с первоначальным script и stderr в command receipt; corrected script сравнивает counts312 и полные member manifests. Это HARNESS error, не product/environment finding.

`exact-readset.json` содержит все34+7 primary path/bytes/SHA, source ranges и qualified own norm/chain refs. `predata-facts.json` сохраняет factual comparisons без executors. `output-manifest.json`, `terminal-manifest.json`, `terminal-seal-receipt.json` связывают полный output/readback. После seal files0444/dirs0555; свои процессы закончены, heavy0 и никакой queued CPU/I/O/probe/hash работы. Зарегистрированных performance samples0; дальнейшая реальная серия HOLD до самостоятельного допуска владельца.
