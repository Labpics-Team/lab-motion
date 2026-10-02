# Независимая проверка измерительного закона, тестов и native ABI CI

**PASS** для одной оси immutable `fe092331360837fd7f63d71a4b7f867ba849ebd4`: доказательная сила admission tests, фактический native API/ABI и его обязательный CI путь, сохранение измерительного закона и prerequisites. Подтверждённых findings нет. Общий GO, production readiness, успешную новую calibration/admission, физическую точность часов или Android/iOS этот результат не удостоверяет.

Пользователь хочет полностью выполнить Lab Colors/Lab Motion по agents-config до производственного качества. Android недоступен, мощный iPhone нерепрезентативен; нужен содержательный серверный аналог. Эта ось проверяет честность серверного метода и его приёмки. Reviewer выполнял только source/primary чтение и собственные вычисления над bytes/JSON на CPU2. Новый SUT, native execution, build, full suite, profile или performance series reviewer не запускал.

## Source identity и норма

| Объект | Идентичность |
| --- | --- |
| HEAD | `fe092331360837fd7f63d71a4b7f867ba849ebd4` |
| Tree | `285e30e36db32f2fdc9ae442327f6b3396dcf254` |
| Effective diff base | `f6476ae990254f606faf97f80afe41965bec2fb2` |
| Literal immediate parent | `95a42651244c5279b0f688eaf236e39ec31724b0` |
| SOURCE tar SHA256 | `a91db3d664b91a7e169a49de4794fa7150064f35fe281a6a2b6fec2fd6023709` |
| Exact diff SHA256 | `6700f7b29e449eaaace6e386be0a05e18cbfe6891f7b8192b762704fb0872deb` |
| PRIMARY SHA256 | `4184a52ea58d4f3b27e7cd4c571425c51efda578f1a283b2aab396dd0659e29e` |
| Fresh gates supplement SHA256 | `ed166f092eb854a1c8317d835dbe2035f96ae527837a7e7bb1eb9204419895c1` |

Самостоятельно проверены 641 file mode/Git blob/SHA256 bindings и реконструирован бинарный Git root tree. Он побайтово совпал с literal `tree.raw`; OID tree и commit совпали с заданными TREE/HEAD. 634 файла совпали с собственным sealed f647 SOURCE, пять изменились, два добавлены. Все семь supplied diff sections точно применились **в памяти** к собственным f647 bytes и дали final SOURCE. f647 — effective comparison base; он не выдан за непосредственного родителя commit.

26 исходных PRIMARY refs и отдельный previousPrimary pointer — 27 bindings; ещё 27 refs fresh supplement прошли bytes/hash binding. В собственном каталоге сохранены snapshots. Проверка identity всего carrier не означает семантическое чтение каждого файла.

Восемь нормативных файлов повторно совпали с собственными sealed f647 snapshots: `AGENTS.md`, `plans/SPEC.md`, `plans/TEMPLATE.md`, `plans/lab-motion-production/{ACTIVE,CLAIM,ACTIVATION,r11,r12}.md`. r11 остаётся active/PROFILE-01, r12 prepared. Применимы AGENTS 119–143, r11 INV-01/06/09/10 и прежние PROFILE constraints. Авторские REPORT/HANDOFF/rationale, чужие/bot verdict и author parsed-results не использовались. Авторский conservation-result не заменял собственное сопоставление. Reviewer не изменял source, нормы или оригинальные evidence.

## Admission: пять законов, полный setup и timeout

Старый callback f647 1002–1020 содержит **пять** отрицательных проверок: early calibration, opposite pair order, failure union, positive stage name, final raw digest. Название старого теста упоминает четыре reviewer counterexamples; это не точный счёт всех его assertions. Все пять соответствующих statement blocks, включая создание повреждения и `toThrow` predicate, побайтово найдены в final test. Сохранены и два healthy assertions: полный artifact verdict PASS и journal final digest.

`stage`, `healthyAdmission`, `admissionEvents`, `chain`, `admissionHistory` побайтово совпали с f647. Test file за пределами разделённого callback совпал, кроме type-only импорта `TestContext`. Нет уменьшения N, rows, clocks, работающих calls, repetitions, positive multiplier, метрик, порядка или сохраняемого raw; нет нового skip/only/exclude/allowlist. Fault branches по-прежнему строят новые arrays/objects и сохраняют исходную здоровую историю.

