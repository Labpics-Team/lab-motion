# Фреймворк-адаптеры — ./react, ./vue, ./svelte, ./solid, ./preact, ./angular, ./lit, ./wc, ./qwik

> Роль: справка — полный API девяти фреймворк-биндингов headless-ядра: React/Preact-хуки, Vue-композаблы и директива `v-motion`, Svelte-store, Solid-примитивы, Angular inject-функции, Lit-контроллер с элементом `<lab-motion-spring>`, vanilla custom element `<lab-spring>` и Qwik-хук.

## Назначение

Все девять субпутей — тонкие адаптеры одного и того же headless-значения `MotionValue` (см. [Ядро `.`](core.md)) к реактивной идиоме конкретного фреймворка. Общая модель:

1. Адаптер создаёт `MotionValue` через общий внутренний хелпер: без инжектированного `requestFrame` значение садится на **общий кадровый цикл** `./frame` (`asRequestFrame()`, см. [./driver и ./frame](driver-frame.md)) — один rAF на все живые значения приложения. Инжектированный `requestFrame` (тесты, кастомный планировщик) выигрывает.
2. Подписка `mv.onChange(...)` транслирует каждый кадр в идиому фреймворка: `setState` (React/Preact), `ref` (Vue), store-подписчики (Svelte), сигнал (Solid/Angular/Qwik), `host.requestUpdate()` (Lit) — либо пишет напрямую в `style` элемента (effect-binding пути: `useMotionStyle`, `v-motion`, `<lab-motion-spring>`, `<lab-spring>`). DOM-записи живут только в адаптере — ядро остаётся zero-DOM.
3. Смена цели mid-flight подхватывает текущую скорость (C¹ smooth pickup) — без разрыва траектории.

Общие параметры во всех адаптерах (единицы и дефолты — из кода ядра):

- Значения и цели — числа в единицах потребителя, обязаны быть конечными (`NaN`/`±Infinity` → `MotionParamError` `LM045`).
- `spring?: SpringParams` — физика пружины; дефолт везде `{ mass: 1, stiffness: 200, damping: 20 }` (`mass` — кг, `stiffness` — Н/м, `damping` — Н·с/м). Валидация при создании: `LM088`–`LM091`.
- `reducedMotionMode?: 'instant' | 'fade'` — дефолт `'instant'`. Числовой путь у обоих режимов одинаков (синхронный снап при активном `prefers-reduced-motion`); `'fade'` — договорённость с CSS потребителя: добавьте короткий `transition` (например, `transition: opacity 0.2s`, то есть 200 мс) на элемент.
- `requestFrame?: RequestFrameFn` — инжектируемый rAF-шов; колбэк получает timestamp в **миллисекундах** (rAF-конвенция), внутренняя физика считает в секундах. Возврат `handle === 0` (конвенция non-draining step-clock в тестах) переключает цикл на `setTimeout(0)`-фоллбек с фиксированным шагом 1/60 с.

Фреймворки — **optional peerDependencies**; рантайм-зависимостей у пакета нет. Только `./lit` и `./wc` помечены `sideEffects` (авторегистрация custom elements при импорте) — остальные субпути tree-shak-аются целиком. Веса артефактов — не в этой странице: снимок чисел даёт вывод `pnpm size` / `pnpm bench`, свод — в [docs/benchmark.md](../benchmark.md).

## Импорт

Каждый субпуть самостоятелен (ESM и CJS ветки в `exports` package.json); в бандл попадает только импортированное:

```ts
import { useMotionValue, useSpring, useMotionStyle, useReducedMotion } from '@labpics/motion/react';
import { useMotionValue as useVueMotionValue, useSpring as useVueSpring, vMotion } from '@labpics/motion/vue';
import { springStore } from '@labpics/motion/svelte';
import { createMotionValue, createSpring } from '@labpics/motion/solid';
import { useMotionValue as usePreactMotionValue, useSpring as usePreactSpring } from '@labpics/motion/preact';
import { injectMotionValue, injectSpring } from '@labpics/motion/angular';
import { MotionController, LabMotionSpringElement, LAB_MOTION_SPRING_TAG } from '@labpics/motion/lit';
import { defineLabSpring, createLabSpringElementClass, renderTemplateValue, LAB_SPRING_TAG } from '@labpics/motion/wc';
import { useSpring as useQwikSpring } from '@labpics/motion/qwik';
```

