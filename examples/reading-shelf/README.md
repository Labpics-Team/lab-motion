# Полка для чтения

Самостоятельный пример коллекции с добавлением, удалением, состояниями чтения, фильтром и перестановкой. Порядок и состав принадлежат приложению; `@labpics/motion/behaviors/reorder` предлагает перестановку по текущей геометрии, а `@labpics/motion/projection` сопровождает подтверждённое изменение. Данные хранятся только до закрытия страницы.

Из корня репозитория:

```sh
pnpm build
node examples/reading-shelf/prepare.mjs
pnpm exec tsc -p examples/reading-shelf/tsconfig.json
pnpm exec vite build --config examples/reading-shelf/vite.config.mjs
pnpm exec vite --config examples/reading-shelf/vite.config.mjs
```

`prepare.mjs` устанавливает архив, созданный `npm pack`, внутри каталога примера. `.artifacts/package.json` содержит SHA-256 архива и манифеста, версию и исходный commit. Для проверки жеста возьмите кнопку «Переместить» мышью или нажмите на ней Enter, затем стрелки и Enter. Escape возвращает порядок до начала клавиатурного жеста; кнопки «Раньше» и «Позже» доступны отдельно. Фильтр, смена направления и добавление обновляют снимок списка.
