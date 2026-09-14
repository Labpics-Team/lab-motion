# Контракт композиции движения v1

> Роль: reference. Версия семантики: `motion-composition/1`.
> Этот документ не вводит новый runtime API, store, clock, IR или универсальный
> контроллер. Он связывает существующих владельцев и фиксирует границы, которые
> потребитель не должен выводить из похожей формы данных или визуального результата.

## Статусы

- **`current`**: поведение уже принадлежит публичному владельцу пакета и имеет
  исполнимый witness.
- **`current-gap`**: требование уже обязательно для принятого journey, но текущий
  публичный владелец не выражает или не доказывает его полностью. Такой gap нельзя
  выдавать за существующую гарантию.
- **`planned`**: контракт обязателен для следующего владельца/узла, но ещё не является
  обещанием текущего API.

Алгоритмический SSOT остаётся в owner-документах: [bindings](bindings.md),
[behaviors](behaviors.md), [presence](presence.md), [projection](projection.md),
[smart](smart.md), [compositor](compositor.md) и [future layout](future-layout.md).
Этот файл определяет только законы **между** ними.

## 1. Три разных входных смысла

Одинаковая JavaScript-форма не делает входы эквивалентными.

| Смысл | Владелец и статус | Закон | Допустимый witness | Правдоподобная ошибка |
|---|---|---|---|---|
| **State** | `./bindings`, `createStateCascade`; `current` | Состояние идемпотентно по принятой визуальной цели. Новая модель с тем же полным target не означает новое событие и не перезапускает renderer. | Две разные модели проецируются в один target, порт вызывается один раз. | Кодировать повторный shake/replay/submit повтором прежнего target и ждать второго запуска. |
| **Event** | `./gestures` и доменный consumer; `current` | Событие является occurrence. После завершения предыдущего occurrence такое же событие может честно повториться при том же конечном state. | Два законченных press-цикла дают два `onPress`, хотя recognizer между ними снова `idle`. | Дедуплицировать событие по равенству конечного state или маршрутизировать его через state-binding. |
| **Geometry** | `./projection`, `./smart`, `./behaviors/reorder`; `current` | Геометрия является snapshot с собственной lifetime. Успешная новая capture/update инвалидирует решения, выведенные из предыдущего snapshot, даже если численные поля случайно совпали. | Proposal reorder current до `update`, stale сразу после успешного `update`. | Кэшировать proposal/projection по deep-equal rects и применять его после recapture. |

Следствие: state можно дедуплицировать, event нельзя дедуплицировать как state,
geometry нельзя считать вечным state. Эти три правила не требуют общего wrapper API.

## 2. Whole-role и владение физической поверхностью

`createMotionBinding` публикует изменившуюся **роль целиком**, а не отдельный изменённый
scalar. Связанные transform-оси и другие каналы одной физической поверхности имеют одного
renderer-owner. Если меняется `x`, но продолжается движение `y`, новый target роли всё равно
содержит и `x`, и `y`.

- `current`: whole-role уже является контрактом `./bindings`.
- Допустимо: `{ transform: { x, y } }` принадлежит одному порту.
- Недопустимое представление: независимый `x`-owner заменяет/отменяет effect, которым ещё
  владеет `y`-owner той же transform-поверхности.
- Это не запрет независимых DOM-свойств. Граница определяется физической поверхностью и
  collision semantics, а не совпадением имени объекта.

## 3. Четыре разные lifetime shared transition

Shared transition не имеет одной универсальной «жизни элемента».

| Lifetime | Смысл | Владелец | Статус |
|---|---|---|---|
| **identity lifetime** | Логическая сущность, по которой связываются представления. Может пережить пересоздание DOM-узла. | Приложение задаёт key; `./smart` сопоставляет его. | `current` |
| **app membership** | Находится ли сущность/представление в текущей модели приложения и семантическом дереве. | Приложение / presence intent. | `current` |
| **visual lifetime** | Сколько старый/новый pixels-representation остаётся видимым ради перехода. Может пережить app membership. | `./smart`, `./presence`, Future Layout snapshots. | `current` |
| **focus lifetime** | Когда интерактивное представление вправе получать/удерживать keyboard focus и a11y interaction. Не выводится из identity или visual lifetime. | Приложение/a11y owner; visual motion не получает это право автоматически. | `current-gap` для smart ghost composition |

### Обязательный закон focus lifetime

Продление visual lifetime не продлевает focus lifetime автоматически. Ghost/snapshot может
существовать после изменения app membership, но его DOM-присутствие само по себе не является
разрешением вернуть или принять focus. Конкретная граница передачи focus принадлежит journey
(например, trigger ↔ dialog) и должна быть явной в consumer/a11y contract.