| Субпуть | Peer (optional) | Runtime-экспорты | Идиома |
| --- | --- | --- | --- |
| `./react` | `react >=18.0.0` | `useMotionValue`, `useSpring`, `useMotionStyle`, `useReducedMotion` | хуки |
| `./vue` | `vue >=3.0.0` | `useMotionValue`, `useSpring`, `vMotion` | композаблы + директива |
| `./svelte` | `svelte >=4.0.0` | `springStore` | store-контракт |
| `./solid` | `solid-js >=1.8.0` | `createMotionValue`, `createSpring` | create-примитивы |
| `./preact` | `preact >=10.3.1` | `useMotionValue`, `useSpring` | хуки (`preact/hooks`) |
| `./angular` | `@angular/core >=16.0.0` | `injectMotionValue`, `injectSpring` | inject-функции + Signals |
| `./lit` | `lit >=3.0.0` | `MotionController`, `LabMotionSpringElement`, `LAB_MOTION_SPRING_TAG` | ReactiveController + custom element |
| `./wc` | — (платформенные custom elements) | `defineLabSpring`, `createLabSpringElementClass`, `renderTemplateValue`, `LAB_SPRING_TAG` | vanilla custom element |
| `./qwik` | `@builder.io/qwik >=1.4.0` | `useSpring` | сериализуемые сигналы |

## API

Ниже сигнатуры даны в форме объявлений; фактические типы `MotionValue`, `SpringParams`, `RequestFrameFn` — из корневого экспорта `@labpics/motion` (см. [Ядро `.`](core.md)).

### ./react

```ts
import type { MotionValue, SpringParams, RequestFrameFn } from '@labpics/motion';

declare function useMotionValue(
  initial: number,                              // конечное; иначе LM045
  spring?: SpringParams,                        // дефолт { mass: 1, stiffness: 200, damping: 20 }
  requestFrame?: RequestFrameFn,
): MotionValue;

declare function useSpring(
  target: number,                               // конечное; иначе LM045
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',       // дефолт 'instant'
  requestFrame?: RequestFrameFn,
): number;

interface MotionStyleOptions {
  target: number;                               // конечное; иначе LM045
  property?: string;                            // дефолт 'opacity'
  template?: string;                            // дефолт '{v}'; пример: 'translateX({v}px)'
  from?: number;                                // дефолт target (статично до первого ре-таргета)
  spring?: SpringParams;
  reducedMotionMode?: 'instant' | 'fade';
  requestFrame?: RequestFrameFn;
}

declare function useMotionStyle(options: MotionStyleOptions): (el: HTMLElement | null) => void;

declare function useReducedMotion(matchMedia?: (q: string) => MediaQueryList): boolean;
```

- **`useMotionValue`** — стабильный `MotionValue` на всё время жизни компонента; создаётся один раз, разрушается на unmount (финализатор в insertion-effect: переживает StrictMode-реплей setup→cleanup→setup без утечки и без обращения к уничтоженному значению). Анимация — `mv.setTarget(v)`. Бросает `LM045`/`LM088`–`LM091` синхронно при первом рендере.
- **`useSpring`** — *render value*: компонент ре-рендерится на каждый кадр. Возврат стартует с `target` (mount-анимации нет — анимируется только изменение пропа; для entrance-анимации используйте `useMotionStyle` с `from`). При активном `prefers-reduced-motion` смена `target` — синхронный снап через `MotionValue.snapTo`.
- **`useMotionStyle`** — *effect binding*: ноль ре-рендеров на кадр; хук владеет `MotionValue` и пишет в `el.style[property]` строку `template` с подставленным `{v}` прямо из подписки. Возвращает стабильный ref-колбэк; поздний/условный attach немедленно получает текущее значение. Смена `property` переписывает значение в новое свойство и очищает прежнее inline-свойство; смена `property`/`template` без смены цели переформатирует текущее значение синхронно. Записи — в layout-effect до paint (в SSR деградация до `useEffect`). Неконечный `from` → `LM045`.
- **`useReducedMotion`** — реактивное отражение `prefers-reduced-motion: reduce`: построено на `useSyncExternalStore`, серверный снимок всегда `false` (hydration-safe), подписка реиспользует `createMotionConfig` из [./a11y](a11y.md) (системный `change`-listener + `destroy()` без утечки). `matchMedia` — инжектируемый шов; передавайте стабильную ссылку (или опускайте), свежая функция на каждый рендер пересоздаёт подписку. Не бросает.

