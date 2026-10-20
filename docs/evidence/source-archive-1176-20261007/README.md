# Исторические материалы Motion от 2 октября 2026

Здесь сохранены 279 файлов resource-checkpoint и frame-delivery из
[agents-config #1176](https://github.com/Labpics-Team/agents-config/pull/1176).
Архив упакован 7 октября и перенесён к владельцу Motion 20 октября 2026.
Байты [inputs.tar.gz](inputs.tar.gz) и [manifest.json](manifest.json) не изменены.
Manifest содержит исходные пути, Git blobs и modes, размеры и SHA-256 всех файлов.

Исходный snapshot: `d3224cd485701d7fa8448c19b0529f3931b03acb`,
tree `962568ff2893fcba7e37fcc9beaf772311bb2788`,
base `aa868277c462ac033c255ea7c264a649ed3d0345`.
Источник переноса — [agents-config #1472](https://github.com/Labpics-Team/agents-config/pull/1472)
на `7c428208bb15283e62ef33b9a2ea4a2c4cc50a15`. Ссылки на исходные PR служат
сведениями о происхождении; локальное чтение сохранённых файлов не требует
соседнего архива или другого репозитория.

## Найти исходные отчёты

После распаковки откройте оригиналы по путям от корня нового каталога:

| Материал | Путь внутри архива |
| --- | --- |
| Resource-checkpoint: кандидаты, stall, revoke, size RED и WebKit flaky | `plans/lab-motion-production/evidence/resource-checkpoint-20261002/README.md` |
| Frame-delivery: однократная доставка кадра и исправление pickup oracle | `plans/lab-motion-production/evidence/frame-delivery-20261002/README.md` |

Статусы, числа, RED/FAIL и «review/CI открыт» в этих оригиналах относятся к своим
датированным snapshot. Внешние страницы упаковки от 7 октября лишь уточняли эту
область и заменяли ссылки на immutable Git-снимок; актуальными product-инструкциями
они не являлись. Исправление FrameDelivery уже принято в
[Motion #471](https://github.com/Labpics-Team/lab-motion/pull/471)
5 октября 2026, merge `ee78df3fcc3f9ff44c8f3ed717b3ee3767f2f121`.
Сохранение carrier не требует повторной реализации исправления или старых прогонов
и не закрывает полные RESOURCE-01/M-07, JOURNEY-01 и PROFILE-01.

## Проверить и прочитать локально

SHA-256 архива (472052 байта): `6058aa36d3e291bdbf834f72300dad5f1afd7c3d1f5309019930a919e8e3c03b`.
SHA-256 manifest: `917e2f9c5f0dabfb78b0231d4647cb076fe3700268fe678ad0339c694ec51923`.
[sha256sums](sha256sums) проверяет также эту страницу.

Из этого каталога в POSIX shell проверьте hashes и извлеките данные в новый пустой
временный каталог. Команда выведет его путь; архивный код не запускается.

```sh
motion_carrier=$PWD
sha256sum --check sha256sums &&
motion_restore=$(mktemp -d "${TMPDIR:-/tmp}/lab-motion-history.XXXXXX") &&
tar --no-same-owner --no-same-permissions -xzf "$motion_carrier/inputs.tar.gz" -C "$motion_restore" &&
printf 'Материалы: %s\n' "$motion_restore"
```

В архиве только обычные файлы. Исходные Git modes сохранены в manifest; нормализованные
timestamps/uid/gid упаковки не являются историческими filesystem metadata.
Пакеты частичные: прежние manifests и ссылки могут указывать на неэкспортированные
checkout/dist, зависимости, архивы и большие traces. Полнота всех старых относительных
ссылок не обещана; абсолютные пути относятся к прежней среде. Читайте сохранённые
отчёты как историю, не запускайте scripts, tests или benchmarks из распакованного
каталога. Исходные байты и исторические неудачи оставлены без исправлений.
