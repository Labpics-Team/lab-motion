**Независимая измерительная ось — метод stock C, epoch 11ab97.**

Вердикт: **PASS в указанной ниже области методики**. Подтверждённых измерительных блокеров в проверенном C delta не обнаружено. Реальная performance qualification, actual A/A и actual 2×work остаются **UNPROVEN: registered performance samples = 0**. Это не product/global GO, не допуск successor и не активация r12.

Проверяемый результат — корректно нормированная стоимость существующего whole-stock-C macro MotionValue и десяти прежних серверных клеток, её консервативные интервалы, исполнимая последовательность preregistration/pilot/calibration/A/B и сохранение приобретённых данных при успехе и отказе. Конечные controls и сохранённые старые guards являются обязательной областью этого вывода. Он не удостоверяет произвольную непрерывную траекторию, каждый возможный stateful дефект, физический FPS, мобильную/энергетическую/GPU эффективность, adoption или человеческие показатели.

**Точный объект и полномочия.**

Исходное намерение — довести Lab Colors и Lab Motion до production качества по agents-config. Уточнение пользователя: Android отсутствует, мощный iPhone не представляет нагрузку; серверная проверка должна иметь содержательный измерительный результат. Проверена одна ось. Продуктовые и конфигурационные деревья не изменялись; все новые записи находятся в `/tmp/server-method-measurement-stock-c-11ab-20261001`. Старые собственные c90/16f31/6fe08 FAIL и 5dc доказательства сохранены без изменений.

| Поле | Exact identity |
|---|---|
| Archive | `/tmp/motion-server-method-stock-c-final-20261001T172036Z/method.tar.gz`, 271639518 B |
| Archive SHA256 | `11ab97e8e43a5b4b6f61b7da3054d9fcb5aa9f60817cf09024fd2dc10c4f66d0` |
| Input manifest SHA256 | `e104bc9f0d3efafd77f6e10ca72a1d364adde1ff4bb558c08dfc58210bc3cdb1` |
| PRIMARY-PACKET SHA256 | `2b0ed03fcc3a23b5b0dcafa35de968dab86eed41773134ba5f61a58dc1223a8c` |
| Source Git | `6eae2d41ee9bc213a68a2cf5fa8405bcf85519bd` |
| owner.patch SHA256 | `768221116c6967770cf02c723a0838b91106b247b41dfa0b8f7601cb8d0d28a0` |
| Protocol | `7016c19aa7a763fee68687327ef489abb119acd2a43d397b8485ca56e4cea15f` |
| Clock model | `7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f` |
| Norm Git | `85a837e83912ec6b3144b385d938b66a0c63adcf` |

Сначала независимо rehash archive/manifest/allowlist, затем потоковое извлечение только allowed regular files. Все 697 allowed файлов совпали по SHA/длине, mismatch 0; 679 небольших файлов удержаны в read-only snapshot, 18 больших gzip остаются в исходном immutable packet. Archive не дублировался. Эти количества доказывают identity, не свойства методики. Все 14 owner/consumer bindings независимо совпали с точными Git bytes 6eae; docs/server-profile.md прочитан по отдельно разрешённому exactGit пути, SHA `91258e617cae480dbc80db857076ac340c35b00e5cbe026916fa8f5cc4e82b99`.

AGENTS §§доказательства/независимость, r11 G-PERF и PROFILE-01 применены вместе с SPEC/TEMPLATE/PARALLEL и ACTIVE/CLAIM/ACTIVATION. ACTIVE и CLAIM по-прежнему r11; r12 — подготовленная редакция, не execution grant. r11 G-PERF требует независимую единицу, MDE/power/null-pilot, заранее фиксированные N/seed/stopping, actual A/A/2×work до A/B, family coverage и сохранение всех исходов. Текущий PASS относится к способности метода обслужить этот контракт; нулевые реальные samples его фактическую performance приёмку не закрывают.

