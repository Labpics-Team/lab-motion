# Behaviors-путь

> Роль: контракт `./behaviors` — headless state machines типовых мобильных
> взаимодействий поверх переиспользуемых примитивов движка.

Субпуть только оркеструет — ничего не дублируется: трекер скорости из
`./gestures`, проекция момента из `./decay`, пружинный солвер ядра,
темп-токены `./tokens`. Поведение не знает про фреймворк/компонентную
библиотеку: DOM-обвязка ниже — тонкий адаптер.

Общий контракт: `BehaviorState { value, velocity, phase }`,
`phase ∈ 'idle' | 'follow' | 'release' | 'settle'`. Вход — `pointerDown`/
`Move`/`Up`/`Cancel` с точкой `{ x, y, t }` (`t` — секунды, напр.
`e.timeStamp / 1000`); выход — `state`-геттер + `subscribe`; программные
переходы и идемпотентные `cancel()` / `destroy()`.

## Четыре поведения

- **`createBottomSheet`** — snap-точки, rubber-band за крайними snap,
  программный `snapTo(index)`, перехват новым pointer-down.
- **`createDragDismiss`** — порог по смещению ИЛИ скорости, настраиваемое
  направление, возврат с унаследованной скоростью при недостигнутом пороге,
  детерминизм при `pointerCancel` (всегда домой, без закрытия).
- **`createCarousel`** — index выводится из position каждый кадр, inertia с
  доводкой к странице, RTL и вертикаль, `goTo`/`next`/`prev`.
- **`createPullToRefresh`** — резистентный overscroll, порог активации,
  `pending` БЕЗ второго владельца позиции (удержание — тот же единственный
  runner), возврат пружиной после async-действия.

Runnable DOM-адаптер bottom sheet (transform из headless-состояния, полная
связка pointer-событий, программный `snapTo`) — в [recipes.md](recipes.md).

## Ключевые свойства (все запинены тестами)

- **Один clock (одна state machine)**: pointer / programmatic control не плодят
  параллельных loops — единый generation-токен гасит stale-кадры, активен
  максимум один runner. Перехват pointer-down во время доводки → `follow` без
  утечки цикла.
- **C¹ на стыке follow→release**: скорость момента отпускания наследуется
  доводкой (`v0n = velocity / range` в пружинном солвере) — как smooth-pickup
  у `MotionValue`.
- **Выбор цели по положению+скорости**: snap/страница выбираются по проекции
  момента через `./decay` (`.rest`) — быстрый флик перепрыгивает snap;
  property-тесты (seeded-LCG) пинят «ближайший к decay-landing» на диапазоне
  value+velocity.
- **Reduced-motion = смена характера**: пространственная доводка снапает в
  цель МГНОВЕННО (ни одного кадра), состояние и результат сохранены — не
  «выключение».
- **Финитность и SSR-safe**: `value`/`velocity` всегда конечны (никогда
  NaN/∞, `-0` схлопнут — fuzz-гейт злого ввода), импорт не трогает
  window/document; единственный платформенный шов — инжектируемый
  `requestFrame` (детерминизм тестов).
- **`cancel()`/`destroy()` идемпотентны**: `destroy` делает вход инертным.
