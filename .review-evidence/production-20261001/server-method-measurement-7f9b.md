# Измерительная ось: immutable 7f9b, UTF-8 и hash-byte closure

**PASS в ограниченной области изменённого закона хеширования и собственного
переноса измерительной методики.** Доказанных measurement blockers нет.
**Actual performance qualification — UNPROVEN; registered timing samples = 0.**
Этот отчёт завершает одну ось одного frozen source и не допускает будущий
source, actual sampling, всё CI, release или глобальный production GO.

Исходная цель сохраняется: production качество Lab Colors/Lab Motion и
содержательный серверный аналог при отсутствии Android и нерепрезентативности
мощного iPhone. Серверная клетка не удостоверяет physical FPS, 60/120 Hz, GPU,
энергию, mobile, восприятие, человеческие/adoption claims. Lab Colors и другая
review axis здесь не проверяются.

## Идентичность объекта и норма

| Объект | Exact значение |
| --- | --- |
| Source Git | 7f9b85d82bdf531455a8eb0fae4406484205ef83 |
| Tree | c2e2f99aa6ab5623d86b1172242fa07b6b8a893f |
| Parent Git | 8f45bb258d0cc8dc33e2254eef7dd650acc9e1c8 |
| Input PRIMARY | /tmp/motion-server-method-admission-cost-delta-20261001T1940Z/PRIMARY-PACKET.json |
| Input PRIMARY SHA256 | d6b1b9c0238c9b5b5fd3c79ce1425dcd21f5adef359ab5776964573f82754299 |
| Source archive SHA256 | 8cfd15a20fe299e785635fa5422ecbfe6d404c13138cc153bc922136f7bbbe48 |
| Source archive | 1 749 049 B; 631 regular source files |
| Source diff SHA256 | 8ac0f970592cc56135f19fd3a7700f860e66ef8c9c026d917deac0dda451a3d4 |
| Old contract SHA256 | 6bdbe03b9837ba2dd1959963f02fd0434597e9839a82d95e31b7ba738b9f5d1b |
| Current contract SHA256 | 9f2ae0da9c171221d86dd8f7ca4611818f94ce5d0fbe2d9dffc59e85e9a75161 |
| Protocol digest | 7016c19aa7a763fee68687327ef489abb119acd2a43d397b8485ca56e4cea15f |
| Clock-model digest | 7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f |
| Frozen norm Git | 85a837e83912ec6b3144b385d938b66a0c63adcf |
| Own writes | /tmp/server-method-measurement-admission-7f9b-20261001 |

Все 52 allowlisted primary inputs независимо rehashed. Archive извлечён в
собственный read-only snapshot; входной archive не редактирован и не дублируется.
input-rehash.json содержит exact SHA/bytes 52 входов и 631 retained source.
Hash-only records не означают семантическое чтение каждого файла.
15 affected owner/module файлов равны exact immutable Git blobs, mismatch 0.
Из 14 whole owner files изменился только contract; остальные 13 совпадают с
собственным завершённым 8f45. Imported closure, explicit ranges, старые
первичные references и outputs перечислены в exact-readset.json.

Норма — frozen AGENTS/SPEC/TEMPLATE/PARALLEL/r11/r12/ACTIVE/CLAIM/ACTIVATION,
девять файлов, с exact hashes в norm-bindings.json. r11 активна, r12 prepared
и не даёт sampling/activation grant. Авторские HANDOFF/RUN-PLAN/CLOCK-CERTIFICATE/
QUALIFIED-TRANSFER/rationale, чужие REPORT/verdicts/PR bodies/comments не читались.
Live dirty source не использован. Remote CI logs/summaries не использованы как
независимое доказательство. Own-chain qa/performance/numerics/verify сохраняют
требования independent oracle, невакуозного отказа и ограниченного переноса.

## Две точные изменённые границы

В serverArtifactDigest маленькие string chunks объединяются перед native SHA-256.
Предел 65 536 означает UTF-16 code units. Это внутренний buffer и не новый N,
лимит raw, размер sample, timeout или условие отбрасывания данных. Для BMP такой
buffer может иметь почти 196 608 UTF-8 bytes. Chunk с length >=65 536 проходит
прямо в hash после flush прежнего pending; EOF flush сохраняет последний suffix,
включая прежний newline. Сам lazy serializer и writeServerArtifact не изменены.

В validateServerJournal тело квитанции по-прежнему получается одним
JSON.stringify(payload) после прежнего object rest. Native SHA получает UTF-8
string вместо Buffer.from(text). Когда text===undefined, прежний Buffer.from
всё ещё вызывается и выдаёт прежний TypeError. Нет cache по artifact/record
identity, обхода chronology, failure union, raw matching или повторной
проверки тел допущенных квитанций.

exact-loci-proof.py самостоятельно заменяет только эти две перечисленные
source loci на их old bytes. Весь результат, 64 246 B, строго равен old contract
с SHA6bdbe03b... . Поэтому clock primitives, mean/quantile/statistical bounds,
units, parser, RLE/raw serialization, journal chronology, N/stopping policy,
failure union и guards имеют те же exact bodies. source/runner и factory также
не менялись. Изменённые post-data hash sites не помещены внутрь защищённых
engine/browser API-cost clock intervals. Исторический test-cost callback имеет
тот же SHA7d1e66d8... и прежний 30 000 ms test timeout; его author raw observations
не превращаются в package performance samples или гарантию CI скорости.

## Почему UTF-8 bytes сохраняются

Успешный serverArtifactChunks выдаёт целые результаты native JSON.stringify
для values/array items, целый JSON key token либо punctuation/newline.
Native well-formed JSON.stringify экранирует lone UTF-16 surrogates, а обычная
surrogate pair находится внутри целого строкового token. На успешно
сериализованных границах chunks нет пары, которую можно заново соединить из
высокой/низкой половины разных chunks. Следовательно UTF8(c1)+UTF8(c2) равен
UTF8(c1+c2) для этих фактических chunks.

Инвариант нового loop: уже переданные SHA bytes плюс pending strings в прежнем
порядке равны сериализованному prefix, прочитанному generator-ом. Flush меняет
только группировку updates. Ветка long/non-string сначала сохраняет старый
pending, затем передаёт текущий chunk. Финальный flush сохраняет весь suffix.
Хеш зависит от последовательности bytes, а не числа native update calls.
При исключении digest не возвращается; unchanged writer сохраняет тот же
частичный UTF-8 prefix и закрывает descriptor в finally.

Этот аргумент относится к фактической immutable native JSON/UTF-8 среде и
generator-у. Он не утверждает эквивалентность произвольного monkeypatched
JSON.stringify или произвольных внешних chunks. Pre-existing array-own-toJSON
поведение serializer-а также сохраняется; не заменяли его другим JSON traversal.

## Свежие independent byte и mutation witnesses

Own Node binary самостоятельно rehashed:125 989 464 B,
SHA bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12,
совпадает с прежним зарегистрированным official Node. Frozen old/new contract
модули реально импортированы. Probes используют env -u NODE_PATH только у своих
children; product environment, clock model и protocol не редактированы.

hash-byte-probe сравнивает lazy chunks/read traces, old/new digest и actual
writer files, включая partial files. Python independently конструирует
ожидаемые UTF-8 bytes для каждого corpus case и считает hashlib.sha256; он
не вызывает method hash function. Все old/new bytes совпали с его expected
carriers, strict UTF-8 decode и SHA. Полные bytes сохранены отдельно от таблицы.

| Corpus case | Expected bytes | Наблюдаемый результат |
| --- | --- | --- |
| plain-finite-tags | 189 | точные bytes и digest |
| chunk65535 | 65545 | точные bytes и digest |
| chunk65536 | 65546 | точные bytes и digest |
| chunk65537 | 65547 | точные bytes и digest |
| BMP3-byte65535-codeunits | 196611 | точные bytes и digest |
| astral65535-codeunits | 131078 | точные bytes и digest |
| lone-surrogate-escaped | 44 | точные bytes и digest |
| many-small-chunks-multipleflush | 183791 | точные bytes и digest |
| lazy-getter-toJSON | 72 | точные bytes и digest |
| array-own-toJSON-preserved | 20 | точные bytes и digest |
| late-BigInt-exception | 51 | точный prefix; ожидаемый отказ |
| late-throw-undefined | 36 | точный prefix; ожидаемый отказ |
| top-undefined | 0 | точный prefix; ожидаемый отказ |

Cases на 65 535/65 536/65 537 code units различают pending и direct ветви.
BMP и astral различают code units и UTF-8 bytes. Lone-surrogate/escape cases
различают well-formed JSON и неверную кодировку. Множество small chunks проходит
через несколько flush, без удаления или переупорядочивания. Getter/toJSON read
order совпадает. Повторный вызов на том же объекте заново читает toJSON, а
изменение value/array меняет digest; неизменённый объект даёт прежний digest.
Ни cache между calls, ни утрата последнего tail не маскируются одним snapshot.

