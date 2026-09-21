# Компилятор (build-time lowering)

> Роль: контракт `./compiler/vite` и `./compiler/runtime` — вынос статических
> анимаций из бандла на этап сборки. Скоуп и пайплайн реализованы в
> `src/compiler/core.ts`; расхождение доки с кодом — дефект.

Идея: если вызов анимации статичен, его кривую можно вычислить на этапе
сборки. Плагин заменяет такой вызов готовым артефактом — в бандл потребителя
не попадают ни spring-солвер, ни парсер, только крошечный исполнитель
(`./compiler/runtime`, единственный браузерный compiler-артефакт).

```typescript
// vite.config.ts
import { motionCompiler } from '@labpics/motion/compiler/vite';

export default { plugins: [motionCompiler()] };
```

## Скоуп первого среза

Ровно один класс вызовов: статический `animate(target, { opacity: N })` из
direct named import `@labpics/motion/nano` без опций. Всё остальное —
консервативный отказ: source остаётся семантически исходным и работает через
обычный runtime-путь. Непредставимая программа или расхождение проекции —
**ошибка сборки, не silent fallback**.

Буквальный runnable-рецепт ниже является входом и для compiler-acceptance, и
для browser-differential. Отдельных копий fixture у этих проверок нет.

<!-- compiler-nano-recipe -->
```typescript
import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }
```

## Playground

Browser-playground не пересобирает и не копирует рецепт: `browser/fixtures/compiler-playground.html`
импортирует `browser/.artifacts/compiled.js`, а этот артефакт создаёт существующий
`browser/fixtures/compile-artifacts.mjs` из буквального блока выше через
`readCompilerNanoRecipe`. Поэтому playground, browser-differential и acceptance имеют один вход,
а showcase и публикуемый пакет не получают второй compiler/tooling runtime.

## Как строится доверенный артефакт

Пайплайн: nano SSOT (`springLinear`) → кандидат MotionProgram V1 →
`parseMotionProgramV1` (единственный оракул доверия) → проекция обратно в
`{ frame, durationMs, cssLinear }` с обязательным bit-exact сверением с
исходным nano-артефактом. Ядро компилятора parse-независимо: адаптер передаёт
ESTree-совместимый Program (Vite/Rollup — штатный `this.parse`, acorn) и
применяет возвращённые байтовые правки сам.

Sourcemap — точная карта версии 3: сохранённые байты исходника идут
сегмент-в-сегмент (включая многострочные вызовы, чьи правки схлопывают
строки), замена целиком отображается в начало своей правки, дописанный
hoisted-импорт исполнителя не отображается (это не пользовательский код);
`sources` несёт id модуля — композиция карт последующих трансформов не теряет
маппинги.

## Диагностический trace-контракт

Repository tooling может вывести машинно-читаемые строки `tooling-trace`. Каждая
запись имеет `schemaVersion: 1`, `id`, `goal`, `owner`, `path`, `execution` и,
для оставленного runtime-пути, `refusal`. Изменение состава или семантики полей
требует увеличения `schemaVersion`; неизвестную версию потребитель обязан
отклонять, а не угадывать. Trace описывает фактически собранный граф и печатается
только после успешной compiler-acceptance проверки; в package/runtime он не входит.

Практический запуск описан в [рецептах](recipes.md#диагностика-compiler-lowering).

## Гарантии

- **Приёмочная проверка CI** (`pnpm acceptance:compiler`): реальный Vite-build
  буквального рецепта выше с плагином и без доказывает элиминацию
  солвера/парсера из бандла потребителя и строго меньший вес артефакта.
- **Browser-differential**: тот же буквальный compiled-вызов сверяется с
  не-compiled в трёх движках (Chromium/Firefox/WebKit, `browser/*.spec.ts`).
- **Размерные потолки**: `./compiler/runtime` — exact-ратчет (рост только
  решением); `./compiler/vite` несёт parser+SSOT осознанно — это цена
  доверенного артефакта на стороне СБОРКИ, браузеру она не поставляется
  никогда. Актуальные числа — `pnpm size`.
