# Независимая проверка метода измерения и сохранности CPU evidence Motion

**PASS** для одной оси в immutable HEAD `f6476ae990254f606faf97f80afe41965bec2fb2`: сохранность приобретённых CPU endpoints при `native-cpu-rle-v1`, прежняя точность целочисленного представления, отказ при нарушении lineage, порядок/происхождение и сохранение статистических предикатов. Подтверждённых findings нет. Это проверка метода и carrier; фактическую калибровку, admission кандидата, CI cost, весь PROFILE-01 и production readiness этот результат не закрывает.

Намерение пользователя — полностью выполнить Lab Motion по agents-config до производственного качества. Android недоступен; мощный iPhone не представляет целевую нагрузку. Требуется содержательный серверный аналог. Проверяемый estimand — сообщённое Linux время исполнения главного потока; browser API имеет отдельный estimand. Приёмка этого изменения не превращает серверную клетку в физическую Android/iOS проверку.

## Immutable объект и перенос доказательств

| Объект | Идентичность |
| --- | --- |
| Final HEAD | `f6476ae990254f606faf97f80afe41965bec2fb2` |
| Final tree | `40fbe427bbd750e9423feb71b6b6238080300022` |
| Effective diff base | `088fbc605c95fd6a6a7620301a450d6388386997` |
| Source archive HEAD | `5a4c29d8abb102b1fea563d14c30c3cdf13efe2c` |
| Source archive SHA256 | `de9d2501a5391527a252da1428ee031d15e187fdc5224f7bcb2df60a95656797` |
| Source diff SHA256 | `39d46a3c4c20633f4a29e1df26b4891d3fae94772d364088ecc810da688c4db6` |
| Final PRIMARY SHA256 | `e0d911564aae5890a75788c33347e01299993c2b7b1c643edfb69e94863e2961` |
| 5a4 PRIMARY SHA256 | `e749209ac077ed25373d9f1b9b963177ed603c48468f55f221b750d5744fa992` |
| Final commit.raw SHA256 | `1fa6cd250f87f75d9ebec228c5c9460fc2c630bd04360004598e714961fa041d` |
| Final tree.raw SHA256 | `9f40fafa814871a848794ce301976fa31760ab149a8d530c4289b114fab0b429` |

`commit.raw` самостоятельно хеширован как Git commit object: OID совпал с final HEAD. Его tree header совпал с final tree. Из mode/name/Git blob ID всех 639 файлов старого source archive самостоятельно построен бинарный root tree: он побайтово совпал с final `tree.raw`, а его Git OID совпал с `40fbe4…`. Каждый файл archive сверён с собственным распакованным immutable 5a4 SOURCE и прежним 5a4 binding: 639 совпадений, 0 несовпадений. История commit содержит промежуточный 6502; его экспериментальная test delta отсутствует в принятом final tree. Семантика исключённого 6502 не служила oracle.

От 088 остались неизменными 632 файла; семь изменённых владельцев перечислены в `source-bindings.json`. Ранее полученное собственное доказательство 088 перенесено только по сохранённым байтам: целые неизменные source owners, отдельно проверенные функции изменённых владельцев, неизменные нормативные снимки и сохранённые первичные inputs. Это не повтор ABI или timing на f647. Единственный новый bounded runtime фактически выполнялся на 5a4; его перенос на f647 основан на точном тождестве всего SOURCE tree, а не на имени ветки или выводе автора.

Все 16 ссылок final PRIMARY и все 20 ссылок 5a4 PRIMARY прошли hash/bytes binding. Cost/profile файлы из final PRIMARY только связаны по bytes/hash; их содержание и авторская интерпретация стоимости не использовались для verdict этой оси. Проверка полного carrier не означает семантическое чтение каждого файла.

## Норма и независимость oracle

