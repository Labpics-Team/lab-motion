# Независимая проверка измерительной корректности: immutable 185f02c2

**PASS в проверенной области изменения метода.** Подтверждённых измерительных блокеров в этом delta не найдено. Это завершённая bounded проверка переиспользования UTF‑8/SHA и CSS-разбора, новых ранних отказов CLI и ресурсного capture, с ограниченным переносом собственных предыдущих доказательств по точным операторам. Практическая квалификация pilot/A/A/2×work/A/B остаётся **UNPROVEN**; зарегистрированных timing samples **0**. Общая производственная готовность **INCOMPLETE**: исходный обычный набор сохраняет ресурсный A/A отказ до candidate admission. Ни тестовый счётчик, ни synthetic PASS не названы фактической производительностью.

## Намерение, норма и область

Пользователь поручил завершить Lab Colors/Lab Motion до production качества и потребовал содержательный серверный аналог при отсутствии Android и нерепрезентативном мощном iPhone. Здесь проверена одна ось: получает ли изменённый измерительный метод прежний полезный, семантически сопоставимый результат и сохраняет ли честные отказы. Серверный профиль относится к CPU полной MotionValue/transform lifecycle работы и браузерному elapsed/API/semantic/resource evidence в зафиксированной клетке. FPS физического экрана, энергия, mobile feel, GPU attribution, люди/adoption и общий GO из этой проверки не следуют.

Норма: agents-config Git `85a837e83912ec6b3144b385d938b66a0c63adcf`; девять exact Git файлов сохранены в `norm/`, соответствие текущим байтам проверено. AGENTS §184–204/251, r11 G-PERF §435–460, SPEC/TEMPLATE/PARALLEL и ACTIVE/CLAIM/ACTIVATION применены. ACTIVE — authoritative r11, active; r12 подготовлена и не активирована. r12 не является sampling, merge, npm или deploy grant. Ownership — только этот собственный scratch; product/config/live bytes не менялись.

## Точная identity

| Объект | SHA256 / Git |
|---|---|
| Source | `185f02c2a85972a531627e14b7e0207e27855f95` |
| Tree | `d2b7d736ba9a37b930a0bd4cfa3cae92f12a92bc` |
| Собственный предыдущий epoch | `7f9b85d82bdf531455a8eb0fae4406484205ef83` |
| PRIMARY-PACKET.json, 11221 B | `9c5bbb20ca1c9e8442cbe692710f9d62bf91d3d1865b58d6eba4a2365831bc9a` |
| Source archive, 1742110 B | `8c7d68e4a045f71a5059fce689e31747165d2ce7b332b26a1ade9eef9cf89019` |
| source-delta.diff, 46761 B | `cb6b0ebc6855be9ace2aef710a60100c1a6d43d40e7397eb3452ce9956c99149` |
| Protocol | `7016c19aa7a763fee68687327ef489abb119acd2a43d397b8485ca56e4cea15f` |
| Clock model | `7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f` |
| boundary-result.json, 4636353 B | `3eea1c60cec9318d6f2c6427ff0de2c07a7c198fb183cf057acea4962ff4ce9f` |
| journal-result.json, 5072654 B | `f73c39fadc91738a37f66e802d451395b45b1a3f2c3438f656b581aa6abd016c` |
| transfer-proof.json | `7e7650bbb1088a284c91bcd2af39d868055772eefe9fca62443180bd2f27a655` |

Все 45 allowlisted inputs rehashed без расхождений. Source archive распакован безопасно в read-only `snapshot/source/source/`: новый tar имеет prefix `source/`; 631 regular tracked source файл сохранён точно, directory entries не считаются файлами. Полные байты всех 631 сравнены со своим immutable 7f9 snapshot: 614 совпадают, 17 изменены. Все 17 packet owner bindings непосредственно совпадают с Git185 blobs; дерево получено точным Git rev-parse. Hash-only source context отделён от прочитанного/исполненного readset. Не переносится произвольный общий «913 conserved proof», неизвестный runtime/tar или будущий source.

## Проверенные изменённые законы

### 1. Общий UTF‑8 digest и journal reuse

