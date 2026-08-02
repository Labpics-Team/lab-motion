# Motion-токены

> Роль: контракт `./tokens` — типобезопасный словарь примитивов движения.

Словарь `as const`, tree-shakeable по семействам. Это фундамент, а не вся
дизайн-система: семантики ролей («кнопка-ховер») здесь нет — роль→токен маппит
потребитель (labui). Физический словарь (длительности, изинги, ДС-пружины
`smooth`/`expressive`) зеркалирует SSOT motion-токенов `--lab-motion-*`
дизайн-системы [labui](https://github.com/Labpics-Team/labui) — при
пересечении имён значения совпадают байт-в-байт. Дефолты не кричащие (в духе Apple
spring-first / Fluent 2 / Material 3): критично-задемпфированные пружины и
мягкие изинги; overshoot — ровно в двух opt-in токенах (`easing.emphasized`,
`spring.expressive`/`bounce`). Значения запинены тестами как контракт.

```typescript
import {
  duration, easing, spring, staggerGap, distanceScale, springFromDurationBounce,
} from '@labpics/motion/tokens';

duration.base;          // 200 (мс): дефолтный UI-переход
easing.decelerate.css;  // 'cubic-bezier(0, 0, 0, 1)' — для CSS/WAAPI/compositor
easing.decelerate.fn;   // EasingFn — для ./keyframes / ./stagger
spring.default;         // { mass: 1, stiffness: 170, damping: 26 } — для ./compositor
spring.expressive;      // ДС-пружина (0.5s, bounce 0.3): сдержанный overshoot ~4.6%
staggerGap.normal;      // 40 (мс): шаг каскада для compileStaggerPlan({ gap })

// Каноническая пара восприятия (SwiftUI-модель, SSOT ДС): (duration, bounce) →
// физпараметры; выход гарантированно принимается всеми путями движка.
springFromDurationBounce(0.35, 0); // { mass: 1, stiffness: ~322.3, damping: ~35.9 }

// Дистанс-скейл: чем дальше путь, тем дольше движение (единообразная скорость).
distanceScale(200);     // 200 (мс) в дефолтной полосе 0→400px ↦ fast(100)→slow(300)
```

Гарантия размера — субпуть-изоляция (`sideEffects`-allowlist): не импортируете
`./tokens` — не платите ничего, ядро не растёт (проверено автоконтролем размера; полный
compositor-контракт пружин — [compositor.md](compositor.md)).
