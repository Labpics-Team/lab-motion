# Smart-путь

> Роль: контракт `./smart` — Figma-подобный smart-animate поверх
> [projection](projection.md): диф двух снимков дерева по строковому ключу.

Projection требует собрать набор элементов вручную и знать «что во что
превратилось»; smart закрывает ровно это: ДВА снимка дерева по строковому
identity-ключу (`data-motion-key`), диф → `matched` / `entered` / `exited` /
`skipped`, оркестрация поверх ОДНОГО projection-движка.

```typescript
import { smartTransition } from '@labpics/motion/smart';

// пометьте узлы: <div data-motion-key="card-3">…</div>
const handle = smartTransition(container, () => {
  reorderAndSwapLayout(); // мутируйте DOM как угодно (sync или async)
});
await handle.finished;
```

Либо разнесённо: `const cap = captureSmart(container); mutate(); cap.animate()`.

## Ключевые свойства (все запинены тестами)

- **Диф по строке-ключу**: перемещённый ключ → `matched` (едет FLIP'ом),
  новый → `entered` (fade-in без transform), ушедший из DOM → `exited`
  (ghost-протокол), уехавший в чужой контейнер или вырожденный → `skipped`.
  Дубликат ключа → ранний `MotionParamError`.
- **Continuity переживает ПЕРЕСОЗДАНИЕ узла**: id проекции = строка-ключ, а не
  ссылка на элемент. Повторный `captureSmart`/`animate` в полёте берёт
  аналитический `V(p̂)` (ноль чтений DOM под нашим transform) и пересеивает
  скорость — C¹ у драйвера `./projection`. Ре-рендер (тот же ключ, новый
  объект) не рвёт жест.
- **Единый clock**: matched-FLIP, enter- и exit-фейды едут одной нормированной
  пружиной — дерево движется как один жест.
- **Ghost-протокол exit**: узел реинсертится в root `absolute` на прежних
  page-координатах (padding-box), фейд 1→0, `removeChild` ДО резолва
  `finished` (терминальное действие раньше уведомлений). Реинкарнация ключа
  при живом ghost — ghost снимается, узел продолжает от его состояния без
  прыжка.
- **Reduced-motion = смена характера**: matched снапаются (ноль
  transform-записей), а enter/exit-фейды остаются ЖИВЫМИ; `tier` = `reduced`.
  `respectReducedMotion: false` игнорирует reduce. `resolveSmartTier` резолвит
  `reduced`/`projection`/`ssr`.
- **SSR-инертность**: на не-элементе `size` 0, `tier` `ssr`, `finished`
  резолвлен сразу — без чтения DOM на уровне модуля.
- **Деградации без NaN**: злые снапшоты (NaN/∞-ректы, битые радиусы,
  пересоздания, скролл, перехваты) — ни одного броска, ни одного нефинитного
  числа и ни одного `-0` в записях (фаззинг-тест ≥10 000 дифов в CI).

## Не-цели v1

Нативный View Transitions API (отдельная фаза; здесь projection-путь +
reduced + ssr), авто-детект мутаций (`MutationObserver`), live-подписка на
смену reduce в полёте; closed shadow roots и вложенные scroll-контейнеры
наследуются от `./projection`.
