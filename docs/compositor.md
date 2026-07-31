# Compositor-путь

> Роль: контракт compositor-пути — фазовая модель, ретаргет, хендофф,
> fallback-матрица и границы гарантий. Матрица тиров и её детекция реализованы
> в `src/compositor/detect.ts`; расхождение доки с кодом — дефект.

Автономный переход не обязан жить на главном потоке: пружина компилируется в
адаптивный WAAPI-план (`Element.animate`) и исполняется браузером на
compositor-потоке — блокировка главного потока не замораживает движение.

Чистый компилятор доступен и без контроллера (SSR-safe, DOM не трогает):

```typescript
import { compileSpringLinear } from '@labpics/motion/compositor';

const easing = compileSpringLinear({ mass: 1, stiffness: 170, damping: 26 });
document.querySelector<HTMLElement>('.card')!
  .style.transition = `transform 0.9s ${easing}`;
```

## Фазовая модель: когда какой путь

Путать фазы — класс дефекта:

- **Compositor (`./compositor`, `./waapi`)** — автономные переходы, settle и
  release-фаза жеста: скомпилировать адаптивную кривую → `Element.animate`
  (форма исполнения по движку — см. fallback-матрицу). Пружина переживает
  блокировки главного потока и не планирует на нём покадровую работу.
- **Main-поток (`drive` / `MotionValue` / `./gestures`)** — интерактив и
  follow-фаза (палец ведёт значение, будущая траектория неизвестна).
- **Прерывание compositor-анимации** — редкое ONE-SHOT событие
  (`CompositorSpring.retarget`): serialized snapshot по native currentTime +
  cancel + новая кривая. **Непрерывный ретаргет каждый кадр (gesture-follow
  через cancel+re-emit) — задокументированный АНТИПАТТЕРН**: для слежения
  берите главный поток.
- **`will-change`** — ограниченная дисциплина у потребителя: включать точечно
  перед переходом и снимать после завершения, не «на всякий случай».

## CompositorSpring: ретаргет и хендофф

Публичный API один на всех тирах. В effect-space numeric/affine-канала при
default `fill:'both'` прерывание точно продолжает position и правый slope
кусочно-линейного сегмента. На самом stop-kink производная неоднозначна — выбран
правый сегмент. Это не обещание rendered-pixel C¹ для clamping, non-affine
`format`, меняющегося underlying/composite или custom fill вне active interval.

```typescript
import { CompositorSpring } from '@labpics/motion/compositor';

const panel = new CompositorSpring({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'transform', from: 0, to: 240,
  target: el, format: (v) => `translateX(${v}px)`,
  apply: (val) => { el.style.transform = String(val); }, // только на fallback-пути
});
panel.start();

// ДИСКРЕТНОЕ прерывание: O(log K) snapshot execution-stops без style/layout-read.
panel.retarget(120);

// ХЕНДОФФ compositor→live: траектория перестала быть автономной (палец перехватил
// значение — follow-фаза). Снимок → живая rAF-пружина продолжает без разрыва.
const live = panel.handoffToLive();      // продолжить к текущей цели, ИЛИ
const live2 = panel.handoffToLive(300);  // сразу к новой цели с сохранённой скоростью
```

Число raw diagnostic-узлов выводится из бюджета реконструкции (допуск
`DEFAULT_TOLERANCE`, адаптивная сетка + упрощение): жёстче пружина — короче
кривая. Один exact-key bounded LRU хранит execution artifact `{ linear(),
serialized samples }`: Chromium исполняет строку, WebKit строит из тех же
numeric samples явные кадры, snapshot сэмплирует их бинарным поиском.

## Composited stagger (каскад группы)

Задержки каждого элемента — нативный WAAPI-`delay` поверх ОДНОЙ запечённой
кривой: общей строки `linear()` в Chromium/Firefox или общего набора узлов в
WebKit. Группа строит сетку/RDP ровно один раз независимо от N; ограниченный
cache переиспользует результат. **Покадровая стоимость каскада — ноль**: его
исполняет браузер, планирование одноразово.

