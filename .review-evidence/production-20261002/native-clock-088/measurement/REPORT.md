# Независимая проверка метода измерения Motion

**PASS** для одной оси: корректность перехода private server-profile с Node/RUSAGE на Linux `CLOCK_THREAD_CPUTIME_ID` в неизменяемом срезе `088fbc605c95fd6a6a7620301a450d6388386997`. Подтверждённых findings нет. Этот результат удостоверяет проверенный метод и его защитные условия; фактическая калибровка нового epoch, admission кандидата, весь PROFILE-01 и производственная готовность этим review не закрываются.

Намерение пользователя: полностью выполнить работы Lab Colors и Lab Motion по планам agents-config до производственного качества. Уточнение: Android недоступен, мощный iPhone не представляет целевую нагрузку; нужен содержательный серверный аналог проверки. Проверенный срез даёт измерение сообщённого scheduler runtime потока и сохраняет отдельные дальнейшие обязанности. Условия старых защищённых клеток не ослаблены.

## Объект, норма и изоляция

| Объект | Идентичность |
| --- | --- |
| HEAD | `088fbc605c95fd6a6a7620301a450d6388386997` |
| Tree | `ebc3c2ac51e957b5b1d4f7959feac36c6184fd2d` |
| Base | `185f02c2a85972a531627e14b7e0207e27855f95` |
| SOURCE archive SHA256 | `bc22b2359f3a8466a9daa9ced434f561525d120782ec7efeefbe2e57ff410db3` |
| Exact diff SHA256 | `c20b40756914d860d754188c97512dd2b83e3fbb86f089fe575b41ebe06b679f` |
| PRIMARY-MANIFEST SHA256 | `80e5dd4b030bbb8287416eb4b1372af7164801eacde39ed642a14a9ea86fec4a` |
| Method readset SHA256 | `7f234a2aff0925bb3315d49ed311455022834efead7f2fd84c5fa77613c26d2f` |
| Source manifest SHA256 | `81e832fa375a233931e26eb41dfd1624c14402292c5f9b75d325e8eb8fba3388` |
| Protocol / clock digest | `a7a3279d573e4ee9e5b9723eb351e53e93f468410a1652a103e1132ba6bd1570` / `04d863513d53b248b1be3e0905240f3bd6f4d06124582ce3093c2cbfe5320852` |

Проверены hash/bytes всех 93 ссылок PRIMARY и hash/bytes/Git blob ID всех 639 файлов SOURCE: несовпадений нет. Это проверка identity полного carrier; семантически прочитанная область перечислена ниже и в `readset.json`. Рабочие inputs находятся в `/tmp/motion-native-clock-successor-088fbc60-20261002`; собственный источник распакован только в каталоге этого review.

Норма прочитана из отдельных снимков `AGENTS.md`, `plans/SPEC.md`, `plans/TEMPLATE.md`, `plans/lab-motion-production/{ACTIVE,CLAIM,ACTIVATION,r11,r12}.md`; SHA256 сохранены в `initial-norm-sha.json`. Основные обязательства: AGENTS 119–143, r11 116–139/195–227/435–460, SPEC 17–78/269–305. `ACTIVE` указывает **r11 active**, CLAIM принадлежит r11/PROFILE-01; r12 прямо обозначен prepared successor. Его текст учитывается как заказанная область кандидата, а не как смена authority или право закрыть узлы.

Oracle: первичный SOURCE, точный diff, разрешённые raw/ABI/fault/contract inputs и независимо выведенная арифметика/контрпримеры. REPORT/HANDOFF автора, авторские объяснения и чужие verdict не читались. Поля наподобие `allPassed`/`expectedPass` в первичных execution JSON не использованы как ожидаемый результат. Числа из сводного diagnostic readback сверены с собственным пересчётом каждого raw endpoint.

## Результат по законам метода