Final 1002–1050 разделяет прежнюю группу на **шесть timed tests**: полный healthy setup/validation и те же пять falsifiers. Первый вызов `admissionHistory()` в файле принадлежит healthy timed test; setup не вынесен в untimed hook. Каждый dependent case вызывает `acceptedAdmission()`, который требует `healthyAdmissionTask.result.state === 'pass'`. Он не создаёт отдельную более дешёвую healthy историю. Framework timeout или иной отказ healthy prerequisite приводит к отказу зависимого case; отсутствие prerequisite при фильтрации/ином порядке также не становится skip или PASS. Default последовательность подтверждена неизменным Vitest config и отсутствием concurrent markers.

**Timeout budget изменён явно:** старый callback имел 30 s на setup и все проверки вместе; теперь шесть cases имеют по 30 s, то есть формальный суммарный максимум этой группы — 180 s. Прежний aggregate 30 s не сохранён. CI job cap 60 min и остальные test/config budgets не изменены. Это разделение самостоятельных законов при сохранении полного timed setup и всех проверок; не доказательство прежней суммарной стоимости и не основание объявить CI cost улучшенным.

Первичный старый CI log фиксирует genuine f647 отказ: bundled case 32,154 ms и `Test timed out in 30000ms`; это не скрытый semantic PASS. Fresh exact-fe local `whole.json` содержит server-profile **201** cases вместо прежних 196: +5 соответствует замене одной группы шестью. Все шесть нужных cases passed с пустыми failureMessages: healthy **17,380.698 ms**, затем **2,061.677 / 2,114.782 / 31.441 / 3.048 / 2,391.195 ms**. Raw whole command не имеет test-name фильтра, timeout override или retry. Receipt: fe092, START 03:34:01.745216, END 03:35:41.110457 UTC, exit 0. Это существующий fresh local primary, а не собственный новый запуск reviewer и не удалённый GitHub CI fe092.

## Native API/ABI: настоящий путь и различающие controls

Новый fixture `test/fixtures/server-thread-cpu-clock-check.mjs` 1–144 использует actual C, четыре pinned Node-API headers и реальный Node module ABI. `actual-api` импортирует неизменный private owner, проверяет read-before-prepare refusal, prepare, main-thread PID/TID, exact endpoint arithmetic, продвижение counter, `assertUnchanged`, повтор prepare и отказ после изменения native binary. Отдельные child modes проверяют worker, stale binary с сохранением original и missing compiler. Неподходящие Linux/x64/Node prerequisites приводят к assertion/refusal; автоматического skip нет.

Native host C 1–43 перехватывает syscall boundaries через linker `--wrap`, не заменяет getter JS mock. Независимые ручные значения: seconds `9007199254740993`, nanoseconds 17, PID/TID actual child process и nominal resolution string `1`. Они различают раннее Number conversion. Восемь fault modes проверяют read errno, отрицательные seconds/nsec, nsec=10^9, отрицательные PID/TID, getres errno и zero resolution.

Шесть compiled C mutants меняют clock kind, удаляют read errno guard, timespec guard, PID/TID guard, заменяют seconds string на Number и удаляют getres errno guard. Reviewer самостоятельно реконструировал каждый mutated C byte string и сверил его SHA256 с raw record. Все шесть достигли ABI oracle и завершились exit 1 с конкретным AssertionError, а не принятой compilation failure. Healthy wrapped ABI завершился exit 0. Поля `killed`/`controls` не использованы как oracle вместо source/exit/error проверки.

Actual native primary START **03:21:15.912033**, END **03:21:17.430487 UTC**, exit 0, timedOut false. Его frozen head label — **f647**, однако все шесть frozen input files, включая новые fixtures и CI files, точно совпали с final fe092 bytes. Все пять native C/header hashes также совпали. Поэтому API/ABI evidence переносится по scoped input identity; оно не объявлено fresh execution exact-fe commit или собственным reviewer execution.

Raw actual endpoints самостоятельно пересчитаны: `174687001` и `174882012` ns, delta **195011 ns**, одинаковые PID=TID=702150. Node `v24.19.0`, executable SHA `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`; actual native binary SHA `21bb3221b35523770ee025546c5e4fadb8bd7a64627a65147bd23ca48ac6c76a`. Это functional ABI/provenance smoke. Loop 8192 и two reads не являются performance sample, error calibration или сертификатом физической точности.