```typescript
import {
  CompositorSpring,
  CompositorStaggerGroup,
  compileSpringPlan,
  compileStaggerPlan,
} from '@labpics/motion/compositor/stagger';

// Чистый планировщик (SSR-safe): общая кривая + per-element задержки (headless).
const plan = compileStaggerPlan({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'opacity', from: 0, to: 1,
  count: 5, gap: 40, staggerFrom: 'first',   // → delays [0, 40, 80, 120, 160] мс
});

// Контроллер группы: N целей делят кривую, каждый стартует со своей задержкой.
const list = new CompositorStaggerGroup({
  spring: { mass: 1, stiffness: 170, damping: 26 },
  property: 'transform', from: 24, to: 0,
  targets: rows,                              // N Element'ов; count = rows.length
  gap: 40, staggerFrom: 'center',
  format: (v) => `translateY(${v}px)`,
  apply: (i, v) => { rows[i].style.transform = String(v); }, // только fallback-путь
});
list.start();                                 // каскад: N Element.animate с delay[i]
```

Одиночный и групповой контроллеры вместе импортируйте из
`./compositor/stagger` (смешивание двух compositor-entry дублирует
предсобранное ядро); без групп используйте меньший `./compositor`.

Граница per-group vs per-element: каскад (`start`) — per-GROUP (это и
есть composited-выигрыш); `retarget(i, to)` / `retargetAll(to)` — per-ELEMENT
без пере-каскада (дискретное прерывание, не новый парад); `handoffToLive(i, to?)`
отдаёт ОДИН элемент в живую rAF-пружину, группового хендоффа нет.
`reducedMotion` схлопывает задержки в 0 — анимируются одновременно
(character-switch, не hard-off).

## Fallback-матрица

`CompositorSpring` прозрачно деградирует: публичный API один, точная
effect-space гарантия ограничена условиями выше — меняется движок под капотом.
Тир определяется возможностями один раз в конструкторе; отдельно форма
исполняемого плана один раз на реалм учитывает WebKit через узкий
мемоизированный шов `navigator.vendor + AppleWebKit` — независимость
многостопового `linear()` от главного потока не наблюдаема через API
возможностей, а синтаксическая поддержка даёт ложноположительный ответ.
Фактический тир — диагностическое поле `CompositorSpring.tier`.

Выбор тира — в порядке precedence: доступность (`reduced`) перекрывает любой
доступный движок, дальше решают WAAPI, локальное правило WebKit и CSS
`linear()`; без DOM и инжектированного `requestFrame` остаётся `ssr`:

| Тир | Условие | Движок / поведение | Что теряем |
|---|---|---|---|
| `compositor` | WAAPI + (явные кадры WebKit **или** CSS `linear()`) | WebKit: адаптивные явные кадры; Chromium/Firefox: два кадра + CSS `linear()`. Оба пути не зависят от главного потока | — (полный путь) |
| `waapi-no-linear` | Не-WebKit: WAAPI есть, CSS `linear()` нет | Живой rAF (`MotionValue`) на главном потоке — доступной независимой формы пружинной кривой нет | Анимация чувствительна к блокировкам главного потока |
| `raf` | Нет `Element.animate` | Живой rAF (`MotionValue`) на главном потоке | То же, что выше |
| `reduced` | `prefers-reduced-motion: reduce` | **Мгновенный снап** к цели: значение эмитится один раз, без анимации | Всякое движение (осознанно — политика доступности) |
| `ssr` | Нет DOM и нет инжектированного `requestFrame` | Тот же rAF-движок под Node-обвязкой; импорт и конструктор не трогают `window`/`document` | На сервере кадры не рисуются |

Границы: (1) все не-`compositor` тиры кроме `reduced` идут в ОДИН живой
rAF-движок — ярлыки различают ПРИЧИНУ (телеметрия); (2) детекция одноразовая —
WAAPI/`linear()` за жизнь контроллера и WebKit-policy за жизнь реалма не
переопрашиваются; (3) на `waapi-no-linear`/`raf` анимация делит главный поток.

Политика reduced-motion — мгновенный снап к финальному значению, ЕДИНАЯ для
всего пакета (`drive`/`keyframes`/`presets` тоже резолвятся в финал сразу):
один характер, ноль дрифта. Детекция reduce — один раз на входе; смена
системного предпочтения в полёте не подхватывается.