### ./vue

```ts
import type { Ref, ObjectDirective } from 'vue';
import type { MotionValue, SpringParams, RequestFrameFn } from '@labpics/motion';

declare function useMotionValue(
  initial: number,
  spring?: SpringParams,
  requestFrame?: RequestFrameFn,
): MotionValue;

declare function useSpring(
  target: Ref<number> | (() => number),
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',
  requestFrame?: RequestFrameFn,
): Readonly<Ref<number>>;

interface MotionDirectiveValue {
  target: number;                               // обязателен; неконечный → LM045
  property?: string;                            // дефолт 'opacity'
  template?: string;                            // дефолт '{v}'
  from?: number;                                // дефолт target; НЕконечный from молча игнорируется
  spring?: SpringParams;
  reducedMotionMode?: 'instant' | 'fade';       // дефолт 'instant'
  requestFrame?: RequestFrameFn;
}

declare const vMotion: ObjectDirective<Element, MotionDirectiveValue>;
```

- **`useMotionValue`** — как в React, но уборка через `onUnmounted`. Вне компонентного контекста lifecycle-хук недоступен (проглатывается) — зовите `mv.destroy()` вручную.
- **`useSpring`** — принимает ref **или** getter; начальное значение читается синхронно в `setup`, дальше `watch` гонит анимацию на каждую смену цели. Возврат — readonly-`ref` с текущим значением.
- **`vMotion`** — декларативная директива: `<div v-motion="{ target, property, template, from, spring }" />`. Регистрация: глобально `app.directive('motion', vMotion)` или локально в `<script setup>`. Жизненный цикл: `mounted` создаёт `MotionValue` (`initial = from ?? target`; при заданном конечном `from` элемент анимируется `from → target` сразу после mount) и стартует к цели; `updated` ре-таргетит с подхватом скорости, а смена `property`/`template` переформатирует текущее значение и очищает прежнее inline-свойство **после** успешной записи нового (невалидная цель откатывает presentation-состояние и пробрасывает ошибку); `unmounted` отписывает и разрушает. Состояние — per-element `WeakMap`, DOM-атрибуты не загрязняются. SSR-safe: хуки директивы Vue на сервере не вызывает.

### ./svelte

```ts
import type { SpringParams, RequestFrameFn } from '@labpics/motion';

interface SpringStore {
  subscribe(run: (value: number) => void): () => void;  // эмитит текущее значение сразу
  set(target: number, reducedMotionMode?: 'instant' | 'fade'): void;
  destroy(): void;                                      // обязателен в onDestroy
}

declare function springStore(
  initial: number,
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',
  requestFrame?: RequestFrameFn,
): SpringStore;
```

- **`springStore`** — store Svelte-контракта (`subscribe`/`set`): работает и с `$x`-автоподпиской, и как фреймворк-независимый store в чистом TS. `subscribe` синхронно эмитит текущее значение; `set(target)` анимирует пружиной (mid-flight — подхват скорости), при активном `prefers-reduced-motion` — синхронный снап. Per-call `reducedMotionMode` переопределяет store-настройку; числовой путь режимы не различает (оба — снап), различие — CSS потребителя. Автоуборки нет: **`destroy()` в `onDestroy` обязателен** (останавливает анимацию и очищает подписчиков).

### ./solid

