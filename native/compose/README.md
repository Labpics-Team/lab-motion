# Lab Motion для Compose

Общий Kotlin Multiplatform исполнитель движения Android, iOS и desktop. UI и Icons задают цели/эффекты, renderer читает типизированные `MotionValue`. Один controller использует одну `Animatable` и одну подписку на Compose frame clock для всей группы частей. JS VM и WebView не нужны.

## Подключение

После выпуска `compose-v0.1.0` публичный Maven repository доступен без credentials:

```kotlin
repositories {
    maven("https://raw.githubusercontent.com/Labpics-Team/lab-motion/maven-compose-v0.1.0/")
    google()
    mavenCentral()
}
commonMain.dependencies { implementation("pics.lab:motion-compose:0.1.0") }
```

Модуль публикует common metadata, Android AAR (API 33+), iOS arm64/simulator arm64 klib и JVM JAR (Java 17+, для macOS/Windows/Linux). iOS приложение задаёт deployment target 15+. Compose runtime/animation 1.12.2 — явные зависимости. Desktop использует платформенный Skiko выбранного приложения. Установка SDK не подтверждает доступность, IME или графику конкретного приложения на каждой ОС.

## Использование

```kotlin
val scope = rememberCoroutineScope()
val motion = remember { MotionController(scope) }
val rotation = remember { motion.value(0f, "reload.rotate") }
val opacity = remember { motion.value(1f, "reload.opacity") }
DisposableEffect(motion) { onDispose { motion.dispose() } }

// Передайте onTurn в onClick; вызовы и чтение принадлежат UI-потоку.
val onTurn: () -> Unit = {
    motion.animate {
        to(rotation, 180f, MotionTransition.Spring(MotionSpring.response(420f, .2f)))
        keyframes(opacity, listOf(.4f, 1f), durationMillis = 450)
    }
}
// В draw/layout: rotation.value, opacity.value. Состояние наблюдаемо Compose.
```

Приложение передаёт настройку reduced motion через `motion.reducedMotion`. Её включение немедленно завершает текущий эффект в авторских конечных значениях. Отключение не запускает завершённый эффект повторно. Нативные системные настройки и жизненный цикл композиции принадлежат host; `rememberCoroutineScope` передаёт его frame clock и `MotionDurationScale`.

`motionEffect { … }` сохраняет подготовленный эффект. `to` и `keyframes` начинают от видимой позы при каждом запуске. `targets` исключают текущую позу; необязательные `times` включают её нулевую долю и конечную единицу. Числовые координаты, transform, opacity, draw progress и параметры материалов используют один контракт. Icons привязывает ID части к handles при создании renderer; кадр не ищет строки и не разбирает SVG. Единицы канала задаёт потребитель: dp для длины, градусы для угла, доли для opacity. Presentation clamp opacity выполняет renderer.

## Поведение

- `animate` сначала валидирует и компилирует весь эффект, затем прерывает прежний. Некорректная новая цель сохраняет действующее движение.
- Retarget сохраняет позу и физическую скорость до отмены clock job. Spring продолжает обе; tween сохраняет позу и принимает новую производную авторского easing. Отложенная дорожка удерживает позу до начала.
- `pause` удерживает позу, `play` продолжает ту же шкалу, `seek(ms)` сохраняет паузу. `reverse` меняет направление, `timeScale=0` удерживает позу без запроса кадров. `finish` применяет авторский конец даже при обратном воспроизведении. `stop` удерживает текущую позу.
- `finished: Deferred<MotionResult>` разрешается `Finished` или `Stopped`; retarget, stop, отмена scope (включая паузу/нулевую скорость) и dispose — `Stopped`. Явный `finished.cancel()` также останавливает выполнение, сохраняя стандартную отмену Deferred. Старые controls после завершения не меняют новую операцию. Ошибка исполнения переводит controls в `Failed` и завершает Deferred исключением.
- `dispose` идемпотентен, отменяет clock job и запрещает новые значения/эффекты. Отдельная остановка не отменяет coroutine scope приложения.
- Все дорожки публикуют один кадр внутри snapshot. В покое нет coroutine или frame-clock waiter. В кадре нет компиляции, SVG parsing, поиска ID или новых списков/карт каналов.