Разрешённые входы: frozen code/diff/manifest/первичные raw/probes/commands и собственная прежняя measurement chain. CLOCK-CERTIFICATE, RUN-PLAN, HANDOFF, QUALIFIED-TRANSFER и чужие review REPORT/verdicts/PR тексты не читались. Полученные координационные сообщения об отдельном CI status и будущем epoch не использовались как oracle; ссылки на CI logs не открывались. Между осями передавались только CPU START/END. `exact-readset.json` отделяет семантические чтения, импортируемый pure-code closure, exactGit/norm snapshots и механический hash-only inventory.

**Единица полезной работы и конечные controls.**

Независимое чтение старого stock C в `evidence/existing-stock-extraction/old-bench.mjs:298` и текущего `scripts/bench-support.mjs:23` восстановило одинаковое тело: clock → constructor(initial0, default spring mass1/stiffness170/damping26, без explicit clamp) → onChange → setTarget100 → synchronous drain без timestamp, с прежним cap100000 → destroy → return last. Factory находится вне CPU. Старые штатные две warmup batches по2000 тоже вне CPU.

`macro-parity-probe.mjs` исполнил извлечённое старое тело и текущий helper на независимой наблюдаемой модели: по три операции, полный порядок 156 событий на роль, нулевое число аргументов frame callback, исход каждой операции100/47. Хронологии и исходы совпали. Кроме того независимо пересчитаны supplied native primary traces: у baseline/candidate совпали все 52 события, включая initial value0, 47 обновлений, target100 и destroy100; все 64 сохранённых per-role outcomes100/47. Это semantic-only control: CPU/wall distributions здесь нет.

Текущий producer `measureServerStockC` содержит восемь timed batches. Обычный batch выполняет2000 actual macro calls; positive выполняет4000, но divisor остаётся2000. Сохраняются каждый last/getFrameCount и два actual user/system CPU endpoints. Preallocated stores и getFrameCount внутри CPU одинаковы ролям; RLE/oracle идут после endpoint. CPU относится к целому macro с recorder, не к чистому solver, отдельному frame либо100-channel envelope.

Независимый source-derived synthetic producer вызвал exact frozen function с подменённым CPU seam и собственной MotionValue моделью. Это не реальные timings:

| Контроль | Приобретённая работа/исход | Результат |
|---|---|---|
| Healthy single | 4000 warmup + 8×2000 timed =20000 операций, 16 CPU reads; каждый macro100/47/destroy | Принимается |
| Healthy actual double | 4000 warmup + 8×4000 timed =36000 операций, 16 CPU reads; divisor2000 | Принимается; fake metric226000 =2×113000 |
| Среднее47 из0/94 callbacks | Ordered per-operation outcomes имеют настоящий дефект уже в warmup | Отвергается, весь acquired RLE остаётся |
| Среднее100 из0/200 endpoints | Ordered outcomes обнаруживают отдельные неправильные операции | Отвергается, весь acquired RLE остаётся |
| Поздний constructor `throw undefined` | Семь полных timed repeats;1998 completed outcomes следующего; CPU before приобретён, after отсутствует | Aggregate cause `undefined` и открытый prefix сохранены |
| Последний acquired `undefined`, `-0`, `NaN` | Семь полных repeats; failed batch completed2000, два CPU endpoints, последний RLE run from1999 | Явные distinct tags сохранены; semantic отказ |
| Невалидный actual CPU after | Один completed repeat; второй имеет2000 outcomes, два acquired CPU fields, только один valid clock endpoint | NaN tag и полный acquired prefix сохранены |

RLE independently расширен: `[undefined,undefined,-0,+0,NaN,+Infinity,-Infinity]` даёт семь идентичностей и шесть runs. Undefined помечен `{type:'undefined'}`, signed zero `{number:'-0'}`, nonfinite — именованными tags. `Object.is` отличает ±0 и сохраняет порядок. Native JSON parsing текущего chunk parser согласован с ordinary JSON.parse на этих complete tagged carriers; специальный carrier не объявляется правильной анимацией.

Дополнительные coherent consumer falsifiers построены из собственных acquired healthy sample: ns endpoint+1 с пересчитанными raw metric/aggregate и copied valueNs отвергается по actual user/system сетке; positive divisor4000 отвергается; потеря последней RLE operation отвергается;0/94 с формально правильными средними отвергается. Отказы имеют содержательную причину, здоровый контроль проходит.

