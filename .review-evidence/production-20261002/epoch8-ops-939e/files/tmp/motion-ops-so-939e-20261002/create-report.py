from pathlib import Path
import datetime
import hashlib
import json

OUT = Path('/tmp/motion-ops-so-939e-20261002')
NOW = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()

report = r'''# Независимая ось последствий второго порядка: Motion 939e

**Вердикт: PASS в границах нового пятифайлового source-среза. Подтверждённых блокеров нет.** Принимается архитектура кооперативной остановки частного server-profile инструмента и ранний отказ при невозможном N. Этот вывод не закрывает PROFILE-01, не выдаёт product GO и не удостоверяет производительность, ресурсный бюджет фактической серии или физический mobile envelope.

Исходное намерение — полностью довести Lab Motion по agents-config до production качества; Android недоступен, мощный iOS нерепрезентативен, нужен содержательный серверный аналог без лишней церемонии. В этом срезе полезный результат конкретен: остановить дорогую заведомо неразрешимую серию раньше и дать оператору сохранить уже приобретённый префикс при обычном SIGINT/SIGTERM. Это подготовка evidence path через существующего владельца, а не самостоятельное доказательство сравнительной пригодности продукта.

## Источник, норма и независимость

Проверен immutable HEAD `939e7f4a7ebef2dd494f9dec8690932fecebfd73`, TREE `deba4db1952029bdb7d2244b207f570007700b19`, BASE `fe092331360837fd7f63d71a4b7f867ba849ebd4`. Из read-only Git получены commit object, tree object, binary diff и SOURCE archive. Git SHA-1 commit и tree независимо восстановлены по object framing, содержимому, executable modes, symlinks и порядку tree entries. Обе identity совпали. Авторский gzip SOURCE отдельно сопоставлен со своим archive: все 641 file entries совпали по содержимому, modes и symlink targets.

Свой SOURCE tar: 7 454 720 bytes, SHA-256 `ff8ca442617a4becb751cff3c57ceb2aaca61c9ed0ab0416a843212e8378c193`. Exact diff: 30 495 bytes, SHA-256 `4ba846fa1c8d3d8b41e4fd250d7cf45607dfe4128f49b35661622483c4b2045d`. Полный diff прочитан. Из 641 файла 636 byte-identical собственному ранее sealed fe092 SOURCE; ровно пять изменены:

| Путь | Изменённая ответственность |
|---|---|
| `bench/profile/server-profile-registration.mjs` | Явное правило остановки при невозможной мощности |
| `bench/profile/server-profile-runner.mjs` | Signal wrapper, checkpoints, выделение прежнего calibration owner и ранний отказ |
| `docs/server-profile.md` | Справка о раннем отказе и операторской остановке |
| `test/fixtures/server-thread-cpu-clock-check.mjs` | Два настоящих Node signal controls через private wrapper |
| `test/server-profile-contract.test.ts` | Невозможный N, pre-aborted отказ и сохранение sample перед остановкой |

AGENTS.md, SPEC, TEMPLATE, ACTIVE, CLAIM, ACTIVATION, r11/r12 и canonical composition procedure сопоставлены по SHA/bytes с собственной предыдущей областью чтения. Норма не менялась. ACTIVE указывает r11 active; CLAIM — PROFILE-01; r12 прямо объявляет себя prepared successor и не даёт execution authority. Применены AGENTS 103–116 и 119–145, r11 PROFILE-01 339–351 и G-PERF 435–457: один bench owner, пререгистрация остановки, сохранение отказов, unchanged protected p95 ≤1.05, отсутствие повторов до green и различение server/mobile claims. SPEC 55–66 удерживает authority в ACTIVE. Пользовательское уточнение задаёт серверную подготовку, но не превращает этот source review в закрытие обязательных узлов плана.

Чужие REPORT, root/bot verdicts и рассуждения автора не читались как oracle. Авторский PRIMARY использован как literal index и claim scope; все 28 refs, включая два norm refs, проверены по SHA/bytes. PRIMARY SHA-256 `97492707b736d36bec8cbaa09c911d44a09e02aac61e38c472fccfd1d4ae6c73`. Собственный перенос fe092 ограничен неизменными байтами; новая cancellation/calibration orchestration проверена заново. Не переносится успешность фактической серии, runtime identity нового HEAD или производительность со старого HEAD.

## Владение остановкой, partial result и отказом

`withServerProfileSignals` (runner 102–114) создаёт один AbortController, устанавливает только SIGINT/SIGTERM handlers и снимает свои handlers в `finally`. Первый обработанный сигнал задаёт AbortError / `OPERATOR_INTERRUPTION` с именем сигнала и временем получения; следующие сигналы не создают новый abort. Существующие process listeners не удаляются. Default CLI использует wrapper только вокруг `runServerProfile`; прямой private вызов без `dependencies.signal` сохраняет прежнюю модель. Ни process listener, ни AbortController не попадают в публичный пакет.

Владельцем sample и записи evidence остаётся `runServerProfile`. Checkpoint перед участником не допускает следующий acquisition после принятого abort. После уже возвращённого acquisition код сначала compacts CPU evidence, сохраняет sample в текущую row и пишет `sample` journal receipt, затем проверяет abort (630–644). Checkpoint после acquisition находится за пределами sample try/catch: завершённый sample не переименовывается в failed-sample. При настоящей ошибке acquisition прежний failed-sample с raw/timer prefix остаётся в журнале, outer failure совпадает с этой ошибкой. Если одновременно принят abort, `finally` добавляет отдельную операторскую причину вместо утраты исходной ошибки.

Общий catch (698–701) сохраняет отказ и оставляет UNPROVEN. Общий finally (702–726) наблюдает остаточные GC events, проверяет provenance, пытается закрыть browser/origin, сохраняет cleanup failures, затем пишет raw, внешний digest и последний `finished`. При abort, принятом во время cleanup или после иной ошибки, добавляется отдельный `operator-interruption`; ошибка, уже пойманная как именно `signal.reason`, не дублируется. Префикс содержит завершённые observations, а отсутствующие paired-block resource receipts не достраиваются вымышленными данными.

Распределение владельцев простое: wrapper преобразует process event в private cancellation state; existing runner принимает решение о следующем effect и завершает evidence; reader проверяет chronology/failure union. Нового scheduler, signal IPC для production, повторного владельца completion или отдельного persistence path нет.

**Точная эксплуатационная граница:** это кооперативная остановка после обработки сигнала Node и достижения checkpoint. JavaScript handler не вытесняет синхронный engine measurement, build/pack/provenance или retention child; await на уже запущенной браузерной операции тоже завершается своим существующим путём. Во время синхронной работы сам OS event может ещё не быть доставлен JavaScript. Повторный SIGINT/SIGTERM не служит принудительной эскалацией. До завершения cleanup handlers остаются установленными. Поэтому фраза справки о завершении текущего измерения принимается только в этом cooperative смысле; она не удостоверяет deadline от physical signal arrival, неизбежный успех cleanup, восстановление после SIGKILL, crash, disk failure или power loss. При этих отказах код/reader должны сохранять UNPROVEN или отсутствие законченного receipt, а не обещать закрытые ресурсы.

## Граница измерения и protocol compatibility

Независимый byte comparison подтвердил unchanged тела `measureServerEngine`, `measureServerStockC`, `measureServerBrowser`, `measureBrowserRawControls` и `makeRetention`. SHA/bytes каждой функции находятся в SOURCE-BOUNDARIES.json; это собственное сравнение, не принятие авторского conservation claim. Native C getter, JavaScript clock owner, bundled headers, CPU RLE codec, serializer, parsers, statistical reader, исходный bench methodology и provenance также unchanged. Checkpoints расположены до/после calls и journaling; cancellation не передана внутрь clock acquisition или измеренного browser realm. Getter overhead не вычитается, численные denominators не меняются, acquisition does not become censored PASS.

В registration изменена только строка `stoppingRule`; после удаления ровно этой строки before/after text полностью совпадает. Scenes, warmup/pilot/min/max runs, family alpha, power/MDE, 1.05/1.5 thresholds, clock model, raw encoding, ресурсы и units прежние. Строка является частью digest протокола. Следовательно, изменение создаёт новый protocol identity даже при неизменных timing функциях: старый full receipt нельзя объявить current-epoch результатом.

Текущий `verifyServerProfile` требует deep equality всего протокола. Old-source reader остаётся владельцем old receipts; новый reader отвергает protocol drift, а не silently upgrades старый результат. Lossless RLE/legacy-array compatibility сохранилась только в её прежней codec области, она не заменяет epoch compatibility. HARNESS включает runner и registration, поэтому зарегистрированный source binding охватывает обе изменённые эксплуатационные части.

Partial UNPROVEN использует уже существующий refusal формат. `validateServerArtifact` (592–648) допускает preparation-refused или recorded-refusal-only только с отказами, UNPROVEN и без A/B. Journal validator (834–944) связывает полные warmup/pilot с N-frozen, запрещает samples после failure, проверяет raw/journal union и финальный digest. **Recorded-refusal-only не означает независимый сертификат вычисленной мощности:** эта ветвь не пересчитывает весь pilot/plan/AA/positive. Early-power artifact даёт сохранённый источник для отдельного пересчёта и честный отказ; он не даёт calibration PASS. Этот предел reader не скрыт успешным verdict.

Публичные src/exports/dependencies, lock-файлы, CI workflow/его contract и recipe stylesheet lifecycle unchanged по собственному byte comparison. Оба свежих package archives содержат по 312 regular files, без bench/test/native sources или `.node`. Их полные bytes совпадают со своими ранее проверенными fe092 archives. npm сохраняет package.json bytes/values; pnpm снимает только `packageManager: pnpm@11.11.0`, остальные поля одинаковы. Signal/compiler требования остаются private tooling burden, потребителю библиотеки не добавлена установка GCC, libc headers, Node process handlers или AbortSignal contract.

## Ранняя остановка, стоимость и простой путь

Новый `runServerProfileCalibration` (116–135) оставляет warmup/pilot, прежний `planServerSampleSize` и N-frozen digest у существующего владельца. Если `feasible === false`, после freeze выдаётся `UNPROVEN_POWER`; A/A, intentional 2×work и A/B не запускаются. При feasible N выполняется ровно прежняя calibration logic с resource reasons; candidate implementation/control остаются за PASS calibration. Это сокращает неразрешимый branch, не ослабляя successful admission.

Для невозможного N прежний planner всё равно ставит runs=maxRuns=1024. Отказ до двух calibration stages исключает по source geometry 20 480 дополнительных acquisitions: 12 288 engine и 8 192 browser samples, часть deliberate extra-work. Warmup=4 и pilot=8 остаются. Это точный count вызовов по текущему roster, а не измеренная wall-time экономия или верхняя граница disk footprint. Отказ не превращает отсутствие A/A/positive в успешную калибровку; missing evidence прямо ограничивает вывод.

Добавленная цена production path — один controller, два scoped process listeners, checkpoints на границах effects и условная failure receipt. Зависимостей и нового постоянного сервиса нет. Обе функции экспортированы только из private bench модуля для проверок; дополнительный artifact/journal format не введён. Future ownership burden конкретен: новые acquisitions runner должны продолжать проходить те же checkpoints; handler lifetime ограничен scope wrapper; изменения остановки требуют нового protocol digest и сохранения исторического epoch.

Ничего не менять было бы дешевле по diff, но обычный default SIGINT/SIGTERM обрывает процесс без завершённого raw/digest/finished, а невозможный pilot продолжает два дорогих диагностических stages. Ручной kill и последующая ручная реконструкция журнала не дают того же результата. Более широкий cancellation framework, supervisor/retry service или таймер внутри measurement повысили бы связанность и исказили acquisition. Усиление существующего runner через AbortSignal и shared finally — достаточный простой путь для текущей потребности. Встраивание всех обработчиков непосредственно в CLI несколько сокращает exports, но заставляет проверять другой или дублированный путь; private wrapper оправдан единым signal mapping и снятием listeners.

Не доказан before/after speedup mandatory checks: его не требовали и не выводили из разных окон. Native v3 command наблюдался 1.732700 s целиком, включая прежние native controls и новые два forks; отдельная добавленная задержка не измерена, это не deadline. Каждый новый signal control имеет локальный 30 s watchdog. Fresh whole содержит три новых проверки по 38.525851, 4.760442 и 4.405947 ms; суммы этих framework durations не являются временем всей команды или reproducible performance comparison.

## Первичка и сила проверки

Сохранены первоначальные неуспешные controls. Первый targeted run завершился 05:00:09.615487 UTC exit1: intended impossible-N fixture ещё не создал нужную premise и попытался следующий stage; это не выдано за RED на старом production коде. Следующий targeted run завершился 05:01:46.835369 exit0, с четырьмя выбранными tests и 200 filtered-out. Это узкий control run, не whole-suite. Первоначальный native signal fixture завершился 05:01:48.373351 exit1 с unsettled top-level await / exit13. В final SOURCE IPC channel явно ref до получения abort, затем unref; история отказа сохранена.

Native v3 raw завершился 05:02:47.474210 UTC exit0. В нём 13 records: прежние 11 clock/ABI/refusal/mutant records плюс реальные SIGINT и SIGTERM. Каждый signal case имеет aborts=1, registration=null, stages=[], единственный preparation failure `OPERATOR_INTERRUPTION`, UNPROVEN и journal `failure → finished`. Свежая source fixture показывает listener-count restoration, сравнение persisted raw и digest, ожидание parent `close` с code0/nativeSignal=null. C/host hashes и protocol output связаны с текущими unchanged/native и changed-registration bytes. Эти controls исполнены до commit; contemporaneous hashes runner/fixture в execution receipt отсутствуют. Они поддерживают проверенную структуру и общую signal связь, но отдельно не объявлены свежим full runtime certificate exact939e.

Два `child.kill(signal)` в одном callback могут coalesce; aborts=1 не доказывает, что Node обработал два раздельных OS events. Idempotence первого abort следует из source guard. Cases используют shared CLI wrapper и реальный runner refusal до подготовки, не целую CLI series. In-sample preservation проверяется VM extraction фактического runStage с injected acquisition; это отличающий fault control участка, а не настоящая OS interruption внутри production measurement.

Отдельный failure предел test helper: 30 s timeout вызывает SIGKILL и reject до ожидания `close` (fixture 132), а message assertions могут бросить из callback. На таких отказах нельзя обещать all-children-joined только из settlement `runSignal`. Successful v3 raw действительно прошёл close и следующий signal case. Это ограничение отказного test-control lifecycle, не новый публичный ресурсный контракт и не доказанный leak в предоставленных execution histories. При необходимости удостоверить cleanup именно hung control owner — `test/fixtures/server-thread-cpu-clock-check.mjs`; точный falsifier — удержать child до timeout и проверить, предшествует ли parent finally/settlement child close. Этот review не сертификат такого failure path, нового probe не запускалось.

Fresh required receipt завершён 05:11:58.543358 UTC, exit0, с отдельными actual command boundaries и allChildrenJoined. Execution owner `run.py` проверяет clean exact939e перед командами, ждёт каждую process.wait и сохраняет stdout/stderr. Из full framework JSON самостоятельно выделены все 5 027 passed / 0 failed / 0 pending; три новые tests реально passed. Прочитаны raw stderr, включая ожидаемые deliberate missing-Git inputs, и current logs/receipts; авторский parsed success не служил oracle. Whole wall=104.524684 s; отдельные finiteness, actionlint, static, docs-facts/drift и два pack commands exit0. Срез не меняет mandatory commands/CI. Эти данные подтверждают текущие guards, а не прохождение зарегистрированного statistical server experiment.

GATES supplement SHA-256 `6631d9fa61f250e03debc6a669ed5e711d30ad5bb5c8307a07e220b337abd8e7`; все 25 refs проверены. `parsed-results-and-packages.json` и `heavy-profile-cases.json` связаны только по bytes/hash, их interpretations не приняты как oracle. Source/package assertions выше получены собственным readback.

## Границы принятия и invalidators

Этот PASS относится к source architecture/operational compatibility данного diff. Отдельные не закрытые утверждения: реальная interruption history после browser/engine preparation; hard SIGTERM deadline и join на timeout; actual full-series disk/time upper bound; новая statistical calibration/admission; физический mobile/energy/GPU/display proof и итоговая production готовность всего roadmap. Отсутствие этих сертификатов не превращено в NO-GO Motion и не стало основанием запускать лишние серии.

Вердикт пересматривается при изменении пяти source files, contract/clock/acquisition bodies, protocol thresholds/units, package scope, signal ownership, места checkpoint относительно acquisition/journal или active plan/user requirement. Если появляется требование supervisor grace/hard deadline либо одновременные независимые runners в одном process, нынешний wrapper не удостоверяет его: process signals глобальны, каждый concurrent wrapper получит общий event, предыдущие listeners остаются и могут иметь своё поведение. Для текущего однопроцессного private CLI это не новый обязательный coordination layer.

Все writes только в собственном review directory. SOURCE, norms, tests, thresholds, author evidence не менялись. Review проводился source-light на CPU2. Reviewer SUT/runtime/probes/build/browser/series/pilot = 0; heavy/queued = 0. START сохранён фактическим UTC; завершение и SHA/bytes seal — в TERMINAL.json и MANIFEST.json. После sealed completion работа остановлена независимо от публикации.
'''
(OUT/'REPORT.md').write_text(report, encoding='utf8')