Coverage ограничено названными actual API modes, восемью fault modes и шестью mutations. Оно не объявлено исчерпывающей проверкой всех N-API allocation failures, всех ОС/toolchains, всех host faults или всех путей compiler/libc drift. Прежние guards этих владельцев сохранены по bytes и остаются prerequisites профиля.

## Обязательный CI путь и сохранённый измерительный закон

Workflow 142–202 сохраняет обычный suite/fuzz на Node24 и добавляет отдельный setup **Node24.19.0** с pinned action SHA, затем прямой `node test/fixtures/server-thread-cpu-clock-check.mjs`. У шага нет optional condition, continue-on-error или success wrapper. CI graph contract независимо требует новый command и exact setup action/index/version; прежний fail-closed final job требует success tests peer. Все прежние команды/peers/browser shards сохраняются. Whole raw содержит 94 CI-contract cases и passed assertion обязательного native graph.

Production clock C/JS, pinned headers, registration/clock model, codec/consumer, measurement runner, statistical/size/time owners совпали с f647. Поэтому собственное прежнее доказательство переносится в прежней области: `CLOCK_THREAD_CPUTIME_ID` — reported scheduled-runtime main thread; seconds string и BigInt сохраняют точное представление; PID/TID/order/provenance/correlation и fail-closed conditions сохраняются. Номинальное `clock_getres=1 ns` не даёт физической точности. Сохранённые 2000 ns — outward padding reported counter, без shrink через repeats/N и без overhead subtraction.

Прежние 11 cells, 8 repetitions, N 292…1024, paired opposite-order blocks, baseline-only selection, A/A bilateral 1/1.05…1.05, real 2×work, p50/p95 и protected p95 upper ≤1.05, family alpha/stop rule не изменены. Новый ABI step не исполняет registered calibration/series и не заменяет эти законы своим успехом. Core/recipes consumer import не получает обязательный compiler: instrumentation остаётся private test/bench path.

Новые browser recipe tests дополняют восемью состояниями sheet/pager × important/plain/none/absent. Healthy `select(1)` обязан реально дать 120/-240 px до late competing stylesheet; after destroy дважды проверяются value/priority/presence и видимая CSS поза. Это различает потерю inline `!important`; expected pose не извлекается из результата recipe. Fresh raw содержит 24 нужных passed results в Chromium/Firefox/WebKit, без skip/retry. Scope новых tests — восстановление inline CSS при `motion:'none'`; нулевое число animations здесь не объявлено отдельным доказательством отмены live WAAPI. Прежние browser tests сохраняются; функциональные результаты не являются timing/mobile/display proof.

## Readset, raw bindings и пределы

`readset.json` содержит UTC/hash/bytes/ranges новых чтений и явную scoped transfer ссылку на собственный sealed f647 proof. Основная новая область: все семь exact diff sections; native fixture/host целиком; unchanged C/JS clock целиком; workflow 113–213; CI validator 294–418; Vitest config целиком; old callback 1002–1020 и new 1002–1054; native frozen/execution/controller и structured raw records; fresh whole controller/receipt и individual target assertions; новые browser raw results. Нормативные snapshots/identity, source tree и full carrier bindings отделены от semantic readset.

Собственные `admission-conservation.json`, `diff-bindings.json`, `native-primary-independent-readback.json` и `source-bindings.json` сохраняют вычисленные proof details и исходные SHA256. `MANIFEST.json` / `all-bindings.json` связывают SOURCE, original/fresh primary snapshots, собственные вычисления и transfer dependencies. Author conservation/parsed-results файлы только bound по hash, без заимствования их выводов. Older f647 whole/cost verdict не выдаётся за current source execution.

PASS относится к проверенным bytes и описанным prerequisites. Изменение source/config/test sequencing/clock model/counts/denominator/threshold/stop rule или другой runtime/environment требует соответствующей квалификации. Фактическая новая server A/A/2×work/A/B, candidate effect/power, remote fe092 CI, весь M-04/M-05 и physical Android/iOS остаются отдельными обязанностями. Source/primary review не является overall GO.

Все собственные действия были source-only. Literal actual UTC source-only finalization END, exit/allEND и heavy 0 / queued 0 сохранены в `terminal.json`; после seal reviewer прекращает собственные exec.
