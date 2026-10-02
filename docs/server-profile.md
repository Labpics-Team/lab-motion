# Серверная клетка PROFILE-01

Роль: справка (Diátaxis).

Профиль измеряет сообщённое Linux время исполнения потока Node и стоимость
публичного API браузера. Он использует существующие владельцы `bench/compare`.
Физические Android/iOS, экран60/120Гц, GPU и энергия остаются `UNPROVEN`.

## Подготовка и запуск

Нужны Linux6.18.44/x64, Node24.19.0, Chromium149.0.7827.55 и `pnpm@11.11.0`
первым в `PATH`, зависимости root и `bench/compare` из frozen lock, C11 compiler
и Linux libc. Binary и source hashes проверяются до samples. Firefox/WebKit
здесь не имеют зарегистрированной clock model; их функциональные проверки отдельны.
Baseline — clean `0b6f537e148b7dadadfb9e3ce7c446d014975958`, candidate также clean.
Во время pilot, A/A, positive и A/B на хосте не запускают параллельные suites.

```sh
taskset -c 0 node bench/profile/server-profile-runner.mjs \
  --baseline /path/to/baseline --candidate /path/to/candidate \
  --browser chromium --out /outside/checkout/server-chromium-registration-1
```

Каталог результата должен отсутствовать. Повтор серии ради GREEN запрещён.
Смена метода требует новой регистрации с сохранением старого raw и отказа.
Пакеты baseline/candidate, comparators и их dependency closure сначала упаковываются;
потребители используют actual tarballs, а не исходники или workspace imports.

## Сцены и знаменатели

Семейство содержит11 клеток: две legacy engine сцены ×3 метрики, stock C ×1,
две browser сцены ×2. Полные параметры задаёт `SERVER_PROFILE` в
[server-profile-registration.mjs](../bench/profile/server-profile-registration.mjs).

| Сцена | Полезная работа | Знаменатель |
| --- | --- | --- |
| `scalar-live-100` |100 живых scalar retargets; start/frame/cancel-drain |8 повторов |
| `transform-fresh-1000` |1000 свежих targets ×7 transform channels |8 повторов |
| `motion-value-default-stock-c` |штатные constructor0/onChange/setTarget100/drain47/destroy/return100 |8 batches по2000 операций |
| S2/S3 |start/cancel:100/200 targets, stagger0/5ms, duration128ms, endpoint300px |8 batches по32 вызова |

Stock C использует main-entry `MotionValue`, прежнюю default bounded spring
`{mass:1,stiffness:170,damping:26}` и существующий `scripts/bench-support.mjs`.
Factory и две warmup batches по2000 находятся вне CPU. Каждая операция сохраняет
свои47 frames и endpoint100; среднее47 или checksum100 не заменяет oracle.
Positive делает4000 stock C операций или64 browser вызова; divisor остаётся2000/32.
Recorder включён одинаково обеим ролям; RLE и oracle выполняются после CPU.
Канонические1200ms guards независимы; S2/S3 не доказывают reorder/list и семьиM-05.

## Регистрация и допуск

До первого sample закрепляются source/package/toolchain/browser/harness identity,
CPU affinity/quota, native getter, clocks, workload и правила остановки.
Один baseline-only pilot планирует N до candidate samples. A/A и настоящая2×work
проверяют разрешимость; A/B начинается только после PASS calibration.
N292…1024 содержит146…512 независимых paired blocks противоположного порядка.
p50/p95 относятся к среднему блока, а не отдельному вызову, frame p99 или FPS.
Точные биномиальные интервалы используют family-wise95% и alpha-per-tail1/1760.
Protected p95 upper≤1.05, MDE5%, power0.8, counts, seed и старые budgets сохраняются.
Неразрешимость, ошибка или превышение ресурса дают `UNPROVEN`, без добора к GREEN.

Resource controls снимают все6 safe counters `cpu.stat` и `cpu.max` до samples,
затем до/после каждого блока. Affinity/quota связаны с зарегистрированной machine;
throttling delta должна быть0. Исторические counters не принимаются за текущую delta.
Ранее известный exploratory stock wall7.2k→8.3k ns указан в `exploratoryPrehistory`;
`candidateSamplesObserved:false` относится только к текущему protocol epoch.

## Часы и полезный исход

Engine использует частный NAPI getter `CLOCK_THREAD_CPUTIME_ID`: Linux-reported
scheduled-runtime main-thread. Сохраняются seconds строкой, nanoseconds∈[0,10^9),
sequence, PID/TID и valueNs. Потребитель заново выводит `seconds*10^9+nanoseconds`
через BigInt, сверяет clockReads, identity и отсутствие обратного счётчика.
Native C/четыре официальных NAPI header, binary, Node, compiler/version/flags и libc
регистрируются до работы. Pure import не требует compiler/native binary.

Прежние2µs остаются консервативным наружным расширением reported counter;
это не физическая точность и не вывод из nominal `clock_getres`.
Getter overhead включён и не вычитается. Прежний RUSAGE/Node clock дал устаревший
runtime на известной работе; его исходники, warmup plateaus и отказ сохранены.
Актуальная Linux цепь — `cpu_clock_sample(CPUCLOCK_SCHED)`→`task_sched_runtime`;
source pins находятся в `SERVER_PROFILE.clockError`.

Browser использует isolated realm-local `performance.now`: elapsed API с scheduler/GC.
Обе clock reads и binary64 погрешность входят в pointwise bounds до CI;
усреднение не уменьшает worst-case clock envelope. DOM allocation вне start,
start/retarget/frame/cancel-drain и heap наблюдаются в своих областях.
Normal-motion control сохраняет fresh0→300 onset, первую CSS0 публикацию,
три checkpoints, terminal и document/rAF/perf chronology. Неопределённое окно
не доказывает правильную длительность. После cancel все attached targets
неподвижны и без WAAPI два rAF. Swallowed vendor exceptions adapter не наблюдает.
Подробные oracles принадлежат [methodology.mjs](../bench/compare/methodology.mjs)
и [bench-transform-support.mjs](../scripts/bench-transform-support.mjs).

## Результат и независимая проверка

Каталог хранит `server-profile.json`, внешний `server-profile.sha256`,
`journal.ndjson`, raw controls, packages, adapters и native qualification.
Все samples и приобретённые failure prefixes сохраняются; нет pruning по исходу.
Журнал связывает preregistration→N→calibration→A/B, порядок участников и failure union.
Декодер поддерживает max-N carrier; lossless RLE/gzip не меняют расширенные данные.

```sh
node bench/profile/server-profile-contract.mjs \
  --raw /outside/checkout/server-chromium-registration-1/server-profile.json \
  --digest '<64 hex из независимо сохранённого server-profile.sha256>' \
  --journal /outside/checkout/server-chromium-registration-1/journal.ndjson
```

Admission принадлежит [server-profile-contract.mjs](../bench/profile/server-profile-contract.mjs).
Forced GC разрешён только отдельному retention child после timing: host turn через
`setImmediate`, затем два GC у каждого heap snapshot; stock C делает2×2000 warmups
и8×2000 проверенных операций. Отрицательные heap deltas сохраняются. Это наблюдение
пакета/oracle/harness, не точная атрибуция утечки или стоимость GC внутри CPU.
Исторические версии протокола и все FAIL epochs остаются в исходных архивах;
новые результаты не распространяются на другой method/source/package tuple.
