# Аддитивное независимое review: default MotionValue lifecycle cost и граница переноса

**INCOMPLETE для полной добавленной стоимости и production acceptance.** Новая raw первичка показывает рост справочной медианы полного default MotionValue цикла с **7.2k до 8.3k ns/op**, при прежних **47 кадрах**. Это существенный сигнал для сохранённого старого пути; доказанного нарушения конкретного численного gate этим опытом нет. Подтверждённых новых product-contract findings с применимым порогом и действительным falsifier — **0**. Ранее выданные собственные bounded PASS по ownership/package/consumer сохраняются; они не принимали runtime performance и не покрывают новый cost question.

Исходное намерение пользователя — полностью довести lab-colors и lab-motion по планам agents-config до производственного качества. Уточнения об отсутствии Android, нерепрезентативности мощного iOS и содержательной серверной альтернативе сохранены. Эта проверка ограничена одной осью последствий второго порядка: кто платит полную цену старого MotionValue lifecycle, что покрывает evidence и существует ли более простой достаточный путь. Numerical/runtime correctness, методическая разрешимость, статистический timing verdict, scientific/device review и общая CI-приёмка здесь не выполнялись. Новые timing samples не получены.

## Объект и независимость

Продуктовый объект — frozen packet `/workspace/lab-motion/scratchpad/runtime-upstream-final-cut-20261001T124549Z`. Его source-readset SHA256 — `8f5b59054b7bf088f8f312e0d9e1645a2c6579ed8a78ef28f1120b552c4c24f6`; runtime fingerprint — `f04ad03aeaf49d4dd6cea882f1e56fec90502c1ed2c6b525aa6e923c2e7ffb78`. Он содержит **621 runtime/verification + 304 production-dist = 925 bound files**, и отдельно **10 method-context-only**, исключённых из runtime identity.

Immutable baseline — `0b6f537e148b7dadadfb9e3ce7c446d014975958`; clean final из нового raw опыта — `8fb55ca0a116e5381a43351ab28834d17a4a9299`. Собственный byte readback всех 935 packet files прошёл. Все **621 tracked bound файла final Git** совпадают с packet; остальные **304** — generated dist, связанные ниже с actual packages. Это equivalence runtime/verification bytes, а не equivalence всех bytes целого commit. Контекстуальный HEAD packet — `30e73995002422376ec763d2026cbdee19a34f42`.

Дополнительный источник — `/tmp/motion-default-cost-final-20261001/manifest.json`, SHA256 **`95ce57889f9014fcfbcaa9c62040abba8568541a8611d88fc4741daafe7241ed`**. Прочитаны его metadata и девять разрешённых raw/source/receipt файлов. Manifest содержит также entry `REPORT.md`; **его contents не читались и не хешировались reviewer**. Author cause/hypothesis/HANDOFF, чужие reports/verdicts и PR body/comments не использовались. Предыдущая собственная цепочка разрешена и сохранена.

## Применимая норма

Использованы exact bound `primary/norm/AGENTS.md`, `plans/SPEC.md`, ACTIVE/CLAIM/ACTIVATION, current r11, activation bytes и status-only delta. ACTIVE указывает **r11**; CLAIM относится к **PROFILE-01**, не даёт release grant. Подготовленная r12 не становится действующей нормой от этого опыта. Исходные caps, 59-cell vector, Pareto и защищённые merge/release/deploy границы не менялись.

AGENTS:107–116 требует восстановить затронутых consumers и принимать улучшение по потребительскому результату и полной добавленной стоимости, включая вариант ничего не связывать. AGENTS:127–132 требует immutable independent single-axis review, включая последствия второго порядка для существенного среза. AGENTS:103–105 не разрешает новое постоянное решение только потому, что выявлена проблема.

r11:197–226 сохраняет INV-01/02/05/10/11/12: старые свойства; один numeric/time/output owner; раздельные start/interrupt/frame/teardown, CPU/GC/memory и ownership; exact evidence без изменения thresholds ради зелёного результата; Pareto для GO и действительный falsifier для NO-GO; сначала remove/reuse/specialize. **INV-05:207–209 прямо запрещает оплачивать рост другой protected клетки нижним старым ratchet.** M-01:124 сохраняет прежний NI-допуск во всех старых matched-workload клетках. G-PERF:448–455 сохраняет разные denominators для startup/frame/teardown и сравнение с самым простым working control. r11:135 требует `UNPROVEN`, когда цель не разрешается измерением.