def meta(path):
    p=Path(path)
    b=p.read_bytes()
    return {'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}

readset=[]
def add(path,scope,role,mode='semantic read',binding=None):
    r={**meta(path),'role':role,'readScope':scope,'readMode':mode}
    if binding:r['binding']=binding
    if not any(x['path']==r['path'] for x in readset):readset.append(r)

add(OUT/'source.tar','641 entries: bytes/mode/symlink Git reconstruction; five changed paths semantic inspection; unchanged boundaries scoped transfer','immutable SOURCE','all bytes; scoped semantic read')
add(OUT/'source.diff','full exact five-file diff','immutable delta')
for f in ['commit.raw','tree.raw']:
    add(OUT/f,'full object bytes; independent Git object digest','immutable identity')
for f,scope in {
    'bench/profile/server-profile-registration.mjs':'diff full; 1–90 and 137–183; all bytes compare except stoppingRule; previous scoped clock/model transfer',
    'bench/profile/server-profile-runner.mjs':'diff full; 1–135, 530–744; all five acquisition/raw-control/retention function byte comparisons',
    'docs/server-profile.md':'full reference role and scope',
    'test/fixtures/server-thread-cpu-clock-check.mjs':'full 1–195',
    'test/server-profile-contract.test.ts':'diff full; 865–1016 especially 880–950; unchanged rest bounded previous proof'
}.items():add(OUT/'source'/f,scope,'changed SOURCE')
transfer=json.loads((OUT/'IDENTITY-TRANSFER.json').read_text())
normscope={
 'AGENTS.md':'103–150, 187–207; targeted architecture/failure/ownership search; unchanged previous scoped norm',
 'SPEC.md':'55–80, 312–324; authority/lifecycle; unchanged previous full normative reading',
 'TEMPLATE.md':'unchanged previous full normative reading; current byte identity',
 'ACTIVE.md':'full current authority',
 'CLAIM.md':'full current owner/node',
 'ACTIVATION.md':'full current activation pointer; does not assert current entire r11 SHA equals initial grant SHA',
 'r11.md':'174–206, 339–351, 435–457 and targeted context; unchanged previous invariant/gate scope',
 'r12.md':'1–40 current prepared state; targeted server clauses, previous unchanged scope only'
}
for r in transfer['norms']:
    add(r['path'],normscope[Path(r['path']).name],'normative contract / bounded unchanged transfer')
add('/workspace/agents-config/skills/architecture/references/composition.md','full 1–182 across repaired read windows','canonical boundary procedure')
for r in transfer['ownPriorProof']:
    add(r['path'],'own sealed fe092 proof only; transfer by exact 636 unchanged source bytes/norm identity; no new-runtime claim','own prior proof','SHA binding and own prior reading')
add('/tmp/motion-qualified-fe092331-20261002/source.tar','all 641 entries compared with current archive','own previous immutable SOURCE','all-byte transfer check')
primary=json.loads((OUT/'PRIMARY-BINDINGS.json').read_text())
add(primary['primary']['path'],'full literal index; claim scope only','PRIMARY packet')
for r in primary['refs']:
    path=r['path']
    if path.endswith('vitest-result.json'):
        scope='raw framework objects parsed; targeted 3 new controls + N test states/durations/failures; no broader correctness oracle'
        mode='all bytes; selected semantic read'
    elif path.endswith('stdout.log') and 'native-v3' in path:
        scope='full raw JSON parsed; 13 record roster, C/host identity and 2 operator-signal artifact/journal cases'
        mode='all bytes; scoped semantic read'
    elif path.endswith('execution.json') or path.endswith('stderr.log'):
        scope='full raw execution/failed fixture logs'
        mode='semantic read'
    elif path in [x['path'] for x in transfer['norms']]:
        continue
    else:
        scope='exact bytes/hash binding to PRIMARY; metadata is not author authority; SOURCE/function conservation independently checked'
        mode='SHA binding only unless duplicated semantic scope above'
    add(path,scope,'PRIMARY source/raw ref',mode)
boundary=json.loads((OUT/'SOURCE-BOUNDARIES.json').read_text())
add(boundary['supplement']['path'],'full literal index; no parsed verdict oracle','current PRIMARY supplement')
for r in boundary['refs']:
    path=r['path'];name=Path(path).name
    if name=='whole.json':scope='raw full framework JSON parsed; counts + three changed controls independently selected';mode='all bytes; scoped semantic read'
    elif name in ['parsed-results-and-packages.json','heavy-profile-cases.json']:scope='SHA/bytes only; interpretations not used';mode='SHA binding only'
    elif name.endswith('.tgz'):scope='full archive file roster/private isolation, package fields, exact old/current archive comparison';mode='all-byte and package semantic read'
    elif name=='run.py':scope='full execution owner, exact-source precondition and actual waits';mode='semantic read'
    elif name in ['receipt.json','launch.json']:scope='full execution argv/env/actual boundaries';mode='semantic read'
    elif name.endswith(('stdout','stderr')):scope='hash binding all; raw log/error text read for current command results; no parsed author verdict';mode='raw read/binding'
    else:scope='literal exact binding; source PRIMARY separately read';mode='SHA binding'
    add(path,scope,'fresh current gate raw/ref',mode)

result={
 'reviewer':'native_clock_second_order_acceptance',
 'head':'939e7f4a7ebef2dd494f9dec8690932fecebfd73',
 'tree':'deba4db1952029bdb7d2244b207f570007700b19',
 'base':'fe092331360837fd7f63d71a4b7f867ba849ebd4',
 'axis':'second-order operational lifecycle/signals, evidence boundaries, compatibility, cost and simpler alternative',
 'createdAtUtc':NOW(),
 'verdict':'PASS-scoped-source-architecture',
 'confirmedBlockers':[],
 'notCertified':['real-series interruption','hard signal/cleanup deadline','all-failure test child join','actual-series time/disk upper','statistical admission','physical mobile','full product GO'],
 'readerRuntimeExecutions':0,
 'sourceOrNormMutations':0,
 'foreignVerdictOracle':False,
 'entries':readset,
 'archiveInternalSemanticScopes':[
   {'file':'bench/profile/server-profile-contract.mjs','scope':'1–95, 592–697, 834–963 current direct read; unchanged remainder own fe/f647 proof'},
   {'files':boundary['unchangedRelevantSourceFiles'],'scope':'126 exact unchanged public/CI/recipe/clock entries compared; semantic transfer limited to own sealed fe proof'},
   {'functions':boundary['unchangedMeasuredFunctions'],'scope':'whole-function byte equality, no new runtime execution'}
 ],
 'truncationHandling':'Large combined reads were visibly truncated; the critical runner/contract/fixture/test/composition windows were re-read in smaller calls. No full-source semantic coverage inferred from archive hashing.',
}
(OUT/'READSET.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'report':meta(OUT/'REPORT.md'),'readset':meta(OUT/'READSET.json'),'entries':len(readset),'heavy':0,'queued':0},ensure_ascii=False))