Два independently reconstructed faulty алгоритма обнаружены oracle: удаление
финального pending flush даёт SHA пустых bytes для short carrier; UTF-16LE
вместо UTF-8 даёт другой digest при Unicode. Эти faults имеют существующие
все поля и действительную hex SHA форму; отличие относится к полезным bytes.
Python подтвердил также оба неверных digest против собственного правильного.
Контрфактический helper создан внутри own probe; product source не менялся.

Raw: hash-byte-result.json SHA2b13065941089541e009a1c49e1c9ab36043d1d3bbd367427e8c5aa1d9eb7827;
independent reference: python-byte-oracle.json SHA279f40d4d31d44983bd4d4e0a8ebcb2bbb1c661c3db1387462bebeabd6f3dc0a.
13 corpus cases — witnesses конкретных ветвей; PASS не выводится из числа tests.
Полный источник каждого factory, ожидаемый carrier, actual bytes, read order,
тип/сообщение исключения и digest доступны для самостоятельного replay.

## Journal, public reception и поздний acquired prefix

Первый intact history — целый preparation-refusal. Второй — зарегистрированный
synthetic prefix двух engine rows и поздний failed stock-C sample до pilot/N:
это ровно тот порядок первого stock-C tuple, что выдаёт current stage plan.
Значение ошибки включает собственное историческое actual-helper acquisition
11ab с fake CPU: семь completed repetitions, 1 998 завершённых operations
failed repetition, все 1 998 values/frames, одна actual сохранённая CPU/clock
edge и unfinished operation. Это исторический synthetic input, не новое timing.

Raw artifact и journal декодируются независимо, как в публичном CLI. Chain
собирается собственным UTF-8 Buffer/SHA oracle, без нового body-hash helper.
Оба intact journal действительно проходят current и old validateServerJournal
и actual current public CLI. Их lawful результат — UNPROVEN, поскольку
измерительная серия не завершена. Это reception сохранённого отказа, не
performance PASS и не обход minN. Все поля, records и raw/journal bytes сохранены.

| История / coherent falsifier | Actual результат |
| --- | --- |
| valid-setup-refusal | CLI exit 0, UNPROVEN |
| valid-setup-refusal-stale-Unicode-body | server profile: повреждена цепь журнала |
| valid-setup-refusal-UTF16-final-digest | server profile: финальная квитанция не связана с raw/вердиктом |
| valid-late-acquired-prefix | CLI exit 0, UNPROVEN |
| valid-late-acquired-prefix-stale-Unicode-body | server profile: повреждена цепь журнала |
| valid-late-acquired-prefix-UTF16-final-digest | server profile: финальная квитанция не связана с raw/вердиктом |
| lost-late-acquired-value-with-coherent-final-hash | server profile: failures потеряны или добавлены вне журнала |

Изменённый extra Unicode body не затрагивает semantic chronology, raw failure
union или final raw digest: поэтому отказ достигает именно новой проверки
record body SHA, а не missing-field gate. Wrong-encoding final digest имеет
полную ре-hashed цепь, но не соответствует фактическому raw. Потерянное значение
late prefix меняет только independently decoded artifact, с пересчитанными
final raw/journal hashes: первоначальное journal error остаётся целым, и failure
union отказывает. Это проверка drift уже опубликованного raw witness, а не
утверждение об аутентичности любого произвольно заново изготовленного пакета.

Дополнительные direct JS boundary probes заставляют record.toJSON вернуть
undefined или throw undefined. Old/new body hash вызывают его ровно один раз
и сохраняют прежний тип/сообщение TypeError либо actual thrown undefined.
Такие hooks не приписываются JSON file inputs; проверяется changed callable seam.
Journal raw/result SHA381ed2d2478d2fb2f4db37d415dc093afe9709aeedee308eae3e12545641083e. Intact public raw, ndjson и
exact CLI argv/stdout/stderr/exit receipts находятся в journal/.

## Измерительная и численная область переноса

Own 11ab и 8f45 reports/primary могут использоваться только по exact readset.
В current source единицы остаются CPU потока user+system ns для engine и
realm-local elapsed API ms для browser. Browser batch/32, positive64actual/32;
stock C — 2000 целых штатных MotionValue macros, positive4000/denominator2000.
Factory и2×2000warmups вне CPU, конструкция/subscribe/setTarget/drain/destroy и
symmetric recording внутри; RLE/oracle вне timed interval. Mean47/100 не
заменяет каждый actual finite outcome. Старая проверка full macro chronology,
actual2×work и reachable hidden-mean defects переносится по whole helper/runner
SHA, а не по авторскому выводу или данному hash corpus.