В `serverProfileDigest` прежнее `sha256Bytes(Buffer.from(JSON.stringify(value)))` заменено одной native JSON.stringify строкой и native UTF‑8 SHA update. JSON производится один раз: getter/toJSON чтения не повторяются и не кешируются по identity объекта. Успешная native JSON строка одинакова до/после; Buffer UTF‑8 и native SHA UTF‑8 получают те же байты, включая BMP, astral pairs, escapes и well-formed lone-surrogate JSON. Для JSON result undefined специально сохранена прежняя Buffer.from ошибка; original thrown undefined не превращён в успешный digest. При изменении объекта или stateful toJSON новый вызов заново читает значение и даёт новый SHA.

Независимый локальный oracle — SHA от Buffer(JSON.stringify(value), UTF‑8), не serverProfileDigest. Восемь fresh фабрик покрывают Unicode/lone surrogate/NUL/escapes/−0; строку 65536 code units; массив с holes/undefined/nonfinite и numeric keys; boxed Number и toJSON key; порядок getter→hook; top-level undefined; thrown undefined; поздний BigInt после уже прочитанного hook. SHA либо точные type/name/message отказа и read trace совпали. Мутация между вызовами меняет SHA; stateful toJSON вызывается ровно один раз на каждый из двух новых вызовов. Protocol и clock-model digest вычислены фактическим новым owner и совпали с указанными immutable digest.

Journal validator вызывает этот же owner после неизменённых chronology/complete/failure-union проверок. Общий hashing путь не доверяет recorded verdict: каждое допущенное тело квитанции сериализуется и хешируется заново; уже отвергнутая структура не требует повторного полного raw хеширования. Collector и consumer используют одни байты, но проверка ниже включает независимую chain генерацию и согласованные raw mutants.

### 2. CSS cache: строка разбирается однажды, ожидания проверяются каждый раз

Новый `createTransformLifecycleValidator` владеет private Map в closure. Ключ — примитивная неизменяемая CSS string; значения — frozen parser coordinates. Parser memo ограничен первыми 64 строками длиной ≤4096 UTF‑16 code units. Ограничение относится только к memo: длинный либо последующий новый CSS всё равно разбирается и проверяется, raw не обрезается и sampling N не меняется. `serverCellPairs` создаёт один такой context на свой вызов; `validateServerEngineSample` создаёт новый context на свой вызов. В timing SUT такой cache не помещён. Direct legacy callable `validateTransformLifecycleSample(sample, case)` не принимает внешний parser cache третьим аргументом.

Доказуемый инвариант для native plain immutable CSS: readTransform — детерминированный разбор строки, который не знает expected case. При cache hit меняется только этот разбор. На каждом trace setup/frame по-прежнему вычисляются независимые endpoints/linear coordinates и сравниваются все семь каналов с прежним tolerance; остаются clock/RLE/event/target-hash/finished/cleanup проверки. Значение строки не может получить acceptance другого frame или case от самого наличия в Map. Ошибки parser не помещаются в cache. Это не доверие к semantic.valid или совпадению валидаторов.

Контроль: собственная независимая синтетическая fresh fixture с 16 clock endpoints и шестью явными CSS векторами; native cached, uncached и свой старый 7f9 owner дают одинаковый replay. Матрица отрицательных свидетелей сначала согласует event values, terminal value и trace hashes с подменённым raw, поэтому отказ приходит от transform закона, а не от пропущенного поля:

| Coherent mutant | Фактический отказ |
|---|---|
| already-cached-wrong-frame | `transform: raw target 0 frame 2 x=96, ожидалось 64` |
| new-wrong-CSS | `transform: raw target 0 frame 2 x=999, ожидалось 64` |
| unit-poison | `transform: неверное число/единица` |

Первый mutant использует строку, уже находившуюся в том же cache от соседнего здорового кадра: x=96 на frame2 всё равно отвергнут против независимого x=64. Следующий — новый CSS x=999; ещё один — неверная единица. После каждого отказа тот же context снова принимает исходный healthy sample. Попытка передать fake parser третьим аргументом direct callable не влияет на отказ.

