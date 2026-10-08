# Компилятор анимаций

`motionCompiler()` вычисляет статические кривые при сборке Vite. В браузер
попадают готовые данные и компактные исполнители. Динамические анимации
продолжают использовать обычный runtime.

## Подключение

Добавьте плагин один раз в конфигурацию проекта:

```typescript
import { defineConfig } from 'vite';
import { motionCompiler } from '@labpics/motion/compiler/vite';

export default defineConfig({ plugins: [motionCompiler()] });
```

Плагин работает после преобразования TypeScript и JSX. Дополнительная
конфигурация для файлов TS/TSX не требуется. Код анимаций использует прежние
публичные импорты; приватные исполнители подключает компилятор.

## Статическая прозрачность

Поддерживается `animate(target, { opacity: N })` из `@labpics/motion/nano`,
где `N` — конечный числовой литерал, а третий аргумент отсутствует.

<!-- compiler-nano-recipe -->
```typescript
import { animate } from '@labpics/motion/nano';
export function play(el) { return animate(el, { opacity: 0.5 }); }
```

Переименование импорта через `as` сохраняет оптимизацию.

## Ширина поверхности и совместные импорты

Для `@labpics/motion/animate` поддерживается статическая пара положительных
значений `width` с `layout: 'project'`. Аргумент цели должен быть простым
идентификатором. Результат вызова не должен использоваться: присваивание,
`return`, `await` и доступ к контролам сохраняют обычный runtime.

<!-- compiler-project-recipe -->
```typescript
import { animate as resize } from '@labpics/motion/animate';
import { animate as fade } from '@labpics/motion/nano';

export function reveal(panel: HTMLElement | HTMLElement[], label: HTMLElement) {
  resize(panel, { width: [240, 360] }, { layout: 'project' });
  fade(label, { opacity: 1 });
}
```

Оба импорта специализируются независимо, даже когда находятся в одном файле.
Статический объект `spring` может задавать `mass`, `stiffness` и `damping`.
Ненулевая начальная скорость, `onFrame`, `inputPolicy`, `scrollAnchor`,
неизвестные опции и динамические значения оставляют вызов в runtime.

Для отдельного DOM-элемента переход использует доступный механизм View
Transitions. Список элементов сохраняет семантику обычного width-перехода.
При уменьшенном движении или отсутствии необходимых возможностей выполняется
предусмотренный соответствующим runtime-путём переход или мгновенный финал.

## Когда сохраняется runtime

Компилятор проверяет конкретный импорт и область его имени. Затенённое имя,
namespace-импорт, переназначенная через переменную ссылка и optional-call
не преобразуются. Переименование самого прямого импорта разрешено.

Например, этот вызов остаётся динамическим и сохраняет все контролы:

```typescript
import { animate as resize } from '@labpics/motion/animate';

export function resizeTo(panel: HTMLElement, width: number) {
  return resize(panel, { width: [240, width] }, { layout: 'project' });
}
```

Недопустимая для специализации форма сохраняется без изменений. Ошибка
построения уже принятого артефакта останавливает сборку. Ошибка разбора модуля
с целевым импортом выводится предупреждением Vite; она не теряется молча.

## Отладка

Source map сохраняет позиции исходного модуля, включая многострочные вызовы.
Добавленные импорты исполнителей не отображаются как пользовательский код.

Проверить собранный граф в репозитории библиотеки:

```sh
pnpm acceptance:compiler --trace
```

Записи `tooling-trace` содержат `schemaVersion: 1`, `id`, `goal`, `owner`,
`path`, `execution` и `refusal`: `null` для compiled-пути, причина для runtime.
Они выводятся после успешной проверки и не входят в браузерную сборку.
[Подробности диагностики](recipes.md#диагностика-compiler-lowering).