Эти требования не создают новый численный порог для ungated stock bench. Его source `scripts/bench.mjs`:4–17 прямо говорит, что ns/op справочные, wall-clock зависят от машины и скрипт speed gate не является. Старое protected p95 upper ≤1.05 из G-PERF:445 относится к своей зарегистрированной области; stock median не переименован в такой p95 и не сравнивается с этим порогом.

## Связка raw → source → dist → actual package

Собственная команда — `python /workspace/scratch/motion-runtime-second-order-final-20261001-default-cost-supplement/bind-inputs.py`. Выполнялись только read/hash/copy и immutable Git plumbing: `git ls-tree -rz --full-tree <revision>`, `git cat-file --batch`. Полный argv/output SHA readback сохранён в `commands.json`. `node scripts/bench.mjs` ниже — команды предоставленного первичного опыта, **reviewer их не повторял**.

Raw runner `run.py`:77–125 запускал baseline, затем final; оба — `node scripts/bench.mjs`, без override defaults. Проверены exact heads, пустые before/after Git statuses, exit 0, отдельные stdout hashes, равенство before/after dist maps и равенство отдельных execution receipts с `receipt.json.results`. Final **304/304** dist hashes совпадают с packet source-build proof и с обоими actual tarballs; baseline **304/304** совпадают с его отдельным actual baseline tar. Состав каждого tar также прочитан и записан в `package-member-readsets.json`.

| Связанный объект | SHA256 |
|---|---|
| baseline actual tar, 560519 B | `3787bfcc0b9b4302d826984cefc29a0a5ff7142d60a52d721c8d2f1397125470` |
| final actual PNPM tar, 562846 B | `46c9067832760159d35ccd2166b28e6486a57602b1e96d6d23e1c4c06804a402` |
| final actual npm tar, 560840 B | `364f9ff8b505191965040eb17059a034e2cb39be5dd0b1468855ca7e9c61c524` |
| packet primary manifest | `a783473b106a206152b1e7c082e6e29225d6be172ad959101898af92bd6bee61` |
| source-build-byte-proof | `a930133462b96442f0a6aff46dfa2fa22e27bd395d57e47719a591f893d9fb34` |
| frozen runtime-base.diff | `03f7507530b338f55f2403daed1eac2b0041b5bfce210fa7ad813c408b588d64` |
| whole stock scripts/bench.mjs, обе Git revisions, 20593 B | `c99942da29f7055ac9d3b2eea2648550bae8a16be7e7bb158fe8a106cc95bfb9` |

`scripts/bench-support.mjs` и `bench/compare/provenance.mjs` также совпадают между baseline/final. **Транзитивный method-context module `bench/compare/methodology.mjs` изменён:** baseline `1fca0749296ce5c74d819db2b8a7265306acead7cf3da1b4a4e06e2e9a428643`, final `e090f47784312a3fc936326157747f346718e2245c275eed62b41cf0de0b1702`. Поэтому «одинаков весь script dependency graph» не утверждается. Defaults и тело MotionValue workload в неизменённом stock script одинаковы. Method module отдельно связан как source dependency; его методическая правильность здесь не принимается, equality с исключёнными method-context bytes старого packet не предполагается.

Raw environment в обеих execution receipts: Node **v24.19.0**, pnpm **11.11.0**, Linux **6.18.44 x86_64**, AMD EPYC 9V74; affinity `[0,1,2,3,4]`, cgroup `cpu.max = 400000 100000`, cpuset `0-4`, memory.max `17179869184`. Node path `/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node`; pnpm path `/tmp/motion-server-toolchain-20261001/bin/pnpm`. В обоих run counters `nr_throttled` и `throttled_usec` имеют delta **0**. Это bound reported environment supplied experience; оно не становится доказательством отсутствия всех JIT/GC/context effects или полной исторической binary identity toolchain.

## Что действительно измерено

`scripts/bench.mjs`:298–315 — полное выполнение одного old default bounded scalar owner:

```js
const clock = makeClock();
const mv = new MotionValue({ initial: 0, spring: SPRING, requestFrame: clock.requestFrame });
mv.onChange((v) => (last = v));
mv.setTarget(100);
frames = clock.drain();
mv.destroy();
return last;
```

