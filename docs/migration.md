# Миграция с Motion JS / Anime.js

> Роль: практическое руководство — карта переноса конкретных вызовов на
> `@labpics/motion/animate`, с честными границами объединённого.

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
