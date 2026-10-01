# Серверная клетка PROFILE-01

Профиль даёт воспроизводимое измерение CPU потока Node и публичного API браузера
на закреплённом Linux-сервере. Он дополняет существующий `bench/compare`, использует
его production-адаптеры, изолированный origin, provenance и парные порядки.
Физические Android/iOS, энергия, GPU и экран 60/120 Гц остаются `UNPROVEN`.

## Запуск

Нужны закреплённые Node 24.19.0, Linux 6.18.44, Chromium 149.0.7827.55 и
фактический `pnpm@11.11.0` в `PATH`, зависимости root и `bench/compare` из
frozen lock. SHA256 executable входят в зарегистрированную clock model.
Иная версия или binary дают отказ до samples. Clock model Firefox/WebKit здесь
`UNPROVEN`; функциональные проверки этих движков независимы. Baseline — clean checkout
`0b6f537e148b7dadadfb9e3ce7c446d014975958`; candidate также должен быть clean.
Хост на время pilot, A/A, positive и A/B освобождается от параллельных suites.

```sh
taskset -c 0 node bench/profile/server-profile-runner.mjs \
  --baseline /path/to/baseline --candidate /path/to/candidate \
  --browser chromium --out /outside/checkout/server-chromium-registration-1
```

Каталог результата должен отсутствовать. Заново использовать его нельзя.
Смена условий или метода требует новой регистрации с сохранением старого отказа;
повтор той же серии ради зелёного результата запрещён.

Пакеты baseline, candidate и vendor dependency closure сначала упаковываются с
отключёнными publish scripts. Адаптеры и engine импортируют извлечённые consumer
архивы. В регистрацию до samples входят exact source SHA, package/lock inputs,
runtime, harness/adapter hashes, весь browser tree, toolchain, CPU affinity,
ядро ОС, лимиты cgroup, viewport/DPR и все знаменатели. Регистрируются две engine
сцены: 100 scalar live retarget и 1000 targets × 7 transform channels fresh.
Engine использует `animate`; изменение default bounded `MotionValue` hot loop
требует отдельного evidence существующего bench C owner.
Browser S2/S3 измеряют start/cancel общего transform API; они не доказывают
семантику reorder/list или две продуктовые семьи M-05. Длительность этого нового
узкого API-профиля — 128 мс, 100/200 targets, stagger 0/5 мс. Его числа не
подменяют прежние canonical 1200 мс или их guards; стоимость генерации артефакта
может зависеть от duration. Все участники получают одинаковые параметры.

Перед timing существующий `runSemanticStartCheck` снимает три промежуточных CSS
матрицы одного нормального вызова с теми же targets/duration/stagger/to и
проверяет всю топологию через общий oracle. Каждый checkpoint сохраняет actual
rAF timestamp и обе границы CSS read window. Между окнами oracle проверяет
линейную скорость каждого наблюдаемого interior target при зарегистрированной
duration. Общая постоянная фаза сокращается; прежняя stagger topology также
проверяется. Controls различают duration 64/128/256 мс и нелинейную форму; три
конечных checkpoints не доказывают все возможные функции между наблюдениями.
S2 checkpoints назначаются на 0,25/0,5/0,625 duration, S3 — на 0,2/0,5/0,8
меньшего из duration и delay span. Насыщение endpoint или задержанный rAF,
не оставивший наблюдаемый участок, даёт отказ, а не широкий допуск.
Endpoint300 без промежуточного движения не принимается. Каждая timed серия содержит восемь batches:
32 настоящих вызова под одной парой clock reads для start и другой для cancel.
Positive выполняет 64 вызова; знаменатель остаётся 32. DOM allocation и наблюдения
находятся за границами этих интервалов; стоимость цикла и управления owners
включена. После start сохраняются первые targets всех owners до отмены: окно
чтения обязано предшествовать линейному endpoint с учётом clock uncertainty.
Это обнаруживает также stateful snap в timed path. Полный normal-motion trace
относится к отдельному контрольному вызову; конечный набор controls не доказывает
все возможные stateful поведения. После cancel наблюдаются все 32/64 группы.

## Разрешимость и допуск

Baseline-only pilot содержит восемь runs. Единственной независимой единицей
является блок двух противоположных порядков; восемь внутренних повторов и кадры
не увеличивают число независимых наблюдений. До калибровки сохраняется N из
парного log-contrast, MDE 5% и мощности 0,8. Tail заранее задаёт минимум 288 runs
(144 независимых блока). При N выше ресурсного предела 1024
диагностические controls сохраняются, а admission остаётся `UNPROVEN`.
Эта приближённая формула планирует средний контраст и не обещает мощности tail.

Одна A/A серия того же build должна удержать двустороннюю полосу
`1/1.05…1.05`; deliberate 2×actual work должен дать нижнюю границу p50 >1,5.
Порядковые интервалы строятся из средних двух runs каждого блока. p50/p95 относятся
к распределению этой средней стоимости блока, а не кадров или отдельных API-вызовов.
Точная биномиальная масса считается в BigInt для q=1/2,19/20. Bonferroni по
10 клеткам × 2 квантилям × 2 участникам × 2 tails даёт alpha каждого tail=1/1600.
При 143 блоках upper p95 ещё не ограничен; 144 — первый допустимый размер.
Семейное 95% покрытие условно на независимые одинаково распределённые блоки
закреплённой клетки. Protected p95 upper остаётся ≤1,05.
Негодная calibration сохраняет `UNPROVEN` и не запускает A/B.

До/после каждого парного блока сохраняются настоящие affinity, cpu.max, loadavg,
cpu.stat и его DELTA. Cumulative историческое throttling не считается текущим.
Изменение affinity/quota или ненулевая delta nr_throttled/throttled_usec запрещает
admission. Каждый snapshot сравнивается с identity зарегистрированной machine,
в том числе при стабильной смене CPU/quota между блоками; final provenance также
проверяет эти условия. Все samples сохраняются, post-hoc удаления и добора нет. Пять разрешённых
CPU не означают пять доступных полных ядер при cgroup quota четырёх CPU.

Engine clock — `process.threadCpuUsage`: user+system CPU текущего потока,
с отдельными start/retarget, средним frame и cancel/drain. В timing остаются
микрозадачи исполнителя; самостоятельная проверка oracle находится за границей
этих интервалов. Переключения потоков и ожидание не выдаются за engine CPU.
Browser clock — изолированный realm-local `performance.now`; возвращаемые
интервалы — elapsed API, они включают вмешательство scheduler/GC. Холодный import,
warm start, endpoint и cancel сохраняются раздельно. После normal-motion control
следующий endpoint-вызов называется `control`, а не холодным start.

Observed quantum из before/after probes является control, а не доказательством
погрешности. В pinned Chromium isolated TimeClamper округляет как вверх, так и
вниз в пределах 5us; Linux TimeTicks сначала отбрасывает меньше 1us. Интервал
получает консервативную погрешность двух endpoints `2×(5+1)=12us`. В raw остаются
обе timestamp reads, а не только их разность. Дополнительно учитываются
binary64 conversions(now/origin), обе subtraction для reads и subtraction
интервала. Общий Linux CLOCK_MONOTONIC upper bound снимается Node hrtime после
browser reads; counters≥2^42ms и несовместимые readings запрещены. Модель
предполагает общий monotonic clock без namespace/clock overrides и соответствие
закреплённых binaries приведённому upstream source.

Linux `getrusage(RUSAGE_THREAD)` отбрасывает дробную microsecond отдельно для
user/system; ошибка разности их суммы ограничена 2us. Node поля должны быть safe
integers и переводятся в BigInt по отдельности. Эти engine интервалы, включая
каждый frame, получают pointwise bounds. Browser interval делится только на
base 32. Усреднение repeats/runs не уменьшает worst-case clock error как
независимый noise: наружное округление распространяется через все суммы,
деления, средние блока и ratios. Exact order-statistics owner берёт lower ranks
из pointwise lower observations, upper ranks из upper observations. Нулевой
lower bound не даёт ограниченного ratio. A/A, 2×work и NI используют уже эти
границы; при недостаточном разрешении остаётся честный отказ. p95 относится к
распределению средней цены двух runs, каждый из восьми batches/32, а не
индивидуальному вызову, frame p99 или FPS.