`MotionSpring(mass, stiffness, damping)` переводится в Compose `stiffness/mass` и `damping/(2*sqrt(stiffness*mass))`; все параметры конечны и положительны. `response` — естественный период в миллисекундах, `bounce=1-dampingRatio`. Нулевая damping отвергается как незавершаемая пружина. Порог видимости явно задан в единицах канала, по умолчанию `0.001`. Backend использует Float, native spring/Bezier и миллисекундное разрешение Compose; численная траектория и время оседания могут отличаться от JS, непрерывность и смысл controls сохраняются. Defaults генерирует `scripts/sync-defaults.mjs` из `src/internal/motion-defaults.ts`.

Это scalar effect API для native consumers. CSS, binary Motion Program wire format, repeat/infinite, цветовые codecs и layout mutation здесь не принимаются. Экспортёр должен отклонить неподдерживаемую операцию явно, а не удалить её. Компонент может хранить большой immutable `SymbolData` отдельно от исполняемых активных каналов.

## Проверка и выпуск

```sh
node native/compose/scripts/sync-defaults.mjs --check
cd native/compose
./gradlew desktopTest publishDesktopPublicationToDistributionRepository publishKotlinMultiplatformPublicationToDistributionRepository
./gradlew -p consumer run --args=--verify -PmotionRepository=/absolute/path/to/native/compose/build/repository
./gradlew -p consumer run --args=--smoke -PmotionRepository=/absolute/path/to/native/compose/build/repository
```

Windows использует `gradlew.bat`. Сборка использует JDK 21, Kotlin 2.3.21, Gradle 9.3.1, Android Gradle Plugin 9.1.1 и compileSdk 37; выпуск JVM совместим с Java 17. Версии учитывают требования Android AAR и Native KLIB ABI Compose 1.12.2. Consumer — отдельная Gradle-сборка, которая получает только Maven-артефакт. `--verify` проверяет retarget с ненулевой скоростью, controls, reduced motion и disposal. `--smoke` открывает настоящее desktop-окно, выполняет те же действия, сохраняет изображение своего окна в `consumer/build/native-consumer.png` и закрывается. Без аргументов пример интерактивен.

`desktopTest`/`iosSimulatorArm64Test` используют один набор поведенческих тестов, управляемый `BroadcastFrameClock` и независимую аналитическую траекторию критически демпфированной пружины. CI выбирает проверки по изменённым native/source-contract входам. Android проходит compilation/packaging; JVM и iOS simulator исполняют тесты. Физические Android/iOS устройства не подменяются симулятором или сборкой.

Headless CI открывает настоящее окно в Xvfb с `SKIKO_RENDER_API=SOFTWARE`: доступность GPU не нужна для проверки renderer и жизненного цикла. Smoke требует завершения приложения за 30 секунд; при зависании выводит стеки JVM и возвращает ошибку. Обычный интерактивный запуск сохраняет выбор графического backend приложения.

Workflow **Release Compose** принимает version и работает с main. Linux собирает Android/JVM/common, macOS — Apple. Проверяется полная цепочка `.module` → artifacts и SHA-256, затем отдельный consumer. Source tag `compose-vX.Y.Z` и Maven tag `maven-compose-vX.Y.Z` отправляются атомарно; версия не переписывается. Maven commit содержит `source.json` с исходным SHA. После публикации consumer повторно устанавливает зависимость по публичному URL; release содержит дополнительный архив.

## Первичные источники

- [Animatable: отмена и сброс скорости](https://developer.android.com/reference/kotlin/androidx/compose/animation/core/Animatable), [исходник AndroidX](https://github.com/androidx/androidx/blob/androidx-main/compose/animation/animation-core/src/commonMain/kotlin/androidx/compose/animation/core/Animatable.kt).
- [Compose animation specs](https://developer.android.com/develop/ui/compose/animation/customize), [MonotonicFrameClock](https://developer.android.com/reference/kotlin/androidx/compose/runtime/MonotonicFrameClock).
- [Compose совместимость платформ](https://kotlinlang.org/docs/multiplatform/compose-compatibility-and-versioning.html), [KMP Maven publication](https://kotlinlang.org/docs/multiplatform/multiplatform-publish-lib-setup.html).
