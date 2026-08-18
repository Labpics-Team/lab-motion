# ADR-0002: Разделить физическую валидность spring и бюджеты исполнителей

**Дата:** 2026-08-15  
**Статус:** Принят  
**Связанные Issues:** #218, #230  
**ADR:** 0002

## Контекст

Прежняя архитектура `validateSpringParams()` смешивала два разных закона:

1. **Физическая валидность** — конечные `mass > 0`, `stiffness > 0`, `damping >= 0`
2. **Представимость кадровым исполнителем** — аналитическое время оседания ≤ `MAX_FRAMES × FIXED_DT_S ≈ 33.3 с`

Из-за этого:
- Чистый аналитический `spring(params, t)` отвергал медленные и незатухающие системы, хотя они математически валидны и вычисляются замкнутой формой
- Конструкторы `fromBounce()` и `fromVisualDuration()` скрыто мутировали параметры, чтобы пройти бюджет исполнителя
- Преобразования не были ни SwiftUI/Motion маппингом, ни физической валидацией, и не обратимы

### Математический закон

Канонические координаты формы движения:
```text
ω₀ = sqrt(k / m)
ζ  = c / (2 sqrt(km))
v₀ = initial velocity
```

Для `duration + bounce` (канон SwiftUI):
```text
ω₀ = 2π / duration
ζ  = 1 - bounce
k  = m ω₀²
c  = 2 m ζ ω₀
```

Это точное преобразование. Масштабирование `(m,k,c) → (λm,λk,λc)` не меняет ω₀, ζ и траекторию. Следовательно, `mass` в этой параметризации не является независимой perceptual-ручкой «тяжести».

## Решение

### 1. Два отдельных валидатора

```typescript
/**
 * Физическая валидность: ТОЛЬКО домен ОДУ.
 * Медленные (ω₀ → 0) и незатухающие (c = 0) системы физически валидны.
 */
export function validateSpringPhysics(p: SpringParams): void {
  if (!Number.isFinite(p.mass) || p.mass <= 0) throw new MotionParamError('LM088');
  if (!Number.isFinite(p.stiffness) || p.stiffness <= 0) throw new MotionParamError('LM089');
  if (!Number.isFinite(p.damping) || p.damping < 0) throw new MotionParamError('LM090');
}

/**
 * Валидатор ГРАНИЦЫ КАДРОВОГО ИСПОЛНИТЕЛЯ: физика + бюджет оседания.
 * Вызывается на границе исполнителя (drive/compositor/animate/...).
 */
export function validateSpringForFrameLoop(p: SpringParams): void {
  validateSpringPhysics(p);
  const tSettle = settleTimeAtRestUpperBound(p);
  if (!(tSettle <= SETTLE_BUDGET_S)) throw new MotionParamError('LM091');
}

// Semver-совместимость
export const validateSpringParams = validateSpringForFrameLoop;
```

### 2. Чистая аналитика в `spring()`

```typescript
export function spring(params: SpringParams, t: number): SpringResult {
  validateSpringPhysics(params);  // ТОЛЬКО физика
  return springUnchecked(params, t);
}
```

`spring()` теперь принимает ВСЕ физически валидные системы. Бюджетная проверка — забота кадровых исполнителей.

### 3. Исполнители вызывают `validateSpringForFrameLoop` явно

Все кадровые исполнители (`drive`, `driver`, `MotionValue`, `animate`, `compositor`, `behaviors`, `flip`, `gestures`, `projection`, `smart`, `tokens`, `future-layout`) вызывают `validateSpringForFrameLoop` явно вместо исторического `validateSpringParams`.

### 4. Точные обратные конструкторы

Все конструкторы — чистые биекции наблюдаемых координат в физические, БЕЗ тихой коэрсии:

- **`fromBounce({duration, bounce})`** — канон SwiftUI: `ω₀ = 2π/duration`, `ζ = 1 - bounce`. `bounce=1 → ζ=0 → damping=0` (незатухающая — математический факт).
- **`fromVisualDuration({visualDuration, bounce})`** — время ПЕРВОГО касания цели. Для ζ<1: `ω₀ = (π - atan(√(1-ζ²)/ζ)) / (√(1-ζ²)·Tv)`. Для ζ≥1: `ω₀ = ln(100) / (Tv · (ζ - √(ζ²-1)))`.
- **`springFromPeak({timeToPeak, overshoot})`** — точный обратный из пика: `L = -ln(overshoot)`, `ζ = L/√(π²+L²)`, `ω₀ = √(π²+L²)/t_peak`.
- **`springFromOscillation({period, halfLife})`** — точный обратный из колебаний: `ωd = 2π/period`, `α = ln2/halfLife`, `ω₀ = √(ωd²+α²)`, `ζ = α/ω₀`.

## Последствия

### Положительные

- **Точность**: конструкторы сохраняют запрошенные (Tv, bounce) точно, без подмены намерения
- **Обратимость**: `constructor(observables(params)) ≡ params` с точностью IEEE-754
- **Чистота домена**: `spring()` вычисляет любую физически валидную систему
- **Явность границ**: каждый исполнитель выбирает валидатор осознанно

### Отрицательные

- Пользователи `spring()` могут получить физически валидную, но неоседающую в бюджет пружину — но это их ответственность, если они не используют кадровый исполнитель
- Семантика `validateSpringParams` изменилась (теперь = `validateSpringForFrameLoop`), но это alias для совместимости

## Миграция

Код, использующий `spring()` для чистой аналитики без кадра, должен:
1. Продолжать использовать `spring()` как есть (физика валидируется)
2. Если нужен бюджет — вызывать `validateSpringForFrameLoop()` явно до `spring()`

Код, использующий исполнители (`drive`, `animate`, `MotionValue`), не требует изменений — они уже вызывают `validateSpringForFrameLoop`.

## Доказательства

- Тесты `spring-ergonomics.test.ts` проверяют ТОЧНОСТЬ преобразований (ζ = 1 - bounce без коэрсии)
- Тесты `spring-low-omega0-wall-clock.test.ts` проверяют: `spring()` принимает медленные/незатухающие, `drive()` отвергает
- Тесты `compositor-compile.test.ts` fuzz-тест пропускает физически невалидные И неоседающие в бюджет
- Все 3889 тестов проходят

## Ссылки

- Issue #218: [core] Разделить физическую валидность spring и бюджеты исполнителей
- Issue #230: feat(spring): точные observable constructors без semantic feel
- Commit: `refactor(spring): [#218] разделить физическую валидность и бюджеты исполнителей`
- Commit: `refactor(executors): [#218] явный validateSpringForFrameLoop на границах исполнителей`