# Исторический combined follow/RESOURCE-кандидат

Здесь сохранён локальный срез Lab Motion от 2 октября 2026. Полный unit и broad
mutation в нём — **RED**; эти результаты не описывают текущую версию Motion.
Материалы перенесены в исходный carrier 3 октября, в Motion — 20 октября без
изменения байтов [inputs.tar.gz](inputs.tar.gz) и [manifest.json](manifest.json).

Источник переноса — [agents-config #1465](https://github.com/Labpics-Team/agents-config/pull/1465)
на [`6ac1306bb7ff9824f4ef8992f0a8967690267709`](https://github.com/Labpics-Team/agents-config/tree/6ac1306bb7ff9824f4ef8992f0a8967690267709/plans/lab-motion-production/evidence/combined-follow-resource-20261003).
Команды ниже останавливают подготовку на первой ошибке и
сохраняют ненулевой итог при отказе любой проверки. Raw receipts остаются исходными.

## Исходный снимок и история

| Объект | Значение |
| --- | --- |
| База продукта | `957ceaf26501525eff476cdc1d149d81fd5ebcd7` |
| Кандидат Lab Motion | `78e7ab200f473667d8863ff028c17c2e0d7debbc` |
| Дерево кандидата | `41bf2ed317ac4c3f98c08c12ea85f20c651f5238` |
| Git prerequisite incremental bundle | `9e61edeffc864f6710845ef242bc76e077a49701` |
| План исходных receipts | [r11 на `70df60b58d085800d09fe1b29b612c0373982db1`](https://github.com/Labpics-Team/agents-config/blob/70df60b58d085800d09fe1b29b612c0373982db1/plans/lab-motion-production/r11.md) |
| Базы подготовки / stacked carrier в agents-config | `18f1a5b40252f4ce38d359e81f4a62d98e8cca1c` / `35f9f3ecaf33a721d7c989501bca3787fa8e3a1b` |

Source PR — [Motion #462](https://github.com/Labpics-Team/lab-motion/pull/462), draft
на момент GitHub readback `2026-10-02T21:19:05.753189+00:00` с указанными head/base.
Исходные родители: [#460](https://github.com/Labpics-Team/lab-motion/pull/460) на
`939e7f4a7ebef2dd494f9dec8690932fecebfd73` и
[#461](https://github.com/Labpics-Team/lab-motion/pull/461) на
`4341f80c7a20d3802f7528b13519db6e5586a462`.

Предыдущий [carrier #1301](https://github.com/Labpics-Team/agents-config/pull/1301)
и исходный Vue/RESOURCE [#1270](https://github.com/Labpics-Team/agents-config/pull/1270)
сохранены в истории; этот combined-пакет содержит последующие RED-наблюдения и не
зависит от merge #1270.

## Проверить и прочитать локально

Архив занимает 2 331 622 байта, SHA-256
`e675a253255010108b179edced4abb48d3e014dedec7ff4cd7bd927c58eb63f0`.
Из каталога этой страницы в POSIX shell выполните:

```sh
motion_carrier=$PWD
sha256sum --check sha256sums &&
motion_replay=$(mktemp -d "${TMPDIR:-/tmp}/lab-motion-combined-replay.XXXXXX") &&
tar --no-same-owner --no-same-permissions -xzf "$motion_carrier/inputs.tar.gz" -C "$motion_replay" &&
printf 'Материалы: %s\n' "$motion_replay"
```

[sha256sums](sha256sums) проверяет архив, manifest и эту страницу до распаковки.
Архивный код не запускается. Внешний `manifest.json` связывает все 180 членов
архива с исходными путями, размерами и SHA-256. Внутренний `MANIFEST.json` сохраняет
`carrierPath` → `sourcePath` и hash для 178 приобретённых файлов; ещё два члена —
служебные `README.md` и `MANIFEST.json`. Поле `source` у внутреннего `README.md`
указывает на архив, где этот текст был создан.

Все следующие пути отсчитываются от напечатанного каталога. Абсолютные пути raw
receipts — provenance прежней среды; для чтения используйте относительные пути:

- `evidence/draft-local-gates-78e7ab2.json` и `evidence/draft-evidence-transfer-78e7ab2.json`
  различают новые запуски, перенос по неизменным входам и непройденные проверки;
- `evidence/draft-pr-body.md` сохраняет подготовленное описание исходного среза;
  `evidence/draft-candidate.diff`, `evidence/draft-integration-delta.diff` и
  `evidence/motion-78e7ab2-from-9e61ede.bundle` — исходники и интеграционную дельту;
- `evidence/draft-local-*-78e7ab2*` — receipts, результаты и журналы;
  `evidence/draft-core-mutation-triage.json` — разбор остановки initial dry run;
- `resource/previous-pass/` и `resource/current-red/` — разные наблюдения;
  `reviews/` — отчёты с собственными readsets и ограниченной областью;
- `packages/qualified-labpics-motion-0.3.0.tgz` — qualified package, SHA-256
  `6e81f47096286fba47feb1d43f4a862bd28078a93f7aa3d4e5e18d8225d6438b`.
  Browser repack сохранён отдельно: одинаковые member bytes не означают одинаковый
  SHA архивов. Его identity и область — в browser receipts, не в qualified package.

Внутренние `published: false`, `publishedCarrier: false` и сообщения об отсутствии
публикации относятся к заморозке 2 октября. Позднейшая публикация или удалённые
проверки не переписывают эти receipts.

## Что показывают сохранённые проверки

| Проверка | Наблюдение и область |
| --- | --- |
| Полный unit на `78e7ab2` | **RED:** 5127 PASS, 10 FAIL; skips/todo 0; 1164.349 с |
| Static / TS7 на `78e7ab2` | PASS; 62.928 с / 5.717 с |
| Driver mutation на `78e7ab2` | PASS: 83.72 при пороге 80; 301 mutant: 249 killed, 3 timeout, 37 survived, 12 no coverage |
| Broad `pnpm mutation` на `78e7ab2` | **RED:** healthy PROFILE timeout 30 000 мс в initial dry run; 2376 mutants созданы для 13 файлов, campaign **NOT_RUN**, score отсутствует |
| RESOURCE actual package | Witness/lifecycle/bytes PASS; forced-GC retention этого среза **RED** по timeout 90 с |
| Chromium + Firefox | 348/348 PASS на `4f6bee1c1aff41475c0ea9cfabfb1ddb607f6754`; после него изменён только stock test, browser inputs сохранены |

Из десяти unit-отказов семь относятся к PROFILE: два — healthy/partial timeout,
пять — зависимые проверки того же файла. Остальные три — один RESOURCE retention
и два package-теста. Имена, времена и failure messages сохранены в
`evidence/draft-local-full-unit-78e7ab2-summary.json` и
`evidence/draft-local-full-unit-78e7ab2.log`. Исторический RESOURCE PASS над теми же
package/probe bytes не отменяет последующий RED; причина изменения времени не установлена.

WebKit, CI точного source head, substantive CodeRabbit и физический PROFILE в frozen
срезе не выполнены. Scoped review PASS не закрывает их и сохранённые RED. Целостность
carrier не удостоверяет product acceptance и не меняет статусы продуктового плана.

## Повторить проверки в отдельной среде

Повтор создаёт новое наблюдение с собственными условиями. Архив не содержит полной
Git-истории, зависимостей, Node и браузерных binaries для offline replay. Одного
пустого `git init` недостаточно: нужен Lab Motion checkout с prerequisite
`9e61edeffc864f6710845ef242bc76e077a49701` и историей исходных #460/#461. Если его нет,
сначала восстановите исходную историю. Diff в `evidence/` не заменяет prerequisite.

В том же shell задайте `motion_repo=/абсолютный/путь/к/lab-motion` для checkout
с этой историей. `motion_replay` остаётся каталогом распаковки из предыдущей команды.
Следующая цепочка добавляет bundle-объекты и создаёт отдельный detached worktree,
не меняя рабочую ветку:

```sh
git -C "$motion_repo" cat-file -e 9e61edeffc864f6710845ef242bc76e077a49701^{commit} &&
  git -C "$motion_repo" bundle verify "$motion_replay/evidence/motion-78e7ab2-from-9e61ede.bundle" &&
  git -C "$motion_repo" fetch "$motion_replay/evidence/motion-78e7ab2-from-9e61ede.bundle" 78e7ab200f473667d8863ff028c17c2e0d7debbc &&
  git -C "$motion_repo" worktree add --detach "$motion_replay/source" 78e7ab200f473667d8863ff028c17c2e0d7debbc &&
  test "$(git -C "$motion_replay/source" rev-parse HEAD)" = 78e7ab200f473667d8863ff028c17c2e0d7debbc &&
  test "$(git -C "$motion_replay/source" rev-parse 'HEAD^{tree}')" = 41bf2ed317ac4c3f98c08c12ea85f20c651f5238
```

При первой неудаче цепочка останавливается; отказ prerequisite, bundle или fetch
не допускает создания worktree. HEAD и tree проверяются самой цепочкой.

Среда исходного полного unit — Linux, Node 24.21.0 и репозиторный `pnpm@11.11.0`.
Версия и SHA Node binary сохранены в receipts. Consumer floor Node 22 проверялся
отдельно над qualified package и не является средой полного unit. В отдельном
worktree выполните `pnpm install --frozen-lockfile` и `pnpm build`: production `dist`
нужен для следующих команд. Это новая сборка; её связь с прежним package evidence
требует проверки байтов и provenance.

```sh
(
  cd "$motion_replay/source" || exit
  status=0
  pnpm test --maxWorkers=1 --reporter=default --reporter=json --outputFile="$motion_replay/replayed-unit.json" || status=1
  pnpm check:static || status=1
  pnpm typecheck:native || status=1
  pnpm exec stryker run stryker.driver.config.mjs || status=1
  pnpm mutation || status=1
  exit "$status"
)
```

Все пять проверок выполняются независимо, общий exit ненулевой при отказе любой.
Команды не обещают PASS: исходный unit имел десять отказов, broad mutation не дошёл
до campaign. Не меняйте caps, timeouts, corpus или concurrency ради желаемого исхода.
Новые exit status, версии, HEAD/tree и журналы сохраняйте отдельно от frozen evidence.

Browser replay требует закреплённых Playwright browsers и системных библиотек.
Перенос Chromium/Firefox результатов с `4f6bee1…` ограничен неизменными browser inputs
и указанным в receipt browser package. WebKit в исходной среде не стартовал.
Offline browser replay, замена канонического CI и физическая PROFILE-калибровка этим
архивом не заявлены. Сам перенос не меняет runtime, budgets или приёмку продукта.

После работы сохраните новые результаты, удалите только свой detached worktree
через `git worktree remove`, затем свой временный каталог. Frozen evidence сохраняйте.
