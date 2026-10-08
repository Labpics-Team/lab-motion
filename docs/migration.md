# Переход на root API

Версия 0.5 переносит обычную работу в `@labpics/motion`. Прежние прямые модули
сохраняются для специализированных интеграций. Не смешивайте двух независимых
владельцев одного CSS-свойства на одном элементе.

| Прежний вызов | Root API |
| --- | --- |
| `import { animate } from '@labpics/motion/animate'` | `import { animate } from '@labpics/motion'` |
| `createAnimateScope(root)` / `destroy()` | `scope(root)` / `dispose()` |
| `controls.cancel()` | `controls.stop()` |
| `await controls.finished` без результата | Проверка `result.status` перед удалением DOM |
| `new MotionValue(...)` для обычного числа | `value(initial)` или `scope.value(initial)` |
| Выбор Nano/WAAPI/JS | Исполнитель выбирается внутри root `animate` |

Обычная одиночная цель продолжает актуальное движение. Массив значений явно
задаёт перезапускаемую траекторию; без настроек он использует 200 мс и linear.
Повтор той же цели передаёт controller новому вызову, сохраняя исполняемую
траекторию. Прежний controller завершается как `stopped`.

Числовые модели прежнего ядра доступны в низкоуровневом `@labpics/motion/driver`.
Фреймворк-адаптеры прежней модели сохраняют собственные контракты. Для нового
компонента достаточно создать `scope` в lifecycle-эффекте и вызвать `dispose`
при очистке; пример приведён в [начале работы](getting-started.md).

## Предыдущие способы интеграции


## Переход с 0.3 на 0.4: правила компонентов

Из `@labpics/motion/behaviors` удалены четыре фабрики и связанные с ними
типы `Sheet*`, `Carousel*`, `Dismiss*`, `Pull*`, `BehaviorState`,
`BehaviorPhase`, `BehaviorPoint` и `BehaviorAxis`.