SPRING = mass 1, stiffness 170, damping 26; clamp не переопределён. Новый clock на цикл, requestFrame возвращает ненулевой handle; drain синхронно исполняет queued callbacks без timestamp. Цена включает создание clock/value, subscription, initial publication, setTarget, весь frame loop, финальный output и destroy. Возвращённый unsubscribe не сохраняется и не вызывается. Это не стоимость одного кадра, не только solver и не отдельная teardown метрика.

`measure`:95–107 использует 2000 итераций × 7 timed samples, два warmup прохода; возвращает одну медиану. `fmt`:409 округляет большие значения до одной цифры после десятичной точки с `k`. Raw stdout сохраняет итоговые округлённые медианы, **не семь отдельных sample durations**. Printed frames — значение переменной после drain, не независимая trace каждого цикла. Равенство 47 кадров в обеих строках подтверждено stdout; полная динамическая frame-count/convergence истинность не принимается этой осью.

| Данные raw опыта | Baseline | Final |
|---|---:|---:|
| MotionValue полный цикл, printed ns/op | 7.2k | 8.3k |
| MotionValue printed ops/sec | 139.2k | 121.0k |
| Printed frames | 47 | 47 |
| Wall всего stock bench, включая build и другие workloads | 35.839447679 s | 35.698670964 s |
| User CPU всего child subtree | 40.610740 s | 40.105030 s |
| System CPU всего child subtree | 1.628552 s | 1.583173 s |
| Exit | 0 | 0 |

Отображённый whole MotionValue median выше. Это **наблюдение данного supplied experience**, не новое CI, effect-size estimate с доверительной границей, доказательство постоянного slowdown или cap failure. `receipt.json` и manifest сохраняют **registeredPerformanceSamples = 0**; receipt сохраняет **gateInference = false**. В данном review этот статус не изменён.

Меньшая общая длительность stock benchmark не устраняет observed MotionValue cost: общий wall включает build, cold compiler/cache cases и другие loops. Аналогично printed drive() 6.9k → 6.6k ns/op не оплачивает MotionValue lifecycle. Отдельная frame-only проверка не покрывает subscribe/start/destroy: существенная цена может оказаться именно там, даже при сохранённом frame owner.

## Подтверждённые последствия второго порядка

**Старый default путь теперь оплачивает дополнительную работу без activation compositor/recipe/compiler.** Immutable `src/motion-value.ts`:227–244 и actual packed ESM/CJS `dist/index` показывают безусловный `new WeakRef(cb)` после успешной первичной subscription. Baseline:229–244 такой операции не содержит; его unsubscribe замыкал callback и instance. Current unsubscribe замыкает listener Set и WeakRef; callback по-прежнему принадлежит существующему Set. Даже caller, который игнорирует off, проходит создание WeakRef. Это установленный source/packed факт о границе стоимости, а не численное объяснение всех 7.2k → 8.3k.

Current destroy:318–322 обнуляет существующий scheduler owner и очищает тот же Set. Появление этой цены **не создаёт второй numeric/time/output owner или новую component lifecycle boundary**. Ранее принятые структурные свойства не опровергнуты. Однако цена root MotionValue subscription не является только ценой нового optional compositor handoff: stock workload вообще не вызывает handoff. Локальное уменьшение кода/retained edges не позволяет автоматически назвать полную цену оплаченной.

**Серверный animate NI имеет другую область.** Для проверки coverage прочитаны только immutable workload entry/source из clean final, без method/clock/statistics verdict: `server-profile-registration.mjs`:24–27; `server-profile-runner.mjs`:153–175; `bench-transform-support.mjs`:248–290,365–443. Engine scenes — `scalar-live-100` и `transform-fresh-1000`; обе передают **animate** в `runTransformLifecycleSample`. Options — **duration 128 ms, LINEAR**, targets со style, прежний/new animate, шесть frame offsets `[0,16,32,48,64,80]`, cancel и drain. Имя scalar-live-100 не делает это stock MotionValue spring workload.

Ни `new MotionValue`, ни пользовательское `mv.onChange`, ни полный bounded 47-frame spring/destroy sequence не заменены этими animate targets. MotionValue упоминается в `src/animate/index.ts`/`channels.ts` как канон в комментариях, что само по себе не является выполнением public class subscriber path. Общая numeric/time authority не означает одинаковый lifecycle cost. Поэтому даже будущий valid animate NI PASS сможет принять свои engine/browser клетки, но **не закрывает наблюдённый here root MotionValue вопрос автоматически**. На момент данного дополнения registered samples — 0; timing admission отсутствует в предоставленной первичке.

