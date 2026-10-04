# Маршрут выходного дня

Пример непосредственного управления панелью маршрута. Пользователь выбирает остановку, читает детали и сохраняет заметку; данные принадлежат приложению и живут до закрытия страницы. Панель принимает указатель, стрелки, Home/End и кнопки остановок. Пакетные `CompositorSpring` и `createDecay` ведут захват, отпускание и доводку. Отдельные режимы «Без движения» и системный `prefers-reduced-motion` сохраняют те же целевые положения.

Из корня репозитория:

```sh
pnpm install --frozen-lockfile
node examples/itinerary-sheet/prepare.mjs
pnpm exec tsc -p examples/itinerary-sheet/tsconfig.json
pnpm exec vite build --config examples/itinerary-sheet/vite.config.mjs
```

Подготовка заново собирает пакет, устанавливает архив в `examples/itinerary-sheet/node_modules` и записывает `.artifacts/package.json` с SHA-256 архива, версией и наблюдаемым source commit. Эти поля идентифицируют используемые байты, но сами по себе не доказывают воспроизводимость сборки.

Для ручной проверки запустите сервер; команда занимает терминал до остановки:

```sh
pnpm exec vite --config examples/itinerary-sheet/vite.config.mjs
```

После открытия панели можно сменить остановку кнопками «Предыдущая» и «Следующая», не закрывая её. Для браузерного smoke запустите сервер на `127.0.0.1:4178`, затем `node examples/itinerary-sheet/smoke.mjs`. Smoke проверяет синтетическую последовательность `pagehide`/`pageshow`; она не удостоверяет, что конкретный браузер поместил страницу в bfcache.