Применена норма `/workspace/agents-config/AGENTS.md`, особенно 119–143; `plans/SPEC.md`, `plans/TEMPLATE.md`, `plans/lab-motion-production/{ACTIVE,CLAIM,ACTIVATION,r11,r12}.md`. Восемь файлов снова сверены с собственными нормативными снимками 088: все побайтово совпали; bindings сохранены в `norm-bindings.json`. `ACTIVE` и `CLAIM` сохраняют r11 active/PROFILE-01. r12 prepared не получил authority посредством этого review.

Oracle: immutable source/diff, первичные raw/ABI/fault inputs, собственная независимая арифметика и различающие synthetic witnesses. Авторские REPORT/HANDOFF/rationale, root/чужие verdict и bot conclusions не читались как oracle. Собственное предыдущее доказательство 088 сохранено явно с исходным HEAD, readset, raw и execution; новая source identity проверена независимо. Производственные файлы, нормы, tests/config/thresholds reviewer не изменял.

## Результат по законам carrier и метода

| Закон | Независимое основание | Диспозиция |
| --- | --- | --- |
| Все приобретённые поля сохраняются | Contract 185–218 проверяет точные семь own data fields в исходном порядке: sequence/clock/pid/tid/seconds/nanoseconds/valueNs. Canonical sec/nsec и исходные sequence/valueNs проверяются до упаковки; никакое forged производное поле не исправляется. Metadata runs сохраняют clock/PID/TID и каждый exact timespec | PASS |
| JSON identity | Decoder 221–246 восстанавливает те же семь полей в исходном key order. BigInt вычисляет исходный valueNs после предварительного доказательства, что приобретённое поле ему равно. Независимые ручные ожидаемые runs и JSON roundtrip дают побайтово исходный JSON | PASS для принятой canonical plain-data области |
| Count, suffix и порядок | Decoder сверяет expectedCount с длиной независимых clockReads, run.from с накопленной длиной, count/tuple lengths и конечный total; gap, потерянный suffix, лишняя длина и соседние одинаковые metadata runs отвергаются | PASS |
| Clock correlation и lineage | Единственная вставка в прежний `validateThreadCpuFields` — expansion до неизменных проверок ordinal, clock/PID/TID, canonical sec/nsec, valueNs == clockReads и monotonicity через repetitions. Carrier не получает authority принимать иной clock или endpoint | PASS |
| Отказ не стирает raw | Private runner helper 176–182 сначала вычисляет все encoded массивы; публикация начинается после полного успеха. При позднем отказе AggregateError содержит `raw: sample`. Callsite 591–600 расположен после engine measure, до публикации sample/journal; existing failed-sample журнал сохраняет error.raw | PASS |
| Измеряемое окно сохранено | Тело измерителя engine и все stock/legacy measurement owners сохранили bytes. RLE вызывается после завершения engineMeasure; нет переноса кодирования внутрь измеряемого интервала, вычитания overhead или иной работы положительного контроля | PASS |
| Bounds и делитель сохранены | `readServerSample`, outward arithmetic, family intervals, calibration и статистические владельцы byte-identical 088. 2000 ns reported-counter padding, 8 batches и положительные 4000 actual calls / divisor 2000 сохранены | PASS как preservation |
| Provenance и chronology сохранены | C/native wrapper, pinned headers, prepare/identity owners неизменны; journal validator byte-identical. Изменён rawEncoding в регистрации, поэтому прежний protocol digest не выдаётся за новый epoch | PASS |
| Контрпримеры и покрытие guards сохранены | Callback 1701 B и legacy native controls 4889 B самостоятельно найдены ровно по одному в обоих реальных immutable test SOURCE; fragments byte-identical. Healthy full-N/events/chain/stat constructors неизменны; новый fixture carrier готовится до events/hash | PASS как source preservation |

Упаковщик принимает конкретную plain-data область: обычный непустой массив без дополнительных полей/holes/accessors/proxy; endpoints — обычные объекты с точным набором и порядком полей. Такой отказ необходим для доказательства сохранности полей и key order. Пустой warmup массив возвращается неизменным. Legacy array decoder возвращает по identity и оставляет прежние полевые проверки consumer действующими. Непринятая область не нормализуется в успешное наблюдение.

Из 76 прежних top-level функций contract/runner/test 73 совпали побайтово. Три изменения: вставка expansion в `validateThreadCpuFields`, вызов private compaction в `runServerProfile`, подготовка CPU carrier в `admissionHistory`. Два codec exports и private helper добавлены; function bindings с исходными и новыми диапазонами/хешами сохранены. Самостоятельное сопоставление включает serializer chunks/digest/journal; значение их хешей из PRIMARY не служило proof без сравнения source fragments.

Пять новых test cases задают независимый вручную original/expected carrier: секунды выше 2^53, смену PID/TID, exact JSON roundtrip, отказ при forged valueNs/sequence и count/gap. Приготовление admission fixture применяет carrier к уже созданным здоровым raw до построения events и hash chain. N, рабочие объёмы, ordinal/order, статистические пороги и четыре callback falsifiers не меняются. Эти source tests не объявлены свежим whole-suite результатом reviewer.

## Величина, точность представления и статистические границы

Неизменный C считывает `CLOCK_THREAD_CPUTIME_ID`; неизменный JS wrapper сохраняет seconds десятичной строкой и целый nsec, формирует `BigInt(sec)*10^9+nsec`, проверяет main-thread PID/TID и монотонность. Number используется для безопасной разности после вычитания абсолютных BigInt endpoints. Сохранённые upstream Linux inputs показывают `CPUCLOCK_SCHED → task_sched_runtime` с обновлением pending runtime для текущей runnable task; это различает новый метод от прежнего stale RUSAGE пути.

`clock_getres=1 ns` не удостоверяет физическую точность. Upstream прямо не заявляет true resolution. Registration 96–97/129–130 и final docs 39–43 сохраняют 2000 ns как наружное расширение сообщённого счётчика и запрещают физическую интерпретацию nominal resolution или observed quantum. Getter/recorder overhead включён; вычитания overhead нет. Reported scheduled-runtime не является elapsed wall временем, frame p99 чистой библиотеки, GPU/energy или физической задержкой Android/iOS.

Наружные bounds применяются к каждому raw интервалу до CI; одинаковые envelope не уменьшаются через √N. Деление batch на зарегистрированные 2000 переводит единицы в стоимость полезного вызова. Прежние 11 metric cells, 8 repetitions, 292…1024 runs, парные blocks противоположного порядка, baseline-only выбор N, A/A bilateral 1/1.05…1.05, 2×work p50 lower >1.5 и protected p95 upper ≤1.05 сохранены. Tail probabilities p50=1/2, p95=19/20 и alpha-per-tail=1/1760 дают family-wise 0.05 при явном условии независимых одинаково распределённых block means. Этот review удостоверяет сохранение закона; actual мощность или calibration новой серии из этого не следуют.

## Собственный bounded различающий witness

Ровно один новый synthetic запуск, CPU1, таймаут ≤3 s: **START 2026-10-02 02:10:53.760821 UTC; actual END 02:10:53.844492 UTC; exit 0; timedOut false; allChildrenJoined; heavy 0 / queued 0.** Source HEAD фактического запуска — **5a4**, с точным final tree. Runtime inputs и stdout/stderr связаны в `witness.execution.json`; SUT, full callback, benchmark, зарегистрированная timing series, build/profile не исполнялись. Результат переносится на f647 по 639-file identity; `freshRuntimeAtFinalHead=false`.