Конечный stock semantic gate устанавливает100/47 для каждого whole macro и сохранность scheduler/endpoint исходов; он не проверяет каждое промежуточное spring значение в каждой timed операции. Native primary trace и прежние numerical/conformance guards сохраняют собственную область. Их нельзя заменить terminal/frame-count gate или считать следствием этого PASS. Так же конечные browser controls не доказывают все stateful/между-checkpoint поведения.

**Clock error и численная оценка.**

Первичные Node/Linux источники прочитаны напрямую: node_process_methods.cc:142 читает uv_getrusage_thread и возвращает отдельные user/system microseconds; libuv-core.c:1177 использует RUSAGE_THREAD; linux-sys.c:1861/1930 получает текущий thread и переводит два ns поля; linux-time.c:476 отбрасывает дробную microsecond. Ошибка каждого суммированного endpoint находится в(-2000,0]ns, а разности двух endpoints — в(-2000,+2000)ns. При batch/2000 это консервативные±1ns/op. Погрешность не умножается на2000 несуществующих clock intervals и не делится ещё на число зависимых repeats.

Отдельный Python Fraction oracle для крайних remainder комбинаций дал batch errors±1998ns и per-op±999/1000ns. Текущий consumer дал healthy bands `[112998.99999999988,113001.00000000012]` и double `[225998.99999999977,226001.00000000023]`: systematic±1ns сохранён, ULP округления направлены наружу. Перевод отдельных safe integer user/system в BigInt и разность String endpoints предшествуют Number(duration)/2000; невозможный ns sample не может проскочить через согласованные aggregate поля.

17 pinned clock source bytes и clock model совпали с собственной5dc chain. Это проверено по full SHA. Browser clock/publication/onset law и error functions проверены по точным source fragments и dependencies, не по чужому PASS: methodology с Warm-floor до EOF идентичен, bench/compare/bench.mjs и bench-transform-support.mjs идентичны целиком, contract browser-clock/coordinate/cancel portions и runner browser acquisition portions идентичны. `function-transfer.json` содержит SHA/markers/строки семи transferred fragments; `transfer-map.json` — file identities.

Собственная прежняя доказанная модель перенесена только на эти неизменные зависимости: TimeTicks truncation<1us плюс isolated TimeClamper5us в каждую сторону, outward browser API interval12us + binary64 conversions/subtractions; doc/perf relation имеет отдельный envelope трёх coarsened timestamps. Onset publication и checkpoint frame/perf chronology не отождествляют stale document clock с wall execution. Неразрешающий semantic интервал требует отказа. Registered official Node24.19/Linux6.18.44/Chromium149 binaries, общий CLOCK_MONOTONIC без namespace/override и source↔binary соответствие остаются явными предпосылками; этого review недостаточно для фактической clock qualification иной среды.

Старые MC01(duration64 вместо128), MC02(loss acquired engine lineage/impossible ns), MC03(wide read window скрывает wrong duration) и MC04(onset0→75 с усечённой full work law) не переобъявлены современными timings. Их закрытие из своей5dc chain переносится лишь на exact unchanged browser/primitive law. Новая stock CPU/denominator/RLE граница проверена заново перечисленными acquired/control falsifiers.

**Независимая единица, N и multiplicity.**

Семейство теперь ровно11 клеток: scalar live100×3, transform fresh1000×3, stock C×1, S2/S3×2. Независимая единица — среднее двух противоположных runs блока; frames, targets,2000/4000 calls и восемь repeats не увеличивают N. p50/p95 относятся к распределению средних стоимостей блоков. Coverage условно на независимые одинаково распределённые блоки закреплённой клетки, как явно записано в registration/docs.

Для двух участников, двух квантилей и двух tails:11×2×2×2=88 границ, alpha каждого tail=(1/20)/88=1/1760. Python `math.comb` с exact integer mass и отдельный JS BigInt owner согласовались на n4/145/146/147/512 для q1/2 и19/20. При145 blocks p95 upper отсутствует;146 впервые даёт ranks129…146, p50 —53…94. При512 p95 ranks469…502. Minimum292 runs — следствие семейного tail закона, не изменение NI, MDE или ресурсного cap.