Это реальная граница переноса evidence по INV-05/10 и G-PERF, а не новый finding против runtime: неподтверждённая общая total-cost приёмка должна оставаться открытой. Product GO не получается объединением прежнего package PASS с будущим PASS другой workload клетки.

## Самое простое допустимое решение и недоказанные гипотезы

Сильный простой контроль здесь уже существует: exact baseline public MotionValue и неизменённый whole lifecycle workload. Для оценки добавленной цены достаточно усилить **существующего владельца проверки** адресным preservation proof именно subscribe/start/full run/destroy с тем же public consumer contract и отдельными denominators по действующей процедуре. Отдельный profiling framework, новая consumer generation protocol, обходной scalar API или заявление об оплате через другой animate workload не требуются. Данное raw evidence сохраняется как descriptive сигнал, без ретроспективного preregistration или нового порога.

Простой old strong-capture unsubscribe — реальный baseline control стоимости, но не автоматически admissible replacement: сохранённый off может удержать callback/instance после очистки Set; current terminal ownership закон намеренно это устраняет. Удалить WeakRef ради одного timing результата без сохранения retention contract нельзя. «Создать WeakRef только при вызове off» также не доказывает освобождение callback у никогда не вызываемого, но сохранённого off. Новый Map/index/slot/registry мог бы быть candidate representation, но его duplicate-subscription semantics, terminal clearing и полная цена не доказаны; готовым более простым working solution он здесь не объявляется.

Наблюдение не различает вклад WeakRef, changed MotionValue object/scheduler representation, JIT/code shape, GC и последовательного порядка baseline→final. Source доказывает дополнительную обязательную WeakRef операцию, **не доказывает её долю wall time или причинность всей разницы**. Исходник показывает существенный discriminator — subscriber allocation/capture path, однако отдельного causal probe или нового timing опыта reviewer не выполнял. Эти explanations не меняют допустимое ближайшее действие: сохранить raw signal и закрыть адресную old-owner cost область без ослабления functional/retention требований.

**Минимальный remaining proof для расширенного cost claim:** назвать точную matched MotionValue область и применимый действующий допуск либо явно удержать descriptive claim; связать whole old/default lifecycle с exact artifact/environment и предусмотренными controls/denominators по существующему owner; сохранить неудобные observations и их ограничения. Если нужны новые inferential данные, их acquisition/preregistration — отдельная координированная работа соответствующего owner, а не повтор этого опыта к green. Ни invented stock cap, ни reopened whole unchanged matrix не требуются данным review.

## Собственная цепочка и перенос

Проверены unchanged все **1445** файлов своего предыдущего upstream manifest и все **805** файлов minimum-peer supplement. Их исторические bytes не перезаписаны:

| Собственный artifact | SHA256 |
|---|---|
| upstream report | `37a3d4b5a5c2f6a24d0f797badd02d2f809922fffa9051d0ebb4e47d02b3c3c5` |
| upstream manifest | `31070b14a2d7672f1c694eaa6e8c21de1c9397428e55c101ab04029889b975e9` |
| React18.0 minimum report | `7b0d8c73c556ebefdb13ee1ba94875a69145ad614843dac8df97e593c231063f` |
| React18.0 minimum manifest | `f821793c0f27cf08c602075b8d6c82d57bdb3d7de17f333efb6d024584f037e8` |

Structural owner/public surface/recipe histories и actual Node22 ESM/CJS peer SSR proofs остаются bounded PASS по unchanged bytes. Исторический full ordinary FAIL 4889/4890 не объявляется текущим whole-head CI состоянием или исчезнувшим вследствие stock bench exit 0. Full React client/StrictMode/hydration/type floor, WeakRef-less historical support premise, arbitrary inaccessible closed-tree premise, device envelope и numerical/method/performance proofs имеют прежние ограничения. Raw Node24 stock bench не переносится на Node22 floor, браузер, Android/iOS или физическую частоту экрана.