```ts
import type { MotionValue, SpringParams, RequestFrameFn } from '@labpics/motion';

declare function createMotionValue(
  initial: number,
  spring?: SpringParams,
  requestFrame?: RequestFrameFn,
): [MotionValue, () => void];                   // [значение, dispose]

declare function createSpring(
  initial: number,
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',
  requestFrame?: RequestFrameFn,
): [() => number, (target: number) => void, () => void]; // [value, setTarget, destroy]
```

- **`createMotionValue`** — живой `MotionValue` + явный `dispose`. Уборка двухканальная: при живом owner (`getOwner() !== null`) `onCleanup` регистрируется автоматически; вне реактивного корня — зовите `dispose` сами (двойной вызов безопасен).
- **`createSpring`** — числовой сигнал: значение читается вызовом аксессора `x()`. `setTarget` после уборки (owner-cleanup или явный `destroy`) — no-op, диспетча в разрушенное ядро нет. Reduced-motion — снап через `snapTo`.

### ./preact

```ts
import type { MotionValue, SpringParams, RequestFrameFn } from '@labpics/motion';

declare function useMotionValue(
  initial: number,
  spring?: SpringParams,
  requestFrame?: RequestFrameFn,
): MotionValue;

declare function useSpring(
  target: number,
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',
  requestFrame?: RequestFrameFn,
): number;
```

Зеркало React-хуков поверх `preact/hooks` — отдельный субпуть, а не алиас: свой рантайм, `preact/compat` не требуется. Отличия от `./react`: уборка `useMotionValue` — в обычном (passive) effect; `useMotionStyle` и `useReducedMotion` в этом субпуте отсутствуют.

### ./angular

```ts
import type { Signal } from '@angular/core';
import type { MotionValue, SpringParams, RequestFrameFn } from '@labpics/motion';

declare function injectMotionValue(
  initial: number,
  spring?: SpringParams,
  requestFrame?: RequestFrameFn,
): MotionValue;

declare function injectSpring(
  initial: number,
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',
  requestFrame?: RequestFrameFn,
): [Signal<number>, (target: number) => void];  // [readonly-сигнал, setTarget]
```

Идиома Angular Signals (v16+): обе функции вызываются **только в injection context** (конструктор/инициализатор поля) — вне его `assertInInjectionContext` даёт честную Angular-ошибку `NG0203` (это `RuntimeError` Angular, не `MotionParamError`). Уборка — автоматически через `DestroyRef.onDestroy`. `injectSpring` возвращает readonly-сигнал (читается вызовом `x()`) и `setTarget`; после разрушения скоупа `setTarget` — no-op.

### ./lit

```ts
import type { ReactiveController, ReactiveControllerHost, LitElement } from 'lit';
import type { SpringParams, RequestFrameFn } from '@labpics/motion';

type MatchMediaFn = (query: string) => MediaQueryList;

interface MotionControllerOptions {
  readonly spring?: SpringParams;               // дефолт { mass: 1, stiffness: 200, damping: 20 }
  readonly requestFrame?: RequestFrameFn;
  readonly matchMedia?: MatchMediaFn | undefined; // undefined = window.matchMedia, если есть
}

declare class MotionController implements ReactiveController {
  constructor(host: ReactiveControllerHost, initial: number, options?: MotionControllerOptions);
  readonly value: number;                       // текущее значение; всегда конечно
  setTarget(target: number): void;              // неконечный target → LM045
  hostConnected(): void;
  hostDisconnected(): void;
}

declare const LAB_MOTION_SPRING_TAG: 'lab-motion-spring';
```

