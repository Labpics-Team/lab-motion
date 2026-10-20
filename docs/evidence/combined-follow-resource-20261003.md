# Motion: evidence объединённого follow/RESOURCE-кандидата

Дата исходного переноса: 2026-10-03. Справка сохраняет локальный срез кандидата
от 2026-10-02 и границы его доказательств. Полный unit и broad mutation в этом
срезе — **RED**; результаты не описывают текущую версию Motion.

Уточнение от 2026-10-07: разбивка отказов сделана явной; запуск связан с успешным
`cd`. Порядок воспроизведения вынесен в [how-to](../replay-combined-evidence.md),
а `REPLAY.md` содержит справку о входах. Архив и манифест сохранены побайтно.

Пакет перенесён в Lab Motion из agents-config
[#1465](https://github.com/Labpics-Team/agents-config/pull/1465),
снимок [`6ac1306bb7ff9824f4ef8992f0a8967690267709`](https://github.com/Labpics-Team/agents-config/tree/6ac1306bb7ff9824f4ef8992f0a8967690267709/plans/lab-motion-production/evidence/combined-follow-resource-20261003).
Предыдущий [carrier #1301](https://github.com/Labpics-Team/agents-config/pull/1301)
сохранён в истории; перенос не меняет исходники продукта или статусы его приёмки.

| Объект | Точный снимок |
|---|---|
| Исходная база подготовки carrier, agents-config | `18f1a5b40252f4ce38d359e81f4a62d98e8cca1c` |
| Историческая основа stacked carrier, agents-config | `35f9f3ecaf33a721d7c989501bca3787fa8e3a1b` |
| План исходных receipts | `70df60b58d085800d09fe1b29b612c0373982db1`, [r11](https://github.com/Labpics-Team/agents-config/blob/70df60b58d085800d09fe1b29b612c0373982db1/plans/lab-motion-production/r11.md) |
| База продукта | `957ceaf26501525eff476cdc1d149d81fd5ebcd7` |
| Кандидат Lab Motion | `78e7ab200f473667d8863ff028c17c2e0d7debbc` |
| Дерево кандидата | `41bf2ed317ac4c3f98c08c12ea85f20c651f5238` |
| Source PR | [Lab Motion #462](https://github.com/Labpics-Team/lab-motion/pull/462), draft на дату исходного наблюдения |

В agents-config carrier готовили поверх исправления SQLite oracle на ветке
`fix/sqlite-attempt-oracle-20261003`: она была целевой base прежнего PR.
Это историческое размещение; чтение пакета в Motion не требует этой ветки
или прежних центральных механизмов допуска. Исходные базы и frozen receipts сохранены.

Публикация сверена через GitHub 2026-10-02T21:19:05.753189+00:00: #462 открыт как draft
на head/base из таблицы. Статусы ниже описывают frozen local срез от 2026-10-02;
последующие удалённые проверки не переписывают его receipts.

Исходные родители: [Lab Motion #460](https://github.com/Labpics-Team/lab-motion/pull/460)
на `939e7f4a7ebef2dd494f9dec8690932fecebfd73` и
[#461](https://github.com/Labpics-Team/lab-motion/pull/461)
на `4341f80c7a20d3802f7528b13519db6e5586a462`.
Их история сохранена. [Ранее подготовленный carrier #1270](https://github.com/Labpics-Team/agents-config/pull/1270)
относится к исходному Vue/RESOURCE-срезу; настоящий carrier содержит combined
кандидат и последующие RED-наблюдения и не зависит от merge #1270.

[Архив входов](combined-follow-resource-20261003/inputs.tar.gz),
[манифест](combined-follow-resource-20261003/manifest.json),
[sha256sums](combined-follow-resource-20261003/sha256sums) и
[справка о повторе](combined-follow-resource-20261003/REPLAY.md).
Архив — побайтная копия frozen packet: 2 331 622 байта, SHA-256
`e675a253255010108b179edced4abb48d3e014dedec7ff4cd7bd927c58eb63f0`.
В нём 178 исходных файлов и два служебных файла `README.md`/`MANIFEST.json`.

## Что показывают сохранённые проверки

| Проверка | Наблюдение и область |
|---|---|
| Полный unit на `78e7ab2` | **RED:** 5127 PASS, 10 FAIL; skips/todo 0; 1164.349 с |
| Static / TS7 на `78e7ab2` | PASS; 62.928 с / 5.717 с |
| Driver mutation на `78e7ab2` | PASS: 83.72 при пороге 80; 301 mutant: 249 killed, 3 timeout, 37 survived, 12 no coverage |
| Broad `pnpm mutation` на `78e7ab2` | **RED:** healthy PROFILE timeout 30 000 мс в initial dry run; 2376 mutants созданы для 13 файлов, campaign **NOT_RUN**, score отсутствует |
| RESOURCE actual package | Witness/lifecycle/bytes PASS; текущий forced-GC retention **RED** по timeout 90 с |
| Chromium + Firefox | 348/348 PASS на `4f6bee1c1aff41475c0ea9cfabfb1ddb607f6754`; после него изменён только stock test, browser inputs сохранены |

Из десяти unit-отказов семь относятся к PROFILE: два — healthy/partial timeout,
пять — зависимые проверки того же файла. Остальные три — один RESOURCE retention
и два package-теста.
Первичные имена, времена и failure messages сохранены в
`evidence/draft-local-full-unit-78e7ab2-summary.json` и полном журнале.
Исторический RESOURCE PASS над теми же package/probe bytes не отменяет текущий RED;
причина изменения времени не установлена.

## Первичные входы внутри архива

Начните с `evidence/draft-local-gates-78e7ab2.json` и
`evidence/draft-evidence-transfer-78e7ab2.json`: они различают новые запуски,
перенос по неизменным входам и непройденные проверки. `evidence/draft-pr-body.md`
сохраняет подготовленное описание исходного среза.

- `evidence/draft-candidate.diff`, `evidence/draft-integration-delta.diff` и incremental Git bundle — исходники и интеграционная дельта.
- `evidence/draft-local-*-78e7ab2*` — receipts, результаты и журналы текущих запусков; `evidence/draft-core-mutation-triage.json` — причина остановки dry run.
- `resource/previous-pass/` и `resource/current-red/` — разные наблюдения; `reviews/` — отчёты с собственными readsets и ограниченной областью.
- `packages/qualified-labpics-motion-0.3.0.tgz` — qualified package, SHA-256 `6e81f47096286fba47feb1d43f4a862bd28078a93f7aa3d4e5e18d8225d6438b`. Отдельный browser repack сохранён отдельно: совпадение member bytes не означает равенства SHA архивов.

Внутренние `published: false`, `publishedCarrier: false` и ссылки на отсутствие
публикации описывают время заморозки 2026-10-02. Перенос не редактирует raw receipts.
Внешний manifest связывает все 180 членов архива с исходными путями, размерами и SHA-256.

## Открытая приёмка

WebKit, CI точного source head, substantive CodeRabbit и физический PROFILE
в frozen срезе не выполнены. Scoped review PASS не закрывает эти проверки
и текущие RED. Целостность carrier не удостоверяет product acceptance.

Статусы продуктового плана, budgets, corpus, caps и timeouts этим переносом не изменяются.
Новый runtime, deploy и повтор измерений не выполняются. Откат carrier удаляет
только эти добавленные файлы через обычный PR; исходный продукт и прежнее evidence
сохраняются.
