<!-- pre_merge_checks_walkthrough_start -->

<details>
<summary>🚥 Pre-merge checks | ✅ 8 | ❌ 1</summary>

### ❌ Failed checks (1 warning)

|  Check name | Status     | Explanation                                                                                                                                                                                               | Resolution                                                                                                                                                                                                                                        |
| :---------: | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| архитектура | ⚠️ Warning | Нарушена граница между контрактом профиля и хранением/транспортом. Новый `bench/profile/server-profile-contract.mjs` одновременно содержит правила валидации и прямые эффекты: импортирует `node:fs`, `n… | Разделить новый профиль на вертикальные модули с простыми контрактами. Оставить в чистом `server-profile-contract.mjs` только типизированные представления и детерминированные функции проверки, планирования, статистики и digest по переданным… |

<details>
<summary>✅ Passed checks (8 passed)</summary>

|               Check name              | Status   | Explanation                                                                                                                                                                                               |
| :-----------------------------------: | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|              Title check              | ✅ Passed | Заголовок написан на русском языке и отражает ключевые изменения: сохранение владения движением и проверку полной стоимости MotionValue. Он не охватывает native clock, packaged build и профиль измерен… |
|           Description check           | ✅ Passed | Описание подробное, тематически корректное и содержит результат для пользователя, изменения контракта, доказательства, ограничения, статус измерений, риски, документацию и тестовые результаты. Оно не … |
|          Linked Issues check          | ✅ Passed | Check skipped because no linked issues were found for this pull request.                                                                                                                                  |
|       Out of Scope Changes check      | ✅ Passed | Check skipped because no linked issues were found for this pull request.                                                                                                                                  |
|      краткие русские документации     | ✅ Passed | Проверка пройдена. Новые и изменённые пояснения в `README.md`, `CHANGELOG.md`, `docs/*.md` и `bench/profile/native-clock/README.md` написаны на русском; английские фрагменты ограничены идентификаторам… |
|                Diataxis               | ✅ Passed | Документация PR классифицирована по ролям Diátaxis. `docs/recipes.md` обозначен как практика и содержит исполняемые рецепты. `docs/server-profile.md` и `bench/profile/native-clock/README.md` обозначен… |
|                 тесты                 | ✅ Passed | Тесты дают предметные оракулы и отрицательные проверки. Новые unit-тесты покрывают late callback, destroy/cancel, reduced-motion, live/native handoff, reentrant intent и terminal MotionValue. Browser-… |
| промежуточные документы (напр. планы) | ✅ Passed | Проверенный diff не добавляет в репозиторий планы, ревью, отчёты или каталоги промежуточных evidence-артефактов. Новый `docs/server-profile.md` оформлен как справка Diátaxis, описывает действующий кон… |

</details>

<details>
<summary>Full details: архитектура</summary>

**Explanation**

Нарушена граница между контрактом профиля и хранением/транспортом. Новый `bench/profile/server-profile-contract.mjs` одновременно содержит правила валидации и прямые эффекты: импортирует `node:fs`, `node:path`, `node:url` и `node:crypto` (строки 1–11), пишет файл в `writeServerArtifact` (741–752), разбирает файловые carriers (756–821) и сам является CLI, читая `process.argv`, raw и journal (952–963). `server-profile-runner.mjs` импортирует из этого же модуля и валидаторы, и `writeServerArtifact` (строки 18–19, 683). Файл полностью добавлен этим PR, поэтому причинность подтверждена diff. Это не чистое ядро: модель и правила admission связаны с файловым хранением, JSON/NDJSON-транспортом и CLI.

**Resolution**

Разделить новый профиль на вертикальные модули с простыми контрактами. Оставить в чистом `server-profile-contract.mjs` только типизированные представления и детерминированные функции проверки, планирования, статистики и digest по переданным значениям/байтам. Вынести `writeServerArtifact`, `parseServerJsonBytes`, `parseServerJournalBytes` и файловый digest в отдельный `server-profile-artifact-io.mjs`. Вынести чтение `process.argv`, файлов и вывод результата в отдельный `validate-server-profile-cli.mjs`. Вынести запись NDJSON-журнала в адаптер runner-а или отдельный `server-profile-journal-io.mjs`; передавать в доменный код уже разобранные записи и явный интерфейс журнала. Удалить из чистого контракта импорты `node:fs`, `node:path`, `node:url` и CLI-блок. Добавить тесты, которые импортируют чистый контракт без Node filesystem/CLI и отдельно проверяют адаптеры хранения.

</details>

</details>