Текущий `./smart` документирует реинсерт реального exit-узла как visual ghost, но не объявляет
focus/inert/ARIA ownership. Поэтому `motion-composition/1` **не заявляет**, что smart уже
обеспечивает focus isolation. До отдельного conformance proof это `current-gap`.
Фальсификатор: узел, вышедший из app membership, становится keyboard-reachable только потому,
что motion reinserted его как visual ghost.

## 4. Live, snapshot и serialized являются разными representation

| Representation | Контракт | Статус |
|---|---|---|
| **live** | Текущее состояние исполнения, которое может принимать новые intent и хранит необходимые position/velocity/lifecycle данные. Follow-фаза живёт здесь. | `current` |
| **snapshot** | Снимок на конкретной boundary. Он может быть immutable data target, DOM capture или borrowed observer view. Snapshot не становится live-подпиской и не владеет будущим app state. | `current` |
| **serialized** | Исполнимый/сертифицированный артефакт автономной части. Зависимые каналы должны выводиться из того же артефакта, а не из заново посчитанной «похожей» кривой. | `current` для compositor/Future Layout/compiler |

Для Future Layout `P` является serialized source; `Q` и `A` выводятся из того же `P`.
Для compositor scalar snapshot читается из исполняемого артефакта и передаётся live-owner при
`handoffToLive`. Разные representation могут реализовывать один intent, но не должны создавать
двух одновременных владельцев одной физической поверхности.

## 5. Handoff и непрерывность

### Scalar

`current`: compositor → live handoff сохраняет value и velocity в effect-space в объявленной
области. `test/compositor-handoff.test.ts` пинит C⁰/C¹ join. Это не обещание rendered-pixel C¹
при clamping, non-affine formatting, меняющемся underlying/composite или authored jump.

### Vector

`planned`: для поддерживаемого 2D domain компоненты одного физического вектора имеют один clock,
но независимые коэффициенты/state. Базовая форма
`x_i(t)=x_i0+Δ_i P(t)+v_i0 Q(t)` не разрешает синтезировать отсутствующую компоненту скорости.

Допустимый witness: чисто горизонтальный retarget не получает новую вертикальную velocity.
Правдоподобная ошибка: перенос одного scalar `v0` на обе transform-оси или заявление C¹ для
произвольного authored discontinuity/nonlinear CSS geometry. Такой случай должен быть ограничен
областью или отказан, а не «исправлен» выдуманной скоростью.

## 6. Семантика control-глаголов

Это словарь исходов, а не требование добавить одинаковые методы каждому контроллеру.

| Глагол | Закрытое значение | Что он НЕ означает | Примеры текущих owners |
|---|---|---|---|
| **cancel** | Терминализировать принадлежащее owner исполнение и освободить его ресурсы согласно owner contract. | Не означает вернуть app state/DOM к прошлому состоянию. | `animate.cancel/stop`, `smart.cancel`, presence cleanup, Future Layout cancel. |
| **finish** | Довести текущий visual operation до объявленного terminal representation, если конкретный owner поддерживает такую политику. | Не создаёт новое app membership и не является универсальным методом API. | natural `finished`; Future Layout `inputPolicy:'finish'`. |
| **revert** | Новое application intent, восстанавливающее прежнее app state/representation. | Не синоним `cancel`; motion не имеет права выдумать старую authoritative модель. | Обычно выполняется приложением как новый state/geometry commit и затем может быть анимирован successor-операцией. |

Проверяемый current-контрпример против `cancel === revert`: Future Layout после `cancel()` сохраняет
уже committed конечный DOM (`test/future-layout-api.test.ts` и
`test/future-layout-runtime-policy.test.ts`). `createPresenceTransition.destroy()` также не
восстанавливает стили и не удаляет DOM.

## 7. Ошибки, reentry и порядок эффектов

Общие законы не отменяют более строгие owner-контракты:

1. Там, где операция обещает all-input admission, валидация полного входа завершается до первого
   нового эффекта. Ошибка не должна оставлять half-applied target.
2. При smooth pickup successor создаётся до отмены predecessor, если именно этот порядок нужен для
   чтения текущего положения/скорости. Binding и presence уже пинят этот закон.
3. Терминальный state устанавливается до cleanup, если cleanup может бросить. Cleanup error не
   должен «воскресить» owner.
4. Независимые cleanup попытки выполняются все; несколько ошибок сохраняются в `AggregateError`,
   исходная user error не теряется.
5. Reentrant update/callback не может вклинить половину более нового target в текущую доставку.
   Owner с очередью обязан фиксировать её порядок (bindings/state cascade используют FIFO).
6. Silent rollback/fallback запрещён. Если rollback невозможен, наружу остаётся фактически
   совершённый side effect и явная ошибка/terminal state.

## 8. Шесть journeys r11

