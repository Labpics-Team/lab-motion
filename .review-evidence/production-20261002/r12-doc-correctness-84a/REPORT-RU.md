# Корректность документационного delta с постоянными anchors

**PASS — факты и границы полномочий новой секции подтверждены первичкой.**
Объект `agents-config@84a0f547156656a70cf73f29b9a2930b5a1997fa`, parent
`85a837e83912ec6b3144b385d938b66a0c63adcf`; единственный diff — 27 добавленных
строк `plans/lab-motion-production/evidence/r12-server-scope-review-20261001.md`.
Новый SHA-256 файла:
`20a7de21cbcbb379a6b81f855ce37dca9c4f98c92edde4d1663d632f725a1975`.

Все **11 anchors** ведут к точным paths опубликованного commit
`eaf0f9509c9d48aaec367ca108c79622b247250e`, tree
`97ff31635b960a8561e370e02d59f73d6307f255`. Git blob IDs, размеры и полные
SHA-256 совпадают между фактическим provider tree, 477-записным первичным
readback journal и anchor binding. Девять исторических якорей соответствуют
исходным квитанциям/эпохам, а новые map/README — текущему физическому представлению.

Map содержит ровно один segmented gzip и его рецепт: три последовательные
части 20 971 520 + 20 971 520 + 2 847 843 B. Их actual tree IDs/размеры/SHA
совпадают с рецептом и журналом. Существующий provider hydration восстановил
44 790 883 B, исходный SHA-256
`298745c674a4f2f9eabbb24abe9ccf82e7d9e467e9f5492b4ee5ce9e59b260f7`
и Git blob `5becf6dab5ef9aa4ae3d340818e3811c01b583bc`, с literal original equality.
Точный опубликованный loader проверяет каждую часть, весь compressed stream,
размеры/SHA/Git IDs и fsync до атомарного создания готового имени без overwrite.
README даёт тот же pinned recipe и provider command. Повторное разжатие целого
gzip не заявлено; известный отдельный prefix-check 8 KiB не превращён в новое
доказательство полного decoded потока.

Старый witness prefix **11 413 B** сохранён буквально. AGENTS/SPEC/TEMPLATE,
r11, prepared r12, ACTIVE/CLAIM/ACTIVATION не изменились. r12 остаётся
подготовленным, authoritative — r11. Все 631 inherited product path сохранены
в фактическом provider tree; package whitelist исключает evidence namespace.
Новая секция не создаёт DONE, activation, release/merge grant или performance
claim и не переносит прежнее review на новый head. Реальных зарегистрированных
временных наблюдений — **0**.

Primary packet `d13d519f…` и 11 объявленных inputs проверены по bytes/SHA;
supplement `88d55d51…` добавил четыре уже сохранённых точных provider inputs
для утверждений о map/loader. Применены непосредственно прочитанные нормы
AGENTS118–159/199, SPEC41–77 и r11 G-PERF435–460; skill verify.
Exact readset, commands и 11 пообъектных bindings приложены.

Границы проверки: только source/norm и сохранённая первичка. Новых provider
payload fetch/decode, 700MB reread, suites, full graph, source/Git/remote mutations
или чтения чужих REPORT/verdict/PR/bot conclusions не было. Canonical web UI
и живые обычные branch heads повторно не опрашивались; проверена опубликованная
Git identity и область custom ref. Это не новая приёмка методики/производительности.
**Heavywork0; все собственные процессы END.**