Первичные clock sources с версиями и SHA256 закреплены в
`SERVER_PROFILE.clockError.sources`: Chromium149 `time_clamper.{cc,h}`,
`performance.cc`, `time_now_posix.cc`; Node24.19 `node_process_methods.cc` и
vendored libuv; Linux6.18.44 `kernel/sys.c`, `kernel/time/time.c`.

После каждого browser cancel attached targets остаются в DOM для самостоятельной
проверки: нет WAAPI и transform каждого target неизменен два последующих rAF.
`cancelMs` измеряет синхронный API; `cancelDrainMs` сохраняет наблюдаемый elapsed
до этого checkpoint, включая два rAF, DOM oracle и harness callback. Он не
приписывается чистому CPU пакета. Успешный return без этой неподвижности даёт отказ.
Нормализованные existing adapters уже ловят vendor cancel exceptions. Профиль
сохраняет ошибки measurement и наблюдаемое нарушение семантики; он не может
восстановить уже swallowed underlying exceptions или доказать отсутствие эффекта
после более долгого незарегистрированного окна.

Heap/GC — наблюдения пакета, oracle и harness, без ложной точной атрибуции.
Forced GC применяется только после timing в отдельном retention-процессе.
Отрицательные retained heap delta сохраняются; отношения с нулевым/отрицательным
знаменателем не вычисляются. Статические byte и численные guards принадлежат
прежним владельцам и этим профилем не ослабляются.

## Проверка и хранение результата

Все warmup/pilot/control/A/B samples, ошибки и частичные отказы сохраняются в
`journal.ndjson` с цепью digest; итог — `server-profile.json` и внешний
`server-profile.sha256`. Журнал проверяет фактический порядок регистрации,
замораживания N, завершения controls, фактического порядка и допуска A/B. Имя
positive привязано к владельцу artifact, одиночная работа не заменяет 2×work.
Failure union и финальный digest связываются с журналом. Успешный engine raw
хранит все 16 clock endpoints вместе с actual user/system полями, ordered
scheduler times и lossless target CSS/write traces. Существующий lifecycle owner
пересчитывает интервалы из BigInt endpoints, координаты из independent linear
oracle и trace hashes из сохранённых строк. Микросекундные user/system fields
связываются с каждым endpoint по sequence; невозможный ns interval не допускается.
Engine failure хранит точный приобретённый prefix тех же данных, все
operation/frame интервалы, открытую границу cancel, семантику до и после cleanup
и original causes. Browser failure сохраняет
acquired batch clocks, начатых/отменённых owners и partial semantic checkpoints;
нечисловые приобретённые значения отмечаются явно. Cleanup failure не заменяет
первую ошибку. Итоговые метрики пересчитываются из raw; пропущенный
участник, смена знаменателя, invalid oracle или clock evidence отвергаются.
Одинаковые target trace hashes упаковываются lossless как count+hash; расширенная
длина обязана совпадать с числом targets сцены. То же lossless count+value применяется
к одинаковым CSS координатам cancel witness. Остальные координаты и normal-motion
позиции сохраняются lossless RLE; expanded длина каждой группы проверяется до
прежнего semantic oracle. Timing samples не сокращаются. Итоговый compact JSON
пишется по отдельным rows с потоковым digest: полный raw не обязан помещаться в
одну строку V8. Журнал и внешний digest связывают точные записанные bytes.
Consumer также разбирает JSON по полным values и journal по records; общий
artifact или journal не преобразуется в одну строку V8. Native JSON.parse
сохраняет значения каждого chunk, Unicode/escapes и численное округление.

```sh
node bench/profile/server-profile-contract.mjs \
  --raw /outside/checkout/server-chromium-registration-1/server-profile.json \
  --digest <sha256-из-независимой-квитанции> \
  --journal /outside/checkout/server-chromium-registration-1/journal.ndjson
```

Архив результата хранит JSON, журнал, consumer tarballs и собранные адаптеры.
Срок жизни временного CI artifact не считается durable retention. При сохранённом
отказе валидатор сообщает проверку отказа; это не admission и не product GO.