| Прежний API | Подключение |
| --- | --- |
| `createBottomSheet` | `createCompositorFollow`; точки остановки, выбранная точка и ограничения принадлежат компоненту. [Прямой ввод панели](recipes.md#прямой-ввод-панель-и-карусель) |
| `createCarousel` | Тот же `createCompositorFollow`; приложение переводит страницу и направление в координату. [Прямой ввод страниц](recipes.md#прямой-ввод-панель-и-карусель) |
| `createDragDismiss` | Жест распознаётся через `createPan`; приложение решает, достигнут ли порог, и передаёт цель в `follow.settle`. Видимость и завершение ухода координирует [presence](presence.md) |
| `createPullToRefresh` | Компонент владеет порогом, запросом обновления и состоянием ожидания; `createCompositorFollow` ведёт значение и доводит его до выбранной позиции |

Для явной передачи движения между живым и нативным исполнением доступны
отдельные рецепты на `CompositorSpring`: [панель](recipes.md#sheet-живая-фаза-и-автономный-snap)
и [страницы](recipes.md#pager-страницы-и-rtl-принадлежат-компоненту).

`createStateCascade` остаётся в `./behaviors`, `createReorder` в
`./behaviors/reorder`. Основные импорты `./animate`, `./nano`, `./compositor/follow`
и биндинги фреймворков сохраняются. Повторная цель и новый ввод продолжают
движение через того же владельца; вручную переносить скорость не требуется.

Обновите вызовы и импорты типов до установки 0.4. Компонентные фабрики
доступны только в прежнем выпуске 0.3; совместимых псевдонимов в 0.4 нет.

## Перенос с Motion JS / Anime.js

`./animate` даёт похожую one-liner форму для перечисленного ниже подмножества
одиночных переходов CSS-стилей DOM- и SVG-элементов. Таблицы — карта переноса
конкретных вызовов, а не утверждение о совпадении возможностей, поведения или
lifecycle. Полный целевой пользовательский охват ведётся в
[roadmap #106](https://github.com/Labpics-Team/lab-motion/issues/106).

## Motion JS → `./animate`

| Motion JS | `@labpics/motion/animate` | Заметка |
|---|---|---|
| `animate(el, { x: 100 })` | `animate(el, { x: 100 })` | совпадает этот `x/y`-срез; у Motion набор transform-осей шире |
| `animate(el, { opacity: [0, 1] })` | `animate(el, { opacity: [0, 1] })` | пара `[from, to]` — тот же смысл |
| `animate(el, { x: 100 }, { type: 'spring', stiffness: 200 })` | `animate(el, { x: 100 }, { spring: { mass: 1, stiffness: 200, damping: 20 } })` | пружина как `SpringParams` |
| `animate(el, { x: 100 }, { duration: 0.3 })` | `animate(el, { x: 100 }, { duration: 300 })` | **мс, не секунды** |
| `animate(el, { x: 100 }, { delay: 0.1 })` | `animate(el, { x: 100 }, { delay: 100 })` | мс |
| `animate('.item', …, { delay: stagger(0.05) })` | `animate('.item', …, { stagger: 50 })` | шаг-мс между целями |
| `const a = animate(…); a.pause(); a.play()` | то же | после естественного завершения Motion перезапускается, Lab Motion — нет |
| `await animate(…)` или `animate(…).then(…)` | `await animate(…).finished` | у Motion контрол — thenable; у Lab Motion — отдельный Promise `finished` |
| `a.time = 0.5` | `a.seek(500)` | у Motion — секунды и getter/setter; `seek` у Lab Motion — write-only, мс |
| `a.stop()` | `a.stop()` | оба сохраняют текущую позу; в Lab Motion `stop` — алиас `cancel` |
| `a.cancel()` | прямого эквивалента нет | Motion возвращает initial pose; Lab Motion сохраняет текущую |
| `animate(el, { '--x': 100 })` | `animate(el, { '--x': ['0px', '100px'] })` | CSS-переменная с юнитом |

## Anime.js (v4) → `./animate`

| Anime.js v4 | `@labpics/motion/animate` | Заметка |
|---|---|---|
| `animate(el, { translateX: 100 })` | `animate(el, { x: 100 })` | Anime v4 также допускает shorthand `x`; Lab Motion использует `x/y` |
| `animate(el, { opacity: [0, 1], duration: 300 })` | `animate(el, { opacity: [0, 1] }, { duration: 300 })` | у Anime параметры — во втором объекте; у Lab Motion опции — третий аргумент |
| `{ ease: 'inOutCirc' }` | `{ ease: circInOut }` | `circInOut` импортируется из `./easing` |
| `{ delay: stagger(50) }` | `{ stagger: 50 }` | в Anime v4 `stagger` — именованный импорт |
| `animate(targets, parameters)` | `animate(targets, props, options)` | разные сигнатуры, общий только one-liner характер |

## Границы объединённого

`./animate` объединяет одним lifecycle только from/to-переходы поддерживаемых
CSS-стилей и transform-шортхендов: spring/tween, delay/stagger и контролы
`finished/play/pause/seek/cancel/stop`.

Не объединены: N-keyframes и offsets, per-segment и per-property transitions,
repeat/reverse/mirror/repeatDelay, inertia/decay, sequences/timeline,
value/object targets, HTML/SVG attributes и path-specific SVG-каналы.
`SVGElement` при этом уже является допустимой целью для поддерживаемых
CSS-стилей. Низкоуровневые субпути не объединены общим владельцем: нет общего
`finished` и контракта прерывания/cleanup. Также отсутствуют thenable control,
`time/speed/duration` getters, `reverse`, `complete` и `restart`. Публичного
API регистрации произвольных кодеков или адаптеров целей пакет не
предоставляет.


## Компонентные области

Для локальных селекторов и совместной остановки используйте `createAnimateScope`
из `./animate`: создавайте scope в setup/mount и вызывайте `scope.destroy()` при
cleanup. В React область принадлежит конкретному запуску эффекта, в Solid — owner.
[Полные runnable-примеры](recipes.md#анимации-принадлежащие-компоненту).

Это не полная замена Motion `useAnimate`, Anime Scope или GSAP Context. В частности,
`destroy` сохраняет текущую позу согласно Lab Motion cancel и не восстанавливает
старые inline styles, как revert. Область не владеет произвольными listeners и
не добавляет отсутствующие keyframes/sequences/playback возможности.
## Контролируемая перестановка вместо собственного sortable resolver

Для list/grid используйте `createReorder` из `@labpics/motion/behaviors/reorder`.
`onReorder` предлагает новый порядок, который обязан принять владелец данных,
после чего передать новый snapshot через `update`. Это сохраняет привычную
controlled-модель values/onReorder, но не копирует React `Reorder.Group`.

Resolver headless: вместо wrapper-компонентов получает stable keys и измеренную
geometry. Для pointer/keyboard + layout используйте [проверяемый рецепт](recipes.md#перестановка-списка-или-сетки).
Нет неявного drag-follow, автопрокрутки, cross-list transfer или virtualizer.
Неизмеренные ячейки не угадываются. Native TypeError/RangeError относятся к
структуре snapshot; ошибки физики внешнего projection сохраняют свой контракт.
## Обновление непрерывного слежения MotionValue

При `setTarget` в полёте больше нет дополнительного кадра с остановленными часами.
При обычном перенаправлении `value` и `velocity` на самой границе остаются прежними;
следующий timestamp продолжает движение от времени этого snapshot. Возврат к уже
достигнутому значению при `|velocity| < 1e-10` завершает движение и обнуляет
остаточную скорость без дополнительного `onChange`. Повтор неизменной активной цели
теперь сохраняет текущую траекторию. Код, намеренно перезапускавший движение через
повтор `setTarget(sameTarget)`, должен явно выполнить `stop()` перед новым запуском.
Не используйте повтор цели как способ задерживать движение на кадр.