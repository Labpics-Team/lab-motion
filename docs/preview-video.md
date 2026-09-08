# Превью движения

Короткий немой этюд: круг превращается в сетку, затем в волну и возвращается.
Позиции семплируются публичной функцией `spring`; это офлайн-рендер движения,
а не запись браузера или демонстрация compositor-производительности.
Цвета взяты из существующей витрины. Видео запускается только по нажатию.

## Пересобрать

Нужны собранный пакет и FFmpeg с декодером librsvg и кодеком libx264.
Из корня репозитория:

```sh
pnpm build
node scripts/render-readme-preview.mjs /tmp/lab-motion-preview
ffmpeg -y -framerate 30 -i /tmp/lab-motion-preview/%04d.svg -c:v libx264 -crf 26 -pix_fmt yuv420p -movflags +faststart site/public/media/motion-preview.mp4
cp /tmp/lab-motion-preview/poster.svg site/public/media/motion-poster.svg
```

Композиция, задержки и параметры пружины редактируются в скрипте.
Перед заменой просмотрите весь ролик, переходы между сценами и возврат к началу.
FFmpeg и системный шрифт могут менять кодирование и метрики текста.