- **`MotionController`** — идиоматичный `ReactiveController`: подписывается на `MotionValue` в `hostConnected` и зовёт `host.requestUpdate()` на каждый кадр; DOM пишет сам хост в `render()`. Работает с **любым** `ReactiveControllerHost` (структурный контракт `addController`/`requestUpdate`), не только `LitElement`; `lit` импортируется type-only. `hostDisconnected` — `stop()`, не `destroy()`: disconnect в Lit не терминален, после reconnect `setTarget` продолжает работать. `matchMedia` — инжектируемый шов reduced-motion (SSR/тесты); reduced → `setTarget` снапает синхронно через `snapTo`.
- **`LabMotionSpringElement`** (`<lab-motion-spring>`) — generic-обёртка над контроллером: анимирует одно CSS-свойство собственного host-элемента. Реактивные свойства/атрибуты: `target` (number), `property` (string, дефолт `'opacity'`), `template` (string, дефолт `'{v}'` — все вхождения `{v}` заменяются числом). JS-only свойства (задаются до первой вставки в DOM, применяются один раз в первом `connectedCallback`): `spring`, `requestFrame`, `matchMedia`. `:host { display: inline-block }`, рендерит `<slot>`. Авторегистрация при импорте субпутя — только под `typeof customElements`-гардом (SSR-safe).
- **`LAB_MOTION_SPRING_TAG`** — строковая константа тега `'lab-motion-spring'`.

Type-only экспорты: `MotionControllerOptions`, `MatchMediaFn`.

### ./wc

```ts
import type { SpringParams, RequestFrameFn } from '@labpics/motion';

declare const LAB_SPRING_TAG: 'lab-spring';

interface SpringHostBase {
  style: Record<string, string>;
  getAttribute(name: string): string | null;
}

type MatchMediaFn = (query: string) => { readonly matches: boolean };

interface LabSpringHost extends SpringHostBase {
  target: number;                               // дефолт 0; снимок для initial при первом connect
  property: string;                             // дефолт 'opacity'
  template: string;                             // дефолт '{v}'
  spring: SpringParams | undefined;             // JS-only, до вставки в DOM
  requestFrame: RequestFrameFn | undefined;     // JS-only
  matchMedia: MatchMediaFn | undefined;         // JS-only
  connectedCallback(): void;
  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void;
}

declare function createLabSpringElementClass(Base: new () => SpringHostBase): new () => LabSpringHost;

interface ElementRegistry {
  get(name: string): unknown;
  define(name: string, ctor: new () => SpringHostBase): void;
}

declare function defineLabSpring(
  registry?: ElementRegistry,
  Base?: new () => SpringHostBase,
): (new () => LabSpringHost) | undefined;

declare function renderTemplateValue(template: string, value: number): string;
```

`<lab-spring>` — vanilla-зеркало `<lab-motion-spring>` **без lit**: ноль зависимостей вообще (только платформенные custom elements). Для стеков без фреймворка: vanilla, Astro client-side, HTML-first.

- **Контракт атрибутов** (наблюдаются `target`, `property`, `template`): атрибуты — враждебные строки, поэтому невалидный `target` (пустая строка, не-число, `NaN`/`Infinity`) **молча игнорируется** — броска из `attributeChangedCallback` нет. Валидный `target` анимирует пружиной; при reduced-motion — синхронный снап. Смена `property` переносит запись в новое свойство и очищает прежний inline-канал после успешной записи; смена `template` переформатирует текущее значение.
- **Жизненный цикл**: `MotionValue` создаётся лениво ровно один раз в первом `connectedCallback` (к этому моменту JS-свойства `spring`/`requestFrame`/`matchMedia` и поле `target` уже выставлены; невалидная пружина здесь бросит `LM088`–`LM091`) и переживает disconnect/reconnect: reconnect применяет **текущее** значение живой пружины, без прыжка в цель. Явного `destroy` нет — значение собирается GC вместе с элементом. Управление после вставки — только атрибутом `target` (прямое присваивание поля `target` анимацию не запускает).
- **`defineLabSpring(registry?, Base?)`** — регистрация: без аргументов берёт платформенные `customElements`/`HTMLElement` (в SSR — тихий no-op), возвращает класс или `undefined`, если регистрация невозможна или тег уже занят. Вызывается автоматически при импорте субпутя.
- **`createLabSpringElementClass(Base)`** — фабрика класса от инжектируемого базового конструктора: на импорте нет обращения к `HTMLElement`/`customElements`, биндинг тестируем без DOM.
- **`renderTemplateValue(template, value)`** — чистый хелпер подстановки: заменяет **все** вхождения `{v}` на `String(value)`; шаблон без `{v}` возвращает `String(value)`. Не бросает.

