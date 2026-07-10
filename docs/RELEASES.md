# Выпуск версий

## Принципы

- Публикуется только коммит из `main`.
- Версия в `package.json`, Git-тег и заголовок в `CHANGELOG.md` совпадают.
- Публикация выполняется GitHub Actions на GitHub-hosted runner.
- npm-аутентификация использует Trusted Publishing через OIDC без долгоживущего publish-токена.
- Provenance создаётся npm автоматически для публичного пакета из публичного репозитория.
- Перед публикацией выполняются те же гейты, что защищают pull request.
- Опубликованная версия неизменяема. Исправление выпускается новой версией.

## Семантика версий до 1.0

- patch — совместимое исправление без изменения публичного контракта;
- minor — новая возможность или несовместимое изменение публичного контракта;
- изменение значений публичных motion-токенов — minor;
- изменение только внутренней реализации без наблюдаемого эффекта — patch.

## Однократная настройка npm

В настройках пакета `@labpics/motion` создать Trusted Publisher:

| Поле | Значение |
|---|---|
| Provider | GitHub Actions |
| Organization | `Labpics-Team` |
| Repository | `lab-motion` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

В GitHub environment `npm` рекомендуется включить ручное подтверждение выпуска.
После первого успешного OIDC-релиза нужно запретить token-based publishing в
настройках npm и отозвать старые automation tokens.

Workflow требует `id-token: write`, GitHub-hosted runner, Node 24 и npm с
поддержкой Trusted Publishing. Версия npm проверяется до сборки.

## Подготовка версии

1. Создать release issue с точным составом версии.
2. Обновить `package.json`.
3. Перенести записи из `Unreleased` в датированную секцию версии `CHANGELOG.md`.
4. Добавить migration note для несовместимого изменения.
5. Выполнить обязательные гейты.
6. Проверить packed-артефакт как потребитель.
7. Смержить release PR в `main`.

## Публикация

Создать подписанный тег, точно соответствующий версии:

```bash
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Тег запускает `.github/workflows/release.yml`. Workflow:

1. проверяет соответствие тега, `package.json` и changelog;
2. выполняет typecheck, build, factual docs check, tests, fuzz, size и pack-smoke;
3. публикует пакет через npm Trusted Publishing;
4. получает автоматический provenance;
5. создаёт GitHub Release.

Для release tags должны действовать ruleset/tag protection и ограничение на
создание тега доверенными maintainers.

## Ошибка выпуска

- Не перемещать опубликованный тег.
- Не перезаписывать опубликованную версию.
- Исправить причину в отдельном PR.
- Для дефектного пакета использовать `npm deprecate` с понятной рекомендацией версии.
- Выпустить следующую patch- или minor-версию согласно характеру изменения.
- Не включать временный publish-токен как обход ошибки Trusted Publisher.

## Проверка результата

После выпуска проверить:

```bash
npm view @labpics/motion version
npm view @labpics/motion dist.integrity
```

На странице версии npm должен отображаться provenance. Затем пакет устанавливается
в чистый consumer fixture, где импортируются публичные точки входа.

Результат выпуска фиксируется в release issue. Документация не хранит текущий
операционный статус версии.