| Проверяемый закон | Наблюдение и anchor | Диспозиция |
| --- | --- | --- |
| Величина и единицы | C 34–51 читает `CLOCK_THREAD_CPUTIME_ID`; registration 71–79/84–130 и docs 70–82 называют reported scheduled-runtime текущего main thread, единицы ns | PASS в этой области |
| Свежесть счётчика | Linux `posix-cpu-timers.c` 194–199/358–377/1667–1698 связывает thread clock с `CPUCLOCK_SCHED`; `sched/core.c` 5493–5534 добавляет pending runtime через `update_rq_clock` и `update_curr` для текущей runnable task | PASS; прежний stale RUSAGE путь устранён |
| Целочисленная точность | C отдаёт seconds десятичной строкой и nsec целым <10^9; JS 89–102 и runner 157–168 формируют `BigInt(sec)*10^9+nsec`; consumer 302–315 сверяет исходные поля и оба представления endpoint | PASS; абсолютный counter не превращается в Number до вычитания |
| Интервал и делитель | Stock validator methodology 37–68 ограничивает integer interval безопасным диапазоном и затем делит на зарегистрированные 2000; runner 220–260 сохраняет 8 batches, 2 warmups, outcomes и прежний divisor для 4000 actual calls положительного контроля | PASS |
| Порядок и идентичность | Consumer 302–315 проверяет sequence, PID/TID, clock, canonical sec/nsec и monotonicity через repetitions; 149–179/565–572 связывает samples с registration. Runtime wrapper хранит previous между reads; existing журнал 767–865 сохраняет порядок всех стадий и sample tuple | PASS |
| Происхождение | Wrapper 51–86 компилирует pinned C/headers до регистрации, связывает Node, binary, compiler/version/flags и libc; 104–110 повторно проверяет identity. Runner 489–554/603/662–675 проверяет её до samples, после стадий и в final-provenance | PASS |
| Никакого физического сертификата из nominal resolution | Kernel getres 167–173 возвращает 1 ns и прямо говорит, что true resolution неизвестна. Source registration 96–97/129–130 и docs 77–79 называют 2000 ns outward padding reported counter и запрещают физическую интерпретацию; `nominalResolutionIsNotErrorCertificate` проверяется consumer | PASS именно для stated reported-counter claim |
| Отказ закрывает admission | Native syscall/value errors явно throw; отсутствие compiler, иной platform/Node/worker, stale binary и drift прекращают подготовку. Runner начинает с UNPROVEN, сохраняет failure, не запускает A/B после негодной calibration; decoder 525–628/767–865 не допускает successful refusal | PASS |
| Прежняя статистическая приёмка | Diff сохраняет 11 клеток, seed/counts, 8 repetitions, 292…1024 runs, paired blocks противоположного порядка, baseline-only N, family alpha, p95 upper 1.05, A/A и реальное 2×work. Изменены clock fields/qualification и имя прежнего 2000 ns padding; threshold/stop rule не изменены | PASS как preservation; actual calibration ещё отдельно |

Worst-case outward envelope применяется к каждому исходному интервалу до CI. `meanBounds` 21–26 расширяет каждое сложение и деление наружу; в среднем одинаковые ±2000 ns интервальные envelope не становятся ±2000/√N. Stock деление на 2000 переводит единицы batch→call, а не уменьшает ошибку за счёт независимости. Последующие bounded order statistics и ratio используют наружные endpoints. Точные tail probabilities — p50=1/2, p95=19/20, alpha-per-tail=1/1760; 11×2×2×2 хвостов дают family-wise 0.05. Stationarity/independence blocks остаются явным условием протокола, а frames/repetitions не становятся независимыми участниками.

Getter overhead и одинаковое записывание evidence включены в измеряемую стоимость; вычитания overhead нет. Legacy CPU окна включают соответствующие host callbacks/reactions/recorder, stock — whole macro и preallocated per-operation stores. Эти результаты относятся к инструментированным зарегистрированным операциям. Frame p99 чистой библиотечной работы, browser/layout/paint стоимость и прошедшее wall время имеют отдельные estimands.

## Первичные различители и собственные witnesses