Изменение relevant runtime/types/exports/peers/recipes/build/support envelope аннулирует affected прежний перенос. Изменение stock workload/defaults, measured bytes, toolchain/environment или применимого закона аннулирует affected cost observation/coverage conclusion. 10 excluded method-context files не приняты как runtime law; три source файла profile и один stock methodology dependency прочитаны отдельно только в указанной coverage/dependency области. Никакой перенос их методического acceptance не выполнен.

## Exact input readset и воспроизводимость

Все 665 copied input files перечислены с origin/copy/size/SHA256 в `semantic-input-readset.json`; роль direct semantic versus mechanical source binding уточнена в `semantic-selection.json`. Copy/hash всех 621 source файлов **не является semantic acceptance всех этих строк**. Hash-only full packet readset — `packet-source-byte-readback.json`; immutable Git/current source equality — `immutable-source-binding.json`; фактические tar members — `package-member-readsets.json`; default packed source snippets — `packed-default-owner-source.json`; raw linkage — `primary-byte-binding.json`; прежние собственные digests — `own-chain-preservation.json`. Exploratory clean-final `server-profile-contract.mjs` и `bench/compare/bench.mjs` также связаны как прочитанный source context, без принятия их method/verdict logic.

| Разрешённый raw input | SHA256 |
|---|---|
| baseline.execution.json | `c46cb9491aad292f394d30164fa2b48217a8b783c3eaa667e73c68f3d5b0b2ef` |
| baseline.stdout.log | `28b5cdb758254fba1c49b658541a2ecfe0e840e0ed53d108cfe03f82e8ca205b` |
| final.execution.json | `1b8f5c20c38811b08d52fb8868da74dd4bb4dd81872b568cda2c03c0fb93e6c0` |
| final.stdout.log | `1ccde5b80240f0abdf9806d0543a6782fe4b5799af80083b933775e578973b73` |
| baseline.exit и final.exit, каждый `0\n` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| preflight.json | `5d16fe234dce2cae4f42278028485eb55e858834617b80111286be48a6f3c9a1` |
| receipt.json | `6dd43ba9751ce0a06ac5ab08b9669293dec38027ed534697ef23a0da2f3e7c8d` |
| run.py | `ea078a5e0c69326ebdf07481893e733784bd4d7d7094c761cc5f859e4355e84d` |

| Нормативный input | SHA256 |
|---|---|
| AGENTS.md | `0e1376312cedf91660b1c919ba4c1a9a6e067fe8719eb8daeb52113508b28f0a` |
| SPEC.md | `7488d5885ee2405d678e488e34a84ce48254978c3a6ad3de2e4d31dfe7b3f651` |
| current r11.md | `cbeef108b288502165437c375bb259f3f4d6dc8ae4ae9e926db133adeba40d4b` |
| immutable activation r11 bytes | `fd0529ff43365afc3bc6f34ae2be51aca1e18a2dad26d6fb2a640124aeba8306` |
| activation-to-current status-only delta | `5d260bdf49ef1067e562b7c4ce3a984b18eb07559c47aa54e98b0da50204cb67` |
| ACTIVE.md | `42e36c2efa89912aa00395c938263c1bf35275325420df52ec736b0986606731` |
| ACTIVATION.md | `97e6b6ce4080b5c91d62e7ace5844a3c7aeeaa3bce04b21f832785bc807a4908` |
| CLAIM.md | `56ac2167795a81b9d1a60d2ebc1cb8830a2653cbc45026bbcb2d0b0f8e837fa8` |

Три начальные ошибки собственного byte-binder сохранены в `initial-readback-failure.json`, `second-readback-failure.json`, `third-readback-failure.json` и соответствующих первоначальных script bytes. Это schema/indexing ошибки reviewer: абсолютные manifest paths; отдельный production-dist scope; исключённый transitive methodology source. Они исправлены явным path/scope/dependency binding. Benchmark, product test, source и thresholds при этом не менялись; ни одна ошибка не интерпретирована как product failure. Финальный binder exit 0; повторялись только лёгкие чтения.

`review-output-manifest.json` связывает immutable все outputs/scripts/copied inputs этого дополнения. `terminal-receipt.json` отдельно связывает report, manifest, semantic selection и final readback, избегая self-hash cycle. Никакие runtime/source/norm/budget/workflow файлы не изменены, release/merge/deploy не выполнялись. Heavy slot не занимался; собственные build/browser/full-N/benchmark/consumer processes не запускались. **Все собственные процессы завершены. END; слот свободен.**