Диагностика: `resolveCompositorTier({ target?, matchMedia?, requestFrame? })` —
тир без конструирования контроллера; `supportsLinearEasing()` — кэшированная
проба `linear()`; `supportsCompositor(target?)` — булев предикат.

## Поддержка браузеров

Тир выражен возможностями среды (WAAPI, CSS `linear()`, reduced-motion), а не
версией браузера; единственное локальное исключение — форма исполняемого плана
для WebKit через мемоизированный шов, описанный выше.

| Среда | Статус | Основание |
|---|---|---|
| Chromium (Chrome/Edge) | Полный `compositor`-путь | WAAPI + CSS `linear()` |
| Firefox | Полный `compositor`-путь | WAAPI + CSS `linear()` |
| WebKit (Safari и браузеры iOS) | Полный `compositor`-путь | WAAPI + адаптивные явные ключевые кадры; многостоповый `linear()` не используется |
| Не-WebKit без CSS `linear()` | `waapi-no-linear` → живой rAF | доступной off-main формы пружинной кривой нет |
| Без `Element.animate` | `raf` → живой rAF | нет WAAPI |
| SSR / Node ≥ 22 | `ssr` → импорт SSR-safe, кадры не рисуются | нет DOM; см. `pnpm pack:compat` |

Два уровня reduced-motion (единая политика — см. fallback-матрицу) и их
согласование:

- **отдельная анимация** (`CompositorSpring`/`drive`/`keyframes`/…) читает
  предпочтение ОДИН раз при старте — уже запущенная НЕ переигрывается при смене
  системного предпочтения («read once»);
- **`createMotionConfig`** (`./a11y`) держит ЖИВУЮ подписку — влияет на
  анимации, запускаемые ПОСЛЕ смены (потребитель перечитывает конфиг), а не на
  идущие. Противоречия нет: живая подписка — про будущие запуски, «read once»
  — про текущий.

**Явно НЕ поддержано (документировано, не маскируется fallback'ом):**

- ограничения `./projection` (осевая модель, `fixed`/`sticky`,
  scroll-контейнеры, shadow root'ы, чужой `transform`) — полный список в
  «Не-целях v1» [projection.md](projection.md);
- покадровый `retarget` при слежении за жестом — антипаттерн (см. фазовую
  модель): follow-фаза живёт на главном потоке (`./gestures` + `MotionValue`).

## Conformance-слой

Serialized effect сверяется с аналитическим солвером в пределах tolerance, а
Chromium/Firefox/WebKit — между собой в `browser/*.spec.ts`. Локально:
`pnpm test:browser` (только Chromium, opt-in — в дефолтный `pnpm test`
браузеры не входят). Полная матрица Chromium/Firefox/WebKit гоняется на CI
для каждого PR (`.github/workflows/browser.yml` — без paths-фильтра, чтобы
required check не исчезал).

Независимость WebKit-пути от главного потока дополнительно проверяет видеостенд
`bench/compare/webkit-freeze.mjs` (запуск — `cd bench/compare && node
webkit-freeze.mjs` после корневого `pnpm build`): во время блокировки на 900 мс
синий контроль WAAPI задаёт окно измерения, контрфакт с многостоповым
`linear()` замирает, а исполняемый план с явными кадрами обязан продолжать
менять экранную позицию. Consumer-контракт тарбола — `pnpm pack:compat`.

## Латентность (справочно)

`pnpm bench:latency` измеряет p50/p95/p99 одноразовых compositor-операций;
`pnpm bench:ceiling` — массовый старт и кадр для N=1/100/1000, долю бюджета
120/240 Гц и жёсткий машинонезависимый закон: один native `requestFrame` на
кадр независимо от числа целей, без idle wakeups (сценарии и правила — в
[benchmark.md](benchmark.md)). Wall-clock числа машинозависимы и берутся
только из свежего вывода команд.

**Границы замера.** Стенд меряет ТОЛЬКО main-thread cost (Node, против
`dist`). Compositor-резидентность и input→photon **не наблюдаемы из JS** —
достоверно только реальным Chrome + tracing (`cc.animation` в DevTools
Performance), вне CI-скоупа.
