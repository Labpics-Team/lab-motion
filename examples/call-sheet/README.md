# Съёмочный день

Расписание сцен показывает, как приложение владеет порядком и временем, а установленный `@labpics/motion` 0.3.0 отвечает за перестановку и проекцию DOM. Можно менять название и длительность, отмечать снятые сцены, фильтровать список, добавлять и удалять сцены. Перестановка доступна кнопками, клавиатурой и указателем. Escape отменяет незавершённую клавиатурную перестановку.

Из корня репозитория после `pnpm install --frozen-lockfile`:

```sh
node examples/call-sheet/prepare.mjs
pnpm exec tsc -p examples/call-sheet/tsconfig.json
pnpm exec vite build --config examples/call-sheet/vite.config.mjs
pnpm exec vite --config examples/call-sheet/vite.config.mjs --host 127.0.0.1 --port 4179
```

В другом терминале `node examples/call-sheet/smoke.mjs` проверяет основные действия в Chromium. Для Firefox и WebKit задайте `MOTION_BROWSER=firefox` или `MOTION_BROWSER=webkit`. `prepare.mjs` собирает пакет, создаёт архив и устанавливает его в локальный `node_modules` примера; квитанция с хешем архива записывается в `.artifacts/package.json`. Этот пример и smoke проверяют один браузерный сценарий. Они не измеряют физическую память GPU, не доказывают сохранение страницы настоящим bfcache и не заменяют приёмку остальных потребителей плана.