Systematic clock bands99…101 на value100 прошли через means и order statistics при292 и1024 runs: ratio band продолжает включать99/101…101/99. Увеличение N не сжимает worst-case clock error. Для stock sample отдельно доказан соответствующий±1ns denominator.

Прочитана и проверена bounded deterministic планировка: единственный baseline-only pilot8runs, четыре log-contrast blocks; normal approximation для среднего контраста (MDE5%, power0.8), отдельно строгий tail admission. Нулевая и малая pilot вариация дают292; один заданный pattern даёт680; большой требует16984 и возвращает cap1024/feasible:false. Это не гарантия tail power и не реальные pilot distributions. Прежние NI1.05, positive lower>1.5,8reps,32/64 browser calls,128ms, counts/stagger, seed0x53525652, pilot8/warmup4, timeout30000 и cap1024 сохранены.

**До данных, stopping и provenance.**

Регистрация с protocol/clock/machine/source/package/harness/tree hashes предшествует samples. Candidate import main entry даёт actual packed MotionValue; profile не заменяет основной API облегчённым constructor. Baseline warmup/pilot идут до N-frozen. A/A и actual work-multiplier2 исполняются однократно при frozen N; N выше cap даёт diagnostic controls и отказ admission. Негодная calibration/resource delta не запускает candidate A/B. Candidate controls и A/B идут после PASS calibration; добора, переселекции samples или retry до green нет.

Known exploratory stock wall prehistory явно включена в protocol; `candidateSamplesObserved:false` относится к текущему CPU/API epoch, а не отрицает исторические наблюдения. Новые thresholds/caps под этот exploratory effect не подбирались. Source registration и journal остаются проверяемыми declarations; synthetic placeholders в моих CLI carriers не удостоверяют настоящие packages, binaries, host или actual stationarity.

Сохранены прежние десять клеток и canonical1200ms scopes: START_SCENARIO_MANIFEST s1…s4 duration1200, существующий compare owner целиком byte-identical. Сохранены старые численные/size/runtime guards; они не запускались заново в этой узкой оси и не выдаются за покрытые performance data. Comparator samples остаются descriptive без best-peer/M-05 superiority admission; unsupported stagger peers не превращаются в удачные измерения. Observational retention после host turn/two GC отделён от CPU и не доказывает точную атрибуцию утечки/GC.

**Публичный полный carrier и сохранность.**

Исполнены два новых public CLI witness N292/146blocks через frozen current contract. Stock поля взяты из независимого acquired producer, остальные клетки и provenance — explicit fabricated synthetic fixture. Ничего не уменьшено в N/threshold/timeouts. Healthy прошёл registration/frozen pilot/calibration/A/B/raw/journal как `server-cell-only/PASS`. Поздний acquired failure сохранён в failure union и журнале; consumer вернул `partial-samples-refused/UNPROVEN`, не performance admission.

| Carrier | Uncompressed bytes | Exact uncompressed SHA256 |
|---|---:|---|
| Healthy raw | 277823135 | `0080cd418e7fcef19eda1e6c719871d0776246a562d5e9473520b8745be446ff` |
| Healthy journal | 280819721 | `11be66264275ec91c5b6cf5c52e2fd695675093477fee80e2db01c5597090c5c` |
| Late failure raw | 175239372 | `f4365d7f03f72b2b4f479c5cba5a438b46ec8302525885c023e2cdc170ce4515` |
| Late failure journal | 176825257 | `cabe19760cc97a9df117a260029fe3972b4b19f7f43e4db172bcaa4b404e9f6d` |

Всего910707485B raw/journal хранятся lossless gzip45143636B. Писались сразу compressed streams, giant plaintext не создавался и не удалялся. Public CLI получил полные decompressed bytes по FIFO; все четыре readback SHA/длины совпали, writer threads joined, FIFO удалены. `compression-receipt.json` содержит обе compressed/uncompressed identities и receipts.