1. Ручной четырёхточечный original и expected carrier независимо задают seconds `9007199254740993`/`9007199254740994`, переход nanoseconds 999999999→0 и metadata A→B→A. Actual carrier совпал с ручным, JSON roundtrip сохранил все семь полей/порядок побайтово; legacy array identity сохранена.
2. 13 source corruptions отвергнуты: forged valueNs/ordinal, дополнительные symbol/property/array field, sparse array, noncanonical seconds, -0 nanoseconds, иной prototype, field/array accessor и proxy array/endpoint. Accessor/proxy observer calls равны нулю.
3. 10 независимых consumer parity cases: два здоровых приняты в legacy и carrier вариантах, восемь повреждений отказаны. Absolute base `9223372030999999000` ns, безопасный интервал 2 ms с переходом секунды, 2×work сохраняет фиксированный делитель. Проверены timespec↔clockReads correlation, чужие endpoint/sample identities, межповторный rollback, missing endpoint, forged value/ordinal и неправильный 2×work divisor. Ранний отказ encoder у неверного источника является более ранним сохранённым отказом, а не успешным repair.
4. Семь отдельно повреждённых carrier отвергнуты: tuple mutation при неизменных clockReads, PID/TID, clock, count drift, gap, потерянный suffix и duplicate adjacent metadata run.
5. Captured actual private helper body выполнен с imported actual codec. Здоровые восемь raw batches кодируются. Forged последний endpoint вызывает AggregateError; все восемь исходных array references, весь исходный JSON и `error.raw === sample` сохранены. Это code-level witness private helper, а не полный runner run; производственный callsite отдельно прочитан source-only.

В inputs/outputs сохранены полные synthetic vectors, а не только pass flags. Witness script SHA256 `1ea422513abf492ef881598f826c0c537dcf7db3039dfa0cf4fd7cf05d83c7c6`; stdout SHA256 `4010cd708dc5ebe9741f4106cea82b47a250c52984df8bd985f22d141ad43955`; captured helper SHA256 `f01a58c37e598035a2ffb49d512842afb104878ed77dfdc51dd6cab7ca0d2b6d`.

Прежние собственные ABI/native fault/consumer witnesses 088 сохранены со своими настоящими timestamps и source hashes. Полные inputs ещё совпадают с исходными SHA256; они не объявлены свежим исполнением f647. Исторические PRIMARY executions/calibration/cost не используются как итоговый verdict новой серии.

## Конкретный readset и пределы

`readset.json` содержит новые source ranges, 84 исходные записи собственного readset 088 с классификацией переноса, UTC/hash/bytes и прямую final commit/tree область. `source-bindings.json` содержит отдельные 639 mode/blob/SHA256 bindings. Identity полного source corpus не заменяет semantic readset.

Новая прочитанная область: contract codec 177–248 и sample/CPU validator 290–386; runner helper/measure boundary 157–221 и publication/failure lineage 583–609; registration clock/model 70–140 и carrier diff; новый test codec 256–284 и fixture preparation 194–254; точные contract/runner/test/registration diffs; final server-profile docs полностью 1–73 и native README 1–17. Дополнительный прочитанный test контекст перечислен в машинном readset. Function/primary-fragment bindings фиксируют bytes сохранённых owners, а не подразумеваемое совпадение текста.

Прежняя source/kernel/ABI область 088 перенесена с исходными диапазонами, SHA256 и explicit transfer class. Для изменённых целых файлов transfer ограничен доказанно сохранёнными function fragments и отдельно прочитанной delta. Восемь нормативных файлов и 62 path bindings исходного logical readset проверены повторно по bytes/hash; ссылки на архивы/сырьё сохраняются через manifest.

PASS инвалидируется изменением проверенных codec/consumer/producer/clock/model/serializer/statistical bytes, units, metadata identity, denominator, clock correlation, stop rules, threshold или нарушением зарегистрированных runtime assumptions. Для другой toolchain/platform требуется её квалификация. Реальная новая A/A/2×work/A/B series, actual N/power/effect кандидата, host CI cost, весь M-04/M-05 и mobile/display/energy остаются отдельными обязанностями. Полный parent suite reviewer не повторял.

Все собственные scoped runtimes завершены. Итоговая actual UTC seal, exit/allEND и состояние heavy 0 / queued 0 находятся в `terminal.json`. После финального seal reviewer прекращает собственные exec.