Type-only экспорты: `SpringHostBase`, `LabSpringHost`, `MatchMediaFn` (структурный, отличается от одноимённого в `./lit`), `ElementRegistry`.

### ./qwik

```ts
import type { Signal } from '@builder.io/qwik';
import type { SpringParams, RequestFrameFn } from '@labpics/motion';

interface QwikSpring {
  readonly value: Signal<number>;               // текущее анимированное значение
  readonly target: Signal<number>;              // присваивание target.value запускает анимацию
}

declare function useSpring(
  initial: number,
  spring?: SpringParams,
  reducedMotionMode?: 'instant' | 'fade',
  requestFrame?: RequestFrameFn,
): QwikSpring;
```

Форму диктует резумабельность Qwik: живой `MotionValue` несериализуем (`noSerialize`) и пересоздаётся на клиенте в `useVisibleTask$`; управление — **через сигнал** `target` (`x.target.value = 100`), потому что сигналы сериализуемы и переживают резюм. Ограничения контракта:

- Обе таски — `useVisibleTask$`: физика запускается только на клиенте после видимости; уборка (`destroy`) — на unmount.
- `requestFrame` — client-only тестовая инъекция: функция не сериализуема и через resume-границу не переносится (в SSR-приложении оставляйте дефолт).
- Mid-flight резюм: сериализуются только сигналы `value`/`target`; скорость пружины несериализуема принципиально — после резюма анимация дожимает к цели с нулевой начальной скоростью (перезапуск дуги, не бесшовный подхват). Это ограничение резумабельности, не дефект.
- Неконечный `target.value` бросит `LM045` внутри драйвер-таски (на клиенте); reduced-motion — снап через `snapTo`.

## Контракты

- **Zero runtime deps / optional peers.** Фреймворки — optional peerDependencies; ядро о них не знает, адаптер тянет только свой фреймворк. `./wc` не требует ничего, кроме платформы.
- **SSR-safe.** Ни один субпуть не трогает `window`/`document`/`customElements` на верхнем уровне без `typeof`-гарда: авторегистрация `./lit`/`./wc` в Node — тихий no-op; React использует layout-effect только при живом `document`; хуки директивы Vue на сервере не вызываются; Qwik исполняет физику только в `useVisibleTask$`. Отсутствие `matchMedia` (SSR/Node) читается как «reduced-motion выключен».
- **Reduced-motion — смена ХАРАКТЕРА, не hard-off.** При `prefers-reduced-motion: reduce` смена цели проходит через `MotionValue.snapTo`: значение синхронно достигает цели без пружинных кадров, старый полёт гасится, уже поставленный кадр инвалидируется. `snapTo` идемпотентен: в покое ровно на цели — no-op без эмиссии. Параметр `reducedMotionMode` числовой путь не меняет (`'instant'` и `'fade'` идентичны); `'fade'` — сигнал потребителю добавить короткий CSS-`transition`. Шов определения: `./lit` и `./wc` — инжектируемый `matchMedia`, `useReducedMotion` в React — инжектируемый параметр; остальные пути читают `window.matchMedia` под гардом.
- **Финитность (CSS-safe).** Наружу эмитятся только конечные значения (страж ядра). Все публичные числовые входы fail-fast: `LM045` синхронно, до Promise и до первого кадра. Единственное исключение — атрибутный путь `<lab-spring>`: враждебная строка атрибута игнорируется без броска (HTML-конвенция).
- **Детерминизм.** Единственный платформенный шов — `requestFrame`; инжектируется во всех адаптерах (у `./lit`/`./wc` — плюс `matchMedia`). Timestamp колбэка — миллисекунды; фоллбек без rAF — фиксированный шаг 1/60 с. Дефолтный клок — общий кадровый цикл `./frame` (один rAF на все значения).
- **Уборка.** Автоматическая по идиоме фреймворка (unmount/`onUnmounted`/`onCleanup`/`DestroyRef`/`hostDisconnected`/Qwik-cleanup); ручная — `SpringStore.destroy()` (Svelte, обязателен), `dispose`/`destroy` (Solid вне owner), `mv.destroy()` (Vue вне компонента). `MotionController.hostDisconnected` — `stop()`, не `destroy()`: reconnect возобновляет работу; `<lab-spring>` живёт с элементом до GC.
- **Ошибки.** Все броски — `MotionParamError` с полем `code`: `LM045` (неконечное значение), `LM088`/`LM089`/`LM090` (физика пружины), `LM091` (время оседания превышает бюджет frame-loop). Каталог с лечением — [docs/errors.md](../errors.md). Angular добавляет свой `NG0203` вне injection context; `useReducedMotion` и `renderTemplateValue` не бросают.