70 корректных вариантов whitespace сохраняют те же coordinates и raw lineage. В точном source VM с наблюдающим Map (он делегирует native Map и не заменяет parser/result) выполнено 420 get, ровно 64 set, size/maxSize64, все сохранённые значения frozen. Во всех 70 случаях cached replay равен старому uncached результату. Для fresh CSS длиной4096 memo имеет6 entries; длиной4097 —0, хотя обе полные raw истории приняты. Второй новый context начинается пустым и самостоятельно отвергает coherent wrong-frame. Эти числа характеризуют конкретный witness и размер cache, не независимый N или вероятность.

На public `serverCellPairs` проверены все 11 клеток synthetic warmup с двумя сбалансированными runs: before/after value и bound массивы одинаковы. Поздний восьмой raw repeat одного participant подменён согласованным wrong-frame и отвергнут именно x=96 versus64. Direct `validateServerEngineSample` принимает здоровую batch. Отсюда не делается фактический A/A вывод: endpoint CPU значения фикстуры сконструированы, а не получены из зарегистрированных наблюдений.

### 3. Ресурсная precondition перед probe

`captureServerMachine` теперь требует присутствующий непустой cgroup-v2 cpu.max и шесть safe nonnegative counters cpu.stat прежде hashing executable, setup/build и samples. Точный `runServerProfile` вызывает capture до require esbuild/playwright и подготовки checkout. Это ранний отказ той же среды; он не выбрасывает неудачный acquired block и не выбирает более удачные samples задним числом. Raw отказа хранит наблюдённые affinity/quota либо resource snapshot; downstream journal/failure-union сохраняет причину.

Исполнены точные source functions в собственном VM с независимым fake FS: здоровые counters, включая честное историческое nr_throttled2/throttled_usec50, принимаются; executable hash вызван один раз. Отсутствующий/пустой/whitespace cpu.max; отсутствующий каждый из шести counters; отрицательный, дробный, unsafe integer и Infinity user_usec —13 отказов до executable hash (0 calls). Raw/error и порядок FS чтений сохранены; nonfinite отмечен явно. Наличие исторического throttling не является новым отказом: прежний ресурсный owner требует нулевой **дельты** throttling в каждом admitted paired block. Его операторы не изменены. Этот контроль не доказывает stationarity, thermal stability, отсутствие фоновых cgroup задач или IID реальных расходов.

### 4. CLI operands и происхождение вспомогательных фикстур

Оба legacy PROFILE-01 CLI проверяют наличие операнда у каждого повторения используемого флага и отвергают пустой/leading-dash operand до создания artifact directory. Четыре реальные small public CLI child воспроизводят missing --mode, поздний duplicate --out без operand, empty --raw и поздний duplicate --raw без operand. Все exit1, stdout empty, конкретный operand error в stderr и пустой собственный рабочий directory. Imports выполнены из frozen185 snapshot, не live tree; build/old-vector измерение не запускались.

`cleanPreregistrationFixture` фиксирует context exact Git HEAD, копирует новые owned CLI bytes до clone и проверяет clean allowed-path delta над старым PRODUCT_BASE; это исправление принадлежности тестовой фикстуры, не expansion PREREG exemptions. `scope-recipes` очищает только собственный extraction packageRoot перед проверяемым unpack — stale leaves не остаются как installed bytes. Эта source inspection не заменяет public runtime/package/browser подтверждение: extraction/build/browser/tars здесь не исполнялись. Fixture types и немерительные browser/test поправки прочитаны в diff; они не меняют зарегистрированный timed SUT.

Temporal test исправлен так, чтобы independent128/256 endpoints соответствовали объявленной config/topology duration: узкий coherent256 теперь принимается при256, широкий32ms window даёт refusal, flip topology/config даёт refusal. Это generic helper fixture; зарегистрированный SERVER_PROFILE duration128 и его consumer case не изменены. Совпадение тестового expected true не является разрешением measured256 как128. Сам method semantic/clock owner byte-identical своему предыдущему epoch.

## Journal, failure prefix и независимые falsifiers

Две текущие synthetic истории — preparation refusal и registered warmup prefix с собственным исторически helper-acquired stock-C late constructor failure — проверены actual185 public consumer. Вторая содержит семь полных repeats, 1998 complete операций в failed repeat, raw values/frames и открытый operation edge; это сохранённое собственное predata acquisition под fake CPU из11ab, не текущий timing sample. Raw артефакт и journal независимо декодированы перед mutation; referential alias не маскирует потерю failure.