1. Диагностика сравнения часов: независимо пересчитаны все 32 пары из `diagnostic-raw.json`. Все fields derived readback совпали. Например, case 3 при `rusage-then-thread-clock` даёт RUSAGE 1000 ns, thread clock 1,763,594 ns и wall 1,763,891 ns; context-switch deltas равны нулю. При противоположном порядке case 7 — RUSAGE 1,684,000 ns и thread clock 1,683,845 ns. Вместе с upstream путём это различает stale pending accounting и обновление счётчика. Численная близость отдельных wall/CPU дельт **не** используется как физический error certificate.
2. Raw native fault controls: `errno.stdout` — `CLOCK_READ`; negative sec/ns и ns=10^9 — `CLOCK_VALUE`; large seconds `9007199254740993` сохранены C как строка без потери. Inspect C/wrap/control объясняет достижимость этих наблюдений. Existing preparation controls сохраняют реальные отказы missing compiler, worker, wrong Node/platform, stale binary и binary mutation.
3. Собственный immutable consumer witness, CPU3: два здоровых raw случая приняты, 17 ошибочных отвергнуты. Независимое ожидание задаётся целочисленными endpoints, не helper SUT. Absolute base `9223372030999999000` ns больше safe Number диапазона, interval 2,000,000 ns пересекает секунду. Отвергнуты ранний Number conversion, чужие source/PID/TID, malformed sec/nsec, forged value, sequence/missing endpoint, согласованный rollback между repetitions, unsafe interval и positive 2×work с неправильным divisor. `consumer-witness.execution.json`: **01:06:27.720833–01:06:27.775432 UTC**, exit 0/allEND.
4. Первый собственный synthetic attempt имел overlapping здоровые 2×work intervals: gap 3 ms при interval 4 ms. Consumer правильно отказал за межповторный rollback; этот запуск exit 1 сохранён целиком как `consumer-witness-attempt1.*`. Исправлен только собственный gap до 5 ms; это не RED продукта, не повтор registered серии и не изменение guard.
5. Собственный actual native ABI witness из immutable SOURCE, CPU3: prepare, ровно два reads, самостоятельная sec/nsec арифметика, PID=TID=current process, monotonicity, `assertUnchanged`. **01:12:00.695811–01:12:01.105149 UTC**, exit 0/allEND. Native binary SHA `21bb3221b35523770ee025546c5e4fadb8bd7a64627a65147bd23ca48ac6c76a` совпал с existing green ABI primary. Node executable SHA совпал с pinned `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`. SUT, arithmetic load или timing series в этом witness не исполнялись; никакой performance claim из этих двух reads не сделан.

Existing affected contract runner raw содержит 191 passed / 0 failed / 0 pending. Это дополнительное primary evidence, не независимый oracle: его registration/contract/test/C/wrapper hashes совпадают с SOURCE, а runner/docs hashes отличаются от окончательного среза. Exact-head whole suite не повторялась и за неё этот report не выдаёт старую квитанцию. Собственные consumer и ABI witnesses применены непосредственно к immutable bytes этого review.

## Конкретный readset и границы

Логический readset с SHA256, UTC и диапазонами строк: `readset.ndjson` / `readset.json`. Проверка bytes всей входной поставки: `integrity.json`. Основные source owners:

- `server-thread-cpu-clock.c` и `.mjs`: полностью.
- `server-profile-registration.mjs`: 1–132, 136–183; exact diff полностью в относящихся к clock hunks.
- `server-profile-contract.mjs`: 1–110, 145–315, 318–341, 447–657, 763–865; clock/identity diff полностью.
- `server-profile-runner.mjs`: 155–277, 489–680; producer/preparation/statistical-stage diff полностью.
- `scripts/bench-transform-support.mjs`: 166–210, 267–335, 419–482; источник actual endpoint порядка, измеряемой работы и replay.
- `bench/compare/methodology.mjs`: 1–98; whole-macro raw/denominator владелец, плюс импортируемый неизменный statistical owner в immutable carrier.
- `test/server-profile-contract.test.ts`: 1148–1249; рассмотрены target mutants и регистрационные условия, собственный witness выведен отдельно.
- `docs/server-profile.md`: 1–111; `native-clock/README.md`: полностью; `native-clock/include/node_api.h`: 1–91 и найденные объявления NAPI; все четыре header identity проверены по bytes.
- Pinned Linux kernel: `posix-cpu-timers.c` 158–207, 358–380, 1667–1700; `sched/core.c` 5468–5542; `sched/cputime.c` 624–634; kernel config и raw clock metadata.
- Первичные diagnostic C/raw/execution, API raw/execution, native fault wrapper/control/stdout/execution, preparation controls и affected contract runner fields, перечисленные машинным readset.

Этот PASS инвалидируется изменением checked source/model/header/runtime bytes, units/clock/identity/denominator, нового protected metric, method/stop rules или нарушением зарегистрированных clock/platform assumptions. Компилятор, Node и libc квалифицируются наблюдёнными bytes; отчёт не доказывает произвольную другую toolchain. Не проверены реальная новая A/A/2×work/A/B series, мощность её данных, эффект кандидата, phone/display/energy, весь M-04 envelope и M-05 продуктовые семейства. Эти пределы не превращены в успешный допуск и не являются finding этого узкого изменения.

Product, нормы, tests/config/thresholds не редактировались. Full suite/registered timing series/performance pilot не запускались. Все scoped child executions завершились; точный момент закрытия и состояние **heavy 0 / queued 0 / allEND** находятся в `terminal.json`. После финализации reviewer прекращает собственные exec.
