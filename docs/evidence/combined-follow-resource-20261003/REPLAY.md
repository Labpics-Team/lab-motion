# Состав пакета для повторной проверки

**Diátaxis:** reference.

| Вход | Значение |
|---|---|
| Архив | `inputs.tar.gz`; полный состав и SHA-256 членов — в `manifest.json` |
| Кандидат Lab Motion | `78e7ab200f473667d8863ff028c17c2e0d7debbc` |
| Дерево | `41bf2ed317ac4c3f98c08c12ea85f20c651f5238` |
| Обязательный Git prerequisite incremental bundle | `9e61edeffc864f6710845ef242bc76e077a49701` |
| Среда исходного полного unit | Linux, Node 24.21.0, `pnpm@11.11.0` |
| Внешние входы | История Git, зависимости по lockfile, Node и браузерные binaries не включены |

[Порядок чтения и воспроизведения](../../replay-combined-evidence.md) описывает
подготовку отдельного worktree, команды, ограничения переноса evidence и очистку.
Новый запуск имеет собственные head/tree, версии и журналы. Исторические
10 unit-отказов и остановка broad mutation сохраняются в исходных receipts.
