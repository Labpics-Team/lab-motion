# Чтение и повтор сохранённого среза

**Diátaxis:** how-to.

Начните в корне checkout `lab-motion`, содержащего
[сохранённый пакет](evidence/combined-follow-resource-20261003/REPLAY.md).
Проверьте SHA-256, затем распакуйте архив в отдельный пустой каталог.
При ошибке остановитесь. Проверка SHA удостоверяет сохранность,
а повтор исполняемых проверок создаёт новое наблюдение с собственными условиями.

```sh
motion_repo=$PWD
motion_carrier=$motion_repo/docs/evidence/combined-follow-resource-20261003
(cd "$motion_carrier" && sha256sum --check sha256sums) &&
motion_replay=$(mktemp -d /tmp/lab-motion-combined-replay.XXXXXX) &&
tar -xzf "$motion_carrier/inputs.tar.gz" -C "$motion_replay"
```

Внешний `manifest.json` перечисляет все члены архива. Внутренний `MANIFEST.json`
сохраняет исходный `carrierPath` → `sourcePath` и hash для 178 приобретённых файлов.
Поле `source` у внутреннего `README.md` во внешнем manifest указывает на исходный
архив, где этот текст был создан. Абсолютные пути raw receipts — provenance;
для чтения используйте относительные пути распакованного архива.

## Исходники

Архив переносим, но не содержит полной Git-истории и всех зависимостей для offline
replay. Bundle `evidence/motion-78e7ab2-from-9e61ede.bundle` — incremental;
его обязательный prerequisite — `9e61edeffc864f6710845ef242bc76e077a49701`.
Одного пустого `git init` недостаточно. Нужен исходный Lab Motion Git checkout
с этим commit и историей исходных #460/#461. Если prerequisite отсутствует,
восстановите исходную историю прежде, чем продолжать.

Переменная `motion_repo` выше указывает на текущий checkout. Если исходная история
восстановлена в другом checkout, задайте его путь в `motion_repo`. Команды добавляют
bundle-объекты и создают отдельный detached worktree, не меняя рабочую ветку:

```sh
git -C "$motion_repo" cat-file -e 9e61edeffc864f6710845ef242bc76e077a49701^{commit} &&
  git -C "$motion_repo" bundle verify "$motion_replay/evidence/motion-78e7ab2-from-9e61ede.bundle" &&
  git -C "$motion_repo" fetch "$motion_replay/evidence/motion-78e7ab2-from-9e61ede.bundle" 78e7ab200f473667d8863ff028c17c2e0d7debbc &&
  git -C "$motion_repo" worktree add --detach "$motion_replay/source" 78e7ab200f473667d8863ff028c17c2e0d7debbc &&
  test "$(git -C "$motion_replay/source" rev-parse HEAD)" = 78e7ab200f473667d8863ff028c17c2e0d7debbc &&
  test "$(git -C "$motion_replay/source" rev-parse 'HEAD^{tree}')" = 41bf2ed317ac4c3f98c08c12ea85f20c651f5238
```

Цепочка останавливается на первой неудаче и не создаёт worktree, если prerequisite
или bundle не прошли проверку. Значения head `78e7ab200f473667d8863ff028c17c2e0d7debbc`
и tree `41bf2ed317ac4c3f98c08c12ea85f20c651f5238` сверяются самой цепочкой.
Полный diff к main и интеграционная дельта в `evidence/` помогают читать изменение,
но не заменяют отсутствующий prerequisite bundle.

## Исполняемые проверки

Для воспроизведения точных локальных команд нужны Linux, Node 24.21.0,
репозиторный `pnpm@11.11.0`, зависимости по `pnpm-lock.yaml` и production `dist`.
Зависимости и Node binary не включены. Версии и SHA бинарника исходного Node
сохранены в receipts. Consumer floor Node 22 проверялся отдельно над qualified
package и не является средой текущего полного unit.

В отдельном worktree установите зависимости с `pnpm install --frozen-lockfile`
и выполните `pnpm build`. Это новая сборка: прежде чем связывать её с прежним
package evidence, проверьте соответствие байтов и provenance.
Точные команды текущего локального среза:

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

Все пять проверок выполняются независимо; код возврата группы ненулевой, если отказала
любая из них.

Полный unit исходного запуска завершился десятью отказами. Broad mutation
остановился на initial dry run; mutant campaign не запускалась. Эти команды
не обещают PASS, а тайминги зависят от среды. Не меняйте caps, timeouts, corpus
или concurrency ради совпадения с желаемым исходом. Сохраните новый exit status,
версии, head/tree и журналы отдельно от frozen evidence.

Для браузерных проверок нужны закреплённые Playwright browsers и системные
библиотеки. Сохранённая Chromium/Firefox матрица относится к `4f6bee1…` и указанному
в receipt browser package; её перенос ограничен неизменными browser inputs.
WebKit в исходной среде не стартовал. Offline browser replay и замена канонического
CI этим архивом не заявлены.

После работы удалите собственный detached worktree через `git worktree remove`,
предварительно сохранив новые результаты, затем собственный временный каталог.