Таблица фиксирует outcome и representation, а не предписывает новый фасад.

| Journey | Outcome / owner chain | Допустимое representation | Правдоподобное неверное representation | Статус контракта |
|---|---|---|---|---|
| **Карточка ↔ детали** | App state выбирает сущность; stable key связывает представления; projection/smart ведёт geometry; binding/presence ведут локальные visual роли. | Новый app DOM/model может быть уже committed, пока старый pixels-representation живёт как snapshot/ghost; identity переживает пересоздание узла; focus boundary задаётся consumer. | Считать DOM object identity сущностью; держать старое представление app-member только потому, что оно ещё видно; позволить ghost получить focus «по факту DOM». | `current` + focus `current-gap` |
| **Диалог/панель ↔ источник** | App владеет desired presence; `createPresenceTransition` владеет visual enter/exit controls; trigger/dialog a11y owner владеет focus transfer. | Повтор того же presence state идемпотентен; встречный intent создаёт successor до cleanup старого visual owner; `onGone` является terminal visual boundary, не app-state rollback. | Кодировать повторный submit/Escape как повтор state target; считать `destroy/cancel` удалением DOM или возвратом focus. | `current` + focus boundary consumer-owned |
| **Фильтруемый/переставляемый список** | App владеет order/membership; `createReorder` предлагает intent; app commit + `update` создают новый geometry snapshot; projection догоняет layout. | Delayed proposal проверяется через `isCurrent`; успешный `update` отзывает proposal предыдущего snapshot. | `onReorder` сам мутирует скрытый второй store; stale proposal применяется после filter/resize/update. | `current` |
| **Сетка карточек** | Те же app-owned order/identity, но 2D geometry; связанная transform-поверхность остаётся одним role/owner. | `axis:'both'` использует свежий snapshot; x/y одного transform target доставляются whole-role. | Независимые x/y owners отменяют effects друг друга; direction решается по старой геометрии после reflow/filter. | `current` для resolver/whole-role; full consumer остаётся downstream JOURNEY |
| **Sheet** | Pointer follow остаётся live; release/settle использует один physical owner и сохраняет velocity; новый input перехватывает текущий owner. | Follow не cancel+re-emit native effect каждый frame; переход к автономной representation происходит на дискретной boundary с value+velocity handoff. | Сбросить velocity на release; держать live и serialized owners одной поверхности одновременно; compositor-retarget каждый pointer frame. | current single-runner foundation; serialized release composition `planned` |
| **Pager/drag surface** | App page/selection state отдельно от повторяемых input events; geometry/constraints имеют snapshot lifetime; direct control сохраняет непрерывность при interrupt. | Новый drag является новым event/intention и может перехватить settle; page state не подменяет occurrence; bounds/geometry перечитываются на своей boundary. | Дедуплицировать второй drag по прежнему page state; stale terminal effect после нового input; использовать старые bounds после resize. | current behavior foundation; full serialized/vector handoff `planned` |

## 9. Output-error

Погрешность объявляется в единицах наблюдаемого output конкретного owner, а не как удобная
внутренняя дельта алгоритма:

- compositor scalar: effect-space value/slope в объявленной affine области;
- Future Layout: CSS-pixel surface budget из `SURFACE_PRECISION_BUDGET_PX`;
- projection: box/velocity domain и его объявленные C¹-ограничения;
- будущий vector-domain: per-component output + отображение в parent-space, отдельно от
  невозможных authored jumps/nonlinear CSS cases.

Oracle/receipt не считается независимым, если он импортирует тот же production evaluator для
обеих сторон сравнения. Недоказуемая область даёт ограничение/отказ, не расширенное обещание.

## 10. Исполнимые witnesses

Новый `test/motion-contract-v1.test.ts` закрывает три cross-owner ошибки, которые раньше были
разнесены по разным модулям:

1. state idempotence против event repetition;
2. geometry snapshot invalidation;
3. whole-role delivery связанных transform-компонент.

Остальные current-законы не копируются и остаются у своих более сильных tests:

- bindings snapshot/reentry/error: `test/semantic-motion-binding*.test.ts`;
- presence ownership/terminal cleanup: `test/presence-transition*.test.ts`;
- smart identity/ghost/continuity: `test/smart-lifecycle.test.ts`;
- scalar serialized→live C⁰/C¹: `test/compositor-handoff.test.ts`;
- cancel не revert committed DOM: `test/future-layout-api.test.ts`,
  `test/future-layout-runtime-policy.test.ts`;
- projection continuity/geometry: `test/projection-*.test.ts`;
- reorder stale proposal: `test/reorder*.test.ts`.

Planned/current-gap строки выше остаются falsifiable requirements для downstream nodes. Их нельзя
помечать `current` только потому, что соседний механизм похож визуально.