## Примеры

### React — effect-binding без ре-рендеров

<!-- пример использует peer-зависимость react -->
```tsx
import { useMotionStyle, useReducedMotion } from '@labpics/motion/react';

export function Panel({ open }: { open: boolean }) {
  const reduced = useReducedMotion(); // реактивно; на сервере всегда false
  const ref = useMotionStyle({
    target: open ? 240 : 0,
    property: 'transform',
    template: 'translateX({v}px)',
    from: 0,
    spring: { mass: 1, stiffness: 300, damping: 30 },
  });
  // ни одного ре-рендера на кадр: хук пишет в style напрямую;
  // reduced === true → смена target снапает мгновенно (CHARACTER-switch)
  return <div ref={ref} data-reduced={reduced} />;
}
```

### Vue — композабл и директива v-motion

```ts
import { createApp, defineComponent, h, ref, withDirectives } from 'vue';
import { useSpring, vMotion, type MotionDirectiveValue } from '@labpics/motion/vue';

const Panel = defineComponent({
  setup() {
    const open = ref(false);
    // render value: readonly-ref, кадр за кадром
    const x = useSpring(() => (open.value ? 240 : 0), { mass: 1, stiffness: 300, damping: 30 });
    // effect binding: директива пишет в style сама, без ре-рендера на кадр
    const fadeIn: MotionDirectiveValue = { target: 1, property: 'opacity', from: 0 };
    return () =>
      withDirectives(
        h('div', {
          style: { transform: `translateX(${x.value}px)` },
          onClick: () => { open.value = !open.value; },
        }),
        [[vMotion, fadeIn]],
      );
  },
});

const app = createApp(Panel);
app.directive('motion', vMotion); // глобальная регистрация для шаблонов: v-motion
app.mount(document.querySelector('#app') as HTMLElement);
```

### Без виртуального DOM — Svelte-store и `<lab-spring>`

`springStore` — обычный store-контракт, работает и вне Svelte:

```ts
import { springStore } from '@labpics/motion/svelte';

const box = document.querySelector('.box') as HTMLElement;
const x = springStore(0, { mass: 1, stiffness: 200, damping: 20 });

const unsubscribe = x.subscribe((v) => {
  box.style.transform = `translateX(${v}px)`; // subscribe эмитит текущее значение сразу
});

x.set(240); // пружина; при prefers-reduced-motion — синхронный снап

// по завершении: unsubscribe(); x.destroy();
export { unsubscribe };
```

В Svelte-компоненте — `$x`-автоподписка и обязательный `destroy`:

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { springStore } from '@labpics/motion/svelte';

  const x = springStore(0, { mass: 1, stiffness: 200, damping: 20 });
  onDestroy(() => x.destroy());
</script>

<div style="transform: translateX({$x}px)">…</div>
<button on:click={() => x.set(240)}>Go</button>
```

`<lab-spring>` — тот же контракт без единой зависимости:

```ts
import '@labpics/motion/wc'; // сайд-эффект: регистрирует <lab-spring>; в SSR — no-op
import type { LabSpringHost } from '@labpics/motion/wc';

const el = document.createElement('lab-spring') as HTMLElement & LabSpringHost;
el.spring = { mass: 1, stiffness: 300, damping: 30 }; // JS-only: до вставки в DOM
el.setAttribute('property', 'transform');
el.setAttribute('template', 'translateX({v}px)');
document.body.appendChild(el); // первый connectedCallback создаёт MotionValue

el.setAttribute('target', '240');  // старт пружины
el.setAttribute('target', 'oops'); // враждебная строка атрибута: игнор, без броска
```
