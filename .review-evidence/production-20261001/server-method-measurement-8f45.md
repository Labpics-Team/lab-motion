# Независимая измерительная ось frozen 8f45

Текущий scoped verdict — **PASS** для изменённой dependency boundary 8f45 и
измерительного метода в области собственного переноса от 11ab. Доказанных
measurement blockers нет. **Actual performance qualification — UNPROVEN;
actual registered timing samples = 0.** Будущий source, actual sampling,
общий production GO и другая review axis этим отчётом не допущены.

Цель — содержательный серверный аналог проверки Lab Motion при отсутствии
Android и нерепрезентативности мощного iPhone. Сервер не удостоверяет физический
FPS, 60/120 Hz, энергию, GPU, mobile, восприятие или adoption. Lab Colors и
совокупность product/release gates находятся вне этой единственной оси.

## Идентичность, норма и readset

| Объект | Exact значение |
| --- | --- |
| Source Git | 8f45bb258d0cc8dc33e2254eef7dd650acc9e1c8 |
| Tree | 4d26348ca3085e39c50a2022b57211fe36c2a3a6 |
| Parent Git | 6eae2d41ee9bc213a68a2cf5fa8405bcf85519bd |
| PRIMARY input | /tmp/motion-server-method-dependency-delta-20261001T1806Z/PRIMARY-PACKET.json |
| PRIMARY SHA256 | b09695716f998c5d057bd5472418359a97f70c07969a3d7c1e3b81de2c07ea6a |
| Source archive SHA256 | 3da254fc9faca6fabd003fd03b66a80341aff0f7a82f220e22e1ce22f070c1e9 |
| Source archive size | 1 748 705 B; 631 regular tracked source files |
| Diff SHA256 | 639ae6a285ca3c727581600cdd451a7457d04f8e8969903cca1691999f968a2e |
| New bench SHA256 | 4939941e3fa40f6122619a63483aacd3d3c7375a2dee1b5e320fde653ba27a94 |
| Protocol digest | 7016c19aa7a763fee68687327ef489abb119acd2a43d397b8485ca56e4cea15f |
| Clock-model digest | 7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f |
| Norm Git | 85a837e83912ec6b3144b385d938b66a0c63adcf |
| Own writes | /tmp/server-method-measurement-dependency-8f45-20261001 |

29 input records самостоятельно rehashed; archive извлечён в собственный
read-only snapshot. input-rehash.json содержит SHA/bytes 29 records и 631
retained sources. Hash-only не означает семантического чтения каждого файла.
19 owner/module файлов дополнительно равны immutable exact Git blobs,
mismatch=0. 13 из14 whole owner files и остальные module dependencies равны
собственному проверенному 11ab. exact-readset.json связывает каждый explicit
range, imported closure, norm paths, source hashes и первичные собственные outputs.

Норма — 9 frozen AGENTS/SPEC/TEMPLATE/PARALLEL/r11/r12/ACTIVE/CLAIM/ACTIVATION
файлов по norm-bindings.json. r11 активна, r12 только prepared; это не grant
активации. Авторские CLOCK-CERTIFICATE, RUN-PLAN, HANDOFF, QUALIFIED-TRANSFER,
чужие REPORT/verdict/PR reasoning не читались. Remote CI logs и suite summaries
не использованы как semantic proof. Current dirty live source не импортирован.
Own-chain навыки qa/performance/numerics/verify применены к независимым oracle,
точным единицам и ограниченному переносу доказательств.

## Exact delta и ограниченный перенос

Изменился только способ загрузки esbuild, Playwright, PNG в compare/bench.mjs:
удалены3 eager ESM imports, добавлен createRequire(import.meta.url); esbuild
запрашивается у двух build sites, Playwright перед browser setup, PNG у decode.
dependency-locus-proof.py удаляет только явно перечисленные import/load loci
из old/new primary sources. Оставшиеся54 830 B строго равны, SHA256
6261a0656667a5d8dffa8a637d672ca16441864a846452109c1c54a2cf0db590.
Это буквальное доказательство отсутствия других изменений, не test-count proxy.

Actual semantic helper имеет тот же7106 B SHA
ebcddcf13aca1910f771f536a8d7857ca35f9b7a4023521308b0f6d6be4c2976;
origin+realm timer helper — тот же3204 B SHA
00624184f42f26c21831932adc52770c684c80301d73a269b5b5843dbe0238b7.
13 unchanged owners включают methodology, registration, contract, retention,
runner, stock helper и affected tests/docs. Перенос разрешён только при этих
exact-byte bindings; будущая serialization/hash/cost delta сюда не входит.

Server runner требует собственные esbuild/Playwright до registration/data,
собирает adapters до calibration/warmup. Compare build sites находятся вне
зарегистрированных CPU/browser API-cost clock intervals. PNG первый раз
декодируется в baseline-frame ожидании до CDP start marker, далее после
stopScreencast. Его загрузка может дать штатный setup refusal; Node duration
не добавляется к realm-local API cost или записанным screencast timestamps.
Старые10 guards и legacy canonical1200 ms не менялись.

## Fresh useful-result и reachable-defect witnesses

Перед replay самостоятельно rehashed actual Node binary125989464 B:
bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12;
probe версия v24.19.0. Read-only copy pako —20 bound files, package
SHA49d2c0b74800f46b03a61e8322570068c0893273d97894795bcc89d7090226c9.
Этот copy поддерживает чистый import, не qualifies package performance.
env -u NODE_PATH меняет только review children и исключает globally injected
Playwright/PNG; protocol/product environment/clock certificate не правились.

Реальный frozen compare+runner импортирован без Playwright/pngjs, с отсутствующей
esbuild cache load. Реальный exported runSemanticStartCheck исполнен в независимой
VM модели x=300·clamp(age/(128·factor)+jump), задающей CSS/document/rAF publication
и wall chronology отдельно от acceptance law. Все callbacks synthetic;
никаких actual browser/device timing. Полностью сохранены API before/after,
CSS observations, document/rAF timestamps, acquired semantic carrier,
coherent consumerInput и cleanup. У purported carrier выставлен valid=true,
поэтому отказ consumer не является проверкой producer boolean/отсутствующих полей.

| Witness | Independent expected | Producer valid | Consumer accepted | Consumer reason |
| --- | --- | --- | --- | --- |
| healthy128 | true | true | true | принято |
| duration64 | false | false | false | server profile: normal-motion oracle отверг intermediate/stagger/topology |
| quarter-at-first-publication | false | false | false | server profile: normal-motion oracle отверг intermediate/stagger/topology |

Healthy128 принят; duration64 и скачок75 px при first publication отвергнуты
с independently reconstructed coherent обязательными onset/document fields.
Actual helper cleanup у всех3: connected0. Full raw/chronology в
import-semantic-result.json, SHA5886edd10a40d71c2b2c1ae40ab901c7a673a228b440b8aebf1689dbd1551a47.

loadsite-probe.mjs исполняет exact old/new build/size/scanner функции с отдельным
dependency seam. Entry/format/write/profile build options, adapter path/hash,
raw/gzip/Brotli sizes совпадают. Это seam/contract проверка, не actual build.
Независимый PNG oracle сканирует все pixels;12 tiny image cases имеют одинаковый
left/null, включая другую строку и строгие thresholds >180 и <120. Три missing
dependency cases дают MODULE_NOT_FOUND без fallback/нулевого результата.
Все calls/inputs/image bytes/source fragments/failures сохранены:
loadsite-result.json, SHA6163c480765b19216cafb8d47d4bc548eae8a3ba1a1654dd28c4994470b44b3e.
Допустимый primary API-identity proof подтверждает одинаковые ESM/CJS objects
пинованных bench packages; это raw input, не авторский verdict. Новые dependency
versions/trees или реальные adapters этим tiny seam witness не квалифицированы.

## Current измерительный закон по exact unchanged owners

Engine unit — user+system CPU текущего потока в ns, browser — elapsed API return/
cancel в realm-local ms. Browser batch/32; positive64 настоящих calls/32.
Stock C полезная операция: MotionValue(0/default spring) constructor, subscribe
initial0, setTarget100,47 synchronous updates без frame timestamp, destroy,
return100. Timed repetition2000 настоящих macro calls под одной CPU парой;
positive4000/denominator2000. Factory и2×2000warmups вне CPU; construct/listener/
target/drain/destroy и symmetric per-call recording внутри; RLE/oracle после.
Восемь dependent repetitions не повышают independent N. Не делим double actual
work новым знаменателем и не выдаём CPU за wall waiting.

Own11ab primary проверял old-body/new-helper whole chronology и every finite
outcome:0/94frames и0/200values отказывали при равных mean47/100. Late operation,
throw undefined, undefined/-0/NaN endpoint, broken CPU edge сохраняли exact late
prefix, clock fields, tagged raw и open/closed interval до отказа. Lossless RLE
и chunked public parser имеют те же сегодняшние SHA. Fresh fullN не повторялся:
их owners не менялись, dependency delta не помещает loader в timed interval.

Pointwise CPU error остаётся: два отдельно µs-truncated user/system counters,
endpoint(-2000,0]ns, interval±2000ns; для stock/2000 ±1ns/op. Browser bound —
два endpoints2×(5µs clamp+1µs TimeTicks truncation) плюс outward binary64 errors.
Document-frame publication relation имеет отдельный pinned upstream bound и
chronology guards. Repeats/N не уменьшают systematic envelope. Own integer/
Fraction reference и17 pinned upstream primary sources переносятся только для
unchanged model/official binaries. Observed quantum не certificate error;
другой binary/kernel/model/unsafe counter требует собственного proof/refusal.

Independent unit — mean двух runs противоположного порядка при conditional IID
block distribution. p50/p95 — quantiles этих средних, не отдельных кадров/API.
11cells×2quantiles×2participants×2tails дают alpha1/1760 per-tail. BigInt binomial
owner unchanged; own Python math.comb reference:145blocks upperp95 ещё unbounded;
146 — минимум, p95ranks129..146, p50ranks53..94;512blocks p95ranks469..502.
Point bounds пропагируются до order statistics и participant ratio.
min292/max1024runs,NI1.05,positive1.5,MDE5%,power0.8,seed,duration128 и30s timeout
не менялись. Baseline-only pilot8runs/4blocks планирует mean log contrast normal
approximation, не обещает tail power.

Stopping policy: source/package/env freeze before data, baseline-only pilot→
frozenN→одна actualA/A и actual2×work→A/B только при PASS calibration. Нет retry
to green/довбора/post-hoc selection. Raw failures/partials/journal и cgroup/
affinity/quota checks сохраняются. Finite controls обнаруживают reachable faults,
но не доказывают всякое stateful поведение или весь intermediate curve. Старые
широкие semantic/conformance guards остаются отдельными обязательствами.

Own исторические11ab public CLI N292 witnesses: coherent healthy PASS-server-cell,
late actual-acquired failure UNPROVEN/partial-samples-refused. Не actual timings.
Raw+journal910707485 B losslessly сохранены в45143636 gzip B,4 fullFIFO readback
SHA/bytes совпали. prior-primary-references.json и compressionreceipt связывают
каждый compressed/uncompressed SHA. Current exact owner bindings позволяют
перенести этот parser/lineage контроль; это не новый actual8f45 fullN experiment.

## Отказы harness, реальные команды и пределы

Первый отказ — чрезмерное own предусловие отсутствия всех3 deps, не productfinding.
Второй — глобальный NODE_PATH позволял resolver видеть Playwright/pngjs; остановка
до semantic controls. Сохранены exact probes/driver/raw stdout+stderr/commands/
SHA в failure-initial-environment и failure-runtime-global-path. Третий child
убирает лишь review NODE_PATH и сохраняет отсутствие browser/PNG dependencies.
Product source, N/guards/duration/timeouts не редактированы; отказы не удалены.

Все фактические commands/cwd/start/end/exit/nontruncated outputs — commands.jsonl.
Для isolated replay tiny controls из writable copy bound own snapshot:

    env -u NODE_PATH node import-semantic-probe.mjs
    env -u NODE_PATH node loadsite-probe.mjs

Они пишут retained filenames: sealed copy read-only; replay делать в новом scratch,
с проверкой hashes и сохранением нового raw отдельно. Старые outputs не затирать.
execute-bounded-probes.py ограничивает review CPU slot10s, а не product timeout
или registered stopping. Final exact child window:
2026-10-01T19:18:13.439449+00:00 → 2026-10-01T19:18:13.658104+00:00;
оба exit0, children closed. Browser/build/fullN/actual pilot не запущены,
ownheavy0, reservation END сохранён.

Actual calibration/NI/peer superiority, stationarity, physical device envelope,
весь CI и production/release admission остаются UNPROVEN этой осью. Future dirty
cost/serialization/hash delta требует отдельной проверки. Никакого допуска
actual series этим отчётом: **actual registered samples ровно0**.

REPORT и readset связаны terminal/output manifests и final readback receipt.
PRIMARY/PRIMARY-MANIFEST.json — отдельный primary-only packet exact sources/
probes/inputs/raw/commands/hashes без REPORT или author/foreign rationale.
