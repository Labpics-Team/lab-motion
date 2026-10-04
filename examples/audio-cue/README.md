# Монтажная шкала

Черновой лист для проверки границ четырёх фрагментов интервью. Монтажёр перемещает курсор нативной шкалой, переходит между фрагментами, оставляет заметку и сохраняет или удаляет точки монтажа. Время, заметки и точки принадлежат приложению; установленный `@labpics/motion` 0.3.0 управляет визуальным переходом курсора. Пример не воспроизводит аудио и не выдаёт графические сегменты за измеренную звуковую волну.

Из корня репозитория после `pnpm install --frozen-lockfile`:

```sh
node examples/audio-cue/prepare.mjs
pnpm exec tsc -p examples/audio-cue/tsconfig.json
pnpm exec vite build --config examples/audio-cue/vite.config.mjs
pnpm exec vite preview --config examples/audio-cue/vite.config.mjs --host 127.0.0.1 --port 4180
```

В другом терминале `node examples/audio-cue/smoke.mjs` проверяет Chromium. Для Firefox и WebKit задайте `MOTION_BROWSER=firefox` или `MOTION_BROWSER=webkit`. Проверка проходит через публичный экспорт установленного архива, клавиатурный и указательный ввод нативной шкалы, RTL, фокус, ручной и системный режимы без движения. События `pagehide/pageshow` в smoke синтетические; фактическое восстановление из bfcache ими не доказано. Квитанция архива создаётся в `.artifacts/package.json`.
