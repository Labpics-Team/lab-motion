# Полка для чтения

Самостоятельный пример коллекции с добавлением, удалением, состояниями чтения, фильтром и перестановкой. Порядок и состав принадлежат приложению; `@labpics/motion/behaviors/reorder` предлагает перестановку по текущей геометрии, а `@labpics/motion/projection` сопровождает подтверждённое изменение. Данные хранятся только до закрытия страницы.

Из корня репозитория:

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/reading-shelf/prepare.mjs
pnpm exec tsc -p examples/reading-shelf/tsconfig.json
pnpm exec vite build --config examples/reading-shelf/vite.config.mjs
```

## Запуск

Команда ниже запускает сервер и занимает терминал до остановки:

```sh
pnpm exec vite --config examples/reading-shelf/vite.config.mjs
```

`prepare.mjs` создаёт `node_modules` внутри примера и устанавливает туда архив, созданный `npm pack`. `.artifacts/package.json` содержит SHA-256 архива и манифеста, версию, исходный commit и признак грязного рабочего дерева. Для проверки жеста возьмите кнопку «Переместить» мышью или нажмите на ней Enter, затем стрелки и Enter. Escape возвращает порядок до начала клавиатурного жеста; кнопки «Раньше» и «Позже» доступны отдельно. Фильтр, смена направления и добавление обновляют снимок списка.