Обе lawful истории дают UNPROVEN, journal verification без исключения и два public CLI exit0 с итогом UNPROVEN. Exit0 означает успешную проверку сохранённого отказа, не admission. Полные raw JSON/NDJSON и CLI argv/stdout/stderr сохранены в `journal/`. Независимая chain генерация использует Buffer UTF‑8/native SHA, а не новый общий digest.

| Falsifier | Наблюдение current185 |
|---|---|
| valid-setup-refusal-stale-Unicode-body | `server profile: повреждена цепь журнала` |
| valid-setup-refusal-UTF16-final-digest | `server profile: финальная квитанция не связана с raw/вердиктом` |
| valid-late-acquired-prefix-stale-Unicode-body | `server profile: повреждена цепь журнала` |
| valid-late-acquired-prefix-UTF16-final-digest | `server profile: финальная квитанция не связана с raw/вердиктом` |
| lost-late-acquired-value-with-coherent-final-hash | `server profile: failures потеряны или добавлены вне журнала` |

После потери одного acquired failure value пересчитаны правильные final raw SHA и вся chain. Journal всё равно отвергает различие failure union с исходным journal error. Отдельные enumerable record toJSON→undefined и toJSON→throw undefined сохраняют original type/name/message и ровно одно hook чтение как свой старый7f9. Это проверяет изменённый digest caller, не только helper изолированно.

## Квалифицированный перенос измерительных/математических свойств

`transfer-proof.json` связывает 10 exact operator spans before/after: SERVER_PROFILE object; verify/tail/N/pilot law; interval/family/calibration/resource policy; realm CPU/semantic error construction; bounded artifact digest; native serializer/write/parser и stage plan; journal chronology до нового body hash; runTransformLifecycleSample producer; engine/stock/browser producers; runServerProfile stopping/order/collector. В частности method owner `bench/compare/methodology.mjs` и provenance.mjs — whole-file идентичны. Whole631 comparison и owner Git bindings ограничивают transfer своей ранее запечатанной цепочкой. Не выполнен новый полный rank/clock matrix ради числа PASS; использованы собственные независимые numerical primary refs только там, где оператор и входные предпосылки сохранены.

Сохранены meaningful unit и denominator: CPU current-thread user+system для целой engine работы; stock-C whole MotionValue2000 operations, default spring lifecycle/subscribe/retarget/frames/destroy, positiveactual4000 с исходным знаменателем2000; browser elapsed стоимость совпадающего API batch и отдельно normal-motion/cancel semantic evidence. 8 повторов и6 кадров зависимы; независимая статистическая единица — среднее пары противоположно упорядоченных runs одного paired block. Cache replay не превращает parser invocations или repeats в дополнительные наблюдения и не находится в CPU stopwatches SUT.

Family по-прежнему11 cells ×2 quantiles ×2 participants ×2 tails, rational per-tail alpha1/1760 и family95% Bonferroni. Minimum146 blocks =292 runs обеспечивает конечную p95 upper order statistic при заданном alpha;145 blocks не достаточно. Max1024 runs, прежние NI1.05, positive-control resolution1.5, seed, stopping, MDE/power planning, duration128 и timeout30s не менялись. Mean/log pilot planning не является гарантией мощности tail NI. Порядковый CI требует зарегистрированной IID block предпосылки; ресурсные/A/A controls её не доказывают универсально.

CPU endpoints несут прежний pointwise microsecond truncation envelope (две user/system составляющие, два endpoints), browser — прежние isolated Chromium149 coarsening/truncation/binary64 ULP bounds и clock publication requirements. Worst-case systematic error не shrink по repeats/N. Exact protocol/clock digest равны до/после. Это перенос математического правила при тех же official binaries/Linux/CLOCK_MONOTONIC assumptions; физические upstream clock источники заново не переаттестованы и актуальная real-server clock calibration не проводилась.