CPU pointwise uncertainty остаётся ±2000ns для двух user/system endpoints,
для stock/2000 — ±1ns/op. Browser interval включает2×(5µs clamp+1µs truncation)
и outward binary64 error. Systematic envelope не уменьшается repeats/N.
17 pinned upstream primary sources и official binary/model assumptions остаются
прежними; observed timer quantum не certificate error. Browser publication
relation, onset/read/window guards и refusal при неразрешимости не изменены.
Own8f45 fresh helper witnesses healthy128/duration64/first-publication75px
переносятся только по exact identical compare/semantic/numerical bodies.

Independent statistical unit остаётся mean двух противоположных runs блока,
условно IID в frozen клетке. p50/p95 — quantiles mean blocks, не кадров/API calls.
11cells×2quantiles×2participants×2tails, per-tail1/1760; exact BigInt binomial
owner unchanged. Own Python math.comb reference:145blocks ещё не ограничивают
upperp95,146 — минимум292runs; p95 ranks129..146, p50 ranks53..94;512blocks
p95 ranks469..502. Outward point bounds входят до CI/participant ratios.
Max1024, NI1.05, positiveLower1.5, MDE5%, power0.8, duration128, seed,
30s timeout, counts/stagger и stopping rule сохранены. Pilot8runs/4blocks
планирует mean log contrast normal approximation, не обещает tail power.

Freeze-before-data, baseline-only pilot→frozenN→один actualA/A и actual2×work→
A/B только при PASS calibration остаются прежними. Post-hoc selection,
retry-to-green и добор не добавлены. Source/package/env/raw/journal provenance,
failure union и cgroup/affinity/quota controls сохранены. Все10 старых guards,
size gate, numerical tolerances и independent canonical1200ms scope сохранены.
Конечные controls не доказывают каждое stateful поведение или физический envelope.

Unchanged full-N и max1024 broad suites заново не запускались, как предписано
scope. Own11ab fullN292 coherent healthy CLI и acquired-late-failure CLI,
910707485uncompressed B/45143636lossless gzip B с четырьмя fullSHA readbacks,
переносятся только как историческая проверка unchanged parser/serializer/N
law. Новый digest byte proof сохраняет ту же последовательность независимо от
N; здесь не утверждается новый fresh fullN runtime, real calibration либо
30s CI speed guarantee. Source diff и UTF-8 fixtures допускают affected law,
а actual package performance остаётся UNPROVEN.

## Команды, сохранение и пределы

Все actual commands/cwd/start/end/exit/nontruncated outputs в commands.jsonl.
Substantive isolated replay, после копирования exact own snapshot/probes в новый
writable scratch и проверки hashes:

    env -u NODE_PATH node hash-byte-probe.mjs
    env -u NODE_PATH node journal-probe.mjs
    python3 python-byte-oracle.py

Own scripts создают retained filenames; sealed copy read-only. Replay делать
отдельно, старые raw/partial files не затирать. execute-bounded.py содержит
10s review-window orchestration, а не изменение product timeout/N/stopping.
Actual children: 2026-10-01T19:59:01.698345+00:00 → 2026-10-01T19:59:02.149208+00:00;
оба exit0; children closed, ownheavy0, slotfree. Browser/build/actual pilot/
calibration/timing или complete fullmethod sweep не исполнялись.

В текущем own epoch нет неожиданного HARNESSERROR или methodFAIL; все ожидаемые
negative controls и partial files сохранены. Два прежних own8f45 environment
refusals остаются отдельно в прежнем read-only epoch и не переписаны.
Primary before/after cost commands/raw описывают diagnostic existing test
callback, actualregistered0; они не являются performance qualification,
необходимой CI совокупностью или авторским основанием этого PASS.

Вердикт conditional на exact источниках, штатном native JSON/UTF-8/SHA и
указанном readset. Будущие изменения serialization/hash/parser, source, package,
runtime, clocks, protocol или env требуют affected closure. Source HEAD/tree
не заменяет окончательный product package/artifact/quiet ACK. Actual sampling
grant отсутствует: **actual registered timing samples ровно0**.

REPORT/readset/outputs связаны terminal/output manifests и full readback receipt.
Отдельный PRIMARY packet содержит только source/probes/inputs/raw/commands/
hashes; REPORT и reviewer/author rationale туда не включены.