HEAVY bounded source/model window:17:46:44.295045…17:46:45.644434Z; explicit END17:47:00.671737Z. Full-N command:17:52:41.212122…17:53:28.490607Z; последний child END17:53:28.428967Z; explicit HEAVY END17:55:05.146147Z. После него только light reads/parity/metadata/seal. Browser/build/real timing executions не было. Все процессы и FIFO закрыты.

**Точные воспроизводимые команды и durable evidence.**

Cwd всех собственных commands: `/tmp/server-method-measurement-stock-c-11ab-20261001`. Полный command/UTC/exit/stdout/stderr ledger — `commands.jsonl`; initial failed extraction guard, missing-path rg и lookup docs вне allowlist сохранены. Это ошибки подготовки review tooling, не дефекты продукта: разрешённый report-contract source корректно исключён из слишком широкого initial name guard, docs прочитан из дополнительно разрешённого exactGit, wrong search path исправлен без mutations snapshot. Все предметные probes завершились exit0; потери failure/raw нет.

```sh
python3 extract-primary.py
python3 numeric-stock-reference.py
node stock-producer-probe.mjs
node numeric-stock-probe.mjs
node macro-parity-probe.mjs
node fullN-stock-cli.mjs
python3 collect-readset.py
```

Для полномасштабного replay исходного carrier вместо генерации: `python3 cli-gzip-fifo.py current-stock-fullN-own-healthy-prepared.json fresh-healthy-cli.json` и аналогично late-failure prepared; metadata helper исполняет exact `node snapshot/source/bench/profile/server-profile-contract.mjs --raw <FIFO> --digest <retained-uncompressedSHA> --journal <FIFO>`. При replay нужно координировать CPU isolation, сохранить новый receipt и не менять N/метод. Исходные seal files не перезаписываются.

| Собственный исполнимый probe | SHA256 |
|---|---|
| stock-producer-probe.mjs | `f520cb851f2ca93135ddba762596109e4378252a7d522f50f5ae89acf57e789c` |
| numeric-stock-reference.py | `68b56930be161d507d74ab90df07ecedc4963db070a3c412d9e247b8267b9e4f` |
| numeric-stock-probe.mjs | `61d8340d2277730e20093ad7774ea5bf3ac2323d80be04762f5f4b0e3c8e7b44` |
| macro-parity-probe.mjs | `f08481fcfd0dd594464b36b4b7fd48ba66e2d182a0b60b44f01c0f5591362691` |
| fullN-stock-cli.mjs | `2a9258a11c03dc394446e7865ac4340f5c5b13ecd385b15d969b8ff1b3553dc3` |
| cli-gzip-fifo.py | `d3a3f10a7adf42e7f875a3b0278c71f143d50e40fd87566bf12cf8cb3a9db7d6` |

`PRIMARY/PRIMARY-MANIFEST.json` — отдельный bounded primary-only packet: exact changed source/import closure, source/probes/acquired raw/CLI receipts/gzip/journals/commands/norm identities. REPORT и reviewer reasoning туда не входят. `output-manifest.json` связывает весь собственный retained output; `terminal-manifest.json` связывает REPORT/readset/output/primary/commands и terminal state. Owner source/digest keys полностью приведены в `exact-owner-bindings.json`; собственный exact readset — `exact-readset.json`.

**Граница завершения и invalidation.**

Измерительная ось C delta закрыта только для указанного immutable11ab/6eae/7016/7e45 tuple и перечисленного source readset. Реальные timing distributions, physical devices, per-frame p99/100channel claims, M-05 scene families/superiority, human/adoption, release и G-PERF actual performance admission остаются UNPROVEN. Supplied maxN1024 compressed carriers rehashed; их current primary CLI receipt прочитан, но giant max-format replay не повторялся: serializer/parser exact-transfer плюс fresh current292 pipeline и independent512-block math закрывают затронутый срез без broad повторов.

Смена source/helper/serializer/semantic law/clock/policy/metric family/N/stopping/provenance/package/runtime/environment инвалидирует соответствующую часть этого review и требует bounded affected closure. Новое сообщение о successor не переносит этот PASS на него. Итоговая clean product/source/package tuple и действующие обязательные CI gates требуют своей проверки. **Actual registered performance samples=0; own heavy/processes/FIFO=0; slot-free END.**