Source before-data → baseline-only pilot → N freeze → actual A/A +actual2×work → candidate raw control/A/B только после годной calibration; запрет samples после refusal и полнота journal/failure unions не изменены. Десять старых защищённых guards и legacy1200 scope сохраняются в неизменённых source bytes; текущая проверка не сообщает, что их actual производственные результаты все GREEN. Сильные peers и registered comparator semantics требуют своих реальных совпадающих scenes/source/artifact observations; синтетическое сравнение не выбирает победителя.

## Сохранённые отказы и пределы результата

Исходная ordinary primary для точного185: 4974 passed,1 failed, successfalse. Единственный отказ — RESOURCE dropped-owners heap test: «A/A heap baseline не разрешает256KiB; candidate admission не запущен». Он не скрыт aggregate count и не превращён в NO-GO библиотеки. Реальная ресурсная/производственная квалификация остаётся открыта. Этот report не подменяет отдельный parent baseline diagnostic его результатом. Hosted старого7f failure также не назван свидетельством текущего185; current remote metadata rehashed, foreign PR/review bodies не прочитаны.

Свои harness ошибки сохранены отдельно: отказ exec-server из-за ещё не созданного scratch cwd; слишком строгая обработка directory entries tar; повторно созданный directory; грамматика аргументов read helper; archive prefix;0444 собственного скопированного helper; initial Node assertion8vs6 для live setup+frames. Это ошибки reviewer harness, не source method findings. `failure-initial-boundary/` хранит первоначальные code/driver/receipt/stdout/stderr без изменения. Approved correction выбрала fresh fixture/setup0 и добавила partial checkpoints до assertions. Первоначальный driver остановился до journal/resource/CLI и не породил actual timings. Corrected children boundary/journal exit0; raw и partial receipts сохранены. Повтор разрешён конкретной harness correction, не повтором до удачного performance результата.

Новые current full-N/browsers/build/pilot/calibration/performance серии не запускались. Synthetic clocks/values не выдаются за current timings; historical acquired failure остаётся историческим. Общий serializer по-прежнему требует, чтобы каждый цельный comparator element помещался в строку V8; docs теперь называют этот предел честно. Старый maxN1024 carrier — ограниченный синтетический format witness, не universal acquired-data bound; новый огромный stream не читался. Не получено clean final product package tuple, artifact admission, quiet ACK, main merge/npm/deploy authorization или mobile/human evidence.

## Команды, raw и завершение

Основные воспроизводимые команды из собственного sealed cwd (полные UTC/argv/exit/stdout/stderr в `commands.jsonl` и child receipts):

```sh
python3 prepare.py
python3 transfer-proof.py
python3 collect-norm.py
env -u NODE_PATH /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node boundary-probe.mjs
env -u NODE_PATH /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node journal-probe.mjs
python3 collect-readset.py
```

При replay следует использовать новый собственный writable cwd для outputs, оставив абсолютные frozen imports/read-only source и historical inputs exact. CLI producer/consumer argv и output bytes находятся в отдельных `cli-*.json`/`journal/*.cli.json`; partial digest/semantic/cache/resource raw retained. Запечатанный исходный reviewer directory не перезаписывается.

Initial child END22:03:06.149961Z; corrected START2026-10-01T22:08:19.923101+00:00, last child END2026-10-01T22:08:20.619262+00:00; driver END2026-10-01T22:08:20.619473+00:00. Все synchronous CLI grandchildren joined, own heavy0, slotfree. Нет браузера, FIFO, сервиса или зарегистрированной серии.

`exact-readset.json` содержит explicit path/ranges/digests,45 input hashes,631 context hashes,21 static imported source/probe bindings,17 exact owner Git bindings,9 frozen norms и собственные previous primary refs; dynamic build/browser code не назван исполненным. `PRIMARY/PRIMARY-MANIFEST.json` связывает первичные probes/raw/source/commands отдельно от данного REPORT/measurement-verdict. `output-manifest.json`, `terminal-manifest.json` и `terminal-seal-receipt.json` связывают весь durable результат, полное повторное чтение SHA и RO modes. Отдельно сохранены incomplete/failure outputs; недоступное не названо PASS.

При следующей source/runtime/clock/protocol/parser/cache/serializer/hash/environment/artifact delta требуется собственное affected closure. Этот scoped PASS185 не является автоматическим разрешением будущих bytes или проведения actual observations.
