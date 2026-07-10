/**
 * projection/index.ts — вложенный FLIP-движок (subpath ./projection).
 *
 * Subpath export: import { createDomProjection } from '@labpics/motion/projection'
 *
 * ЗАЧЕМ: честный вложенный FLIP жанра Framer projection — headless-ядро (чистая
 * математика дерева боксов, ноль DOM) + headless-драйвер (ОДНА нормированная
 * пружина с живым v0) + тонкий DOM-адаптер. Transform родителя НЕ искажает детей
 * и border-radius (замкнутая форма scale-correction через visual box ближайшего
 * проецирующего предка); velocity continuity при прерывании/переизмерении —
 * ровно два гэпа, которые ./flip закрыть не может (плоская модель, v0 жёстко 0).
 *
 * Карта переиспользования (ядро не тронуто ни байтом):
 *   src/internal/solver.ts:15 solveSpring(params, t, v0) — единственный солвер
 *     драйвера (произвольный v0 = ядро continuity; springUnchecked НЕ используется —
 *     у него v0 жёстко 0, src/spring.ts:141-150, корень гэпа flip);
 *   src/spring.ts:88 validateSpringParams — ранний MotionParamError в фабрике;
 *   src/flip/index.ts:133 correctRadius и :145 counterScale — ЖИВЫЕ вызовы в
 *     geometry (пин ./flip — ровно 5 экспортов — не тронут); computeFlip/flipAt —
 *     differential-оракулы root-пути в тестах; FlipRect — type re-export
 *     (прецедент src/auto/index.ts:35).
 *   Паттерны-копии (НЕ импорты — импорт утянул бы чужой граф в копию субпутя при
 *   splitting:false): finite/finiteDiv/clamp01 (приватны в flip, ~12 строк);
 *   dominantV0 (waapi-unit.ts:309-318) и normalizeV0/RANGE_EPSILON
 *   (channels.ts:174-182); generation-инвалидация / handle=0 / FIXED_DT / REST /
 *   MAX_FRAMES / синхронный первый кадр / финал ровно identity (flip :217-293);
 *   prefersReducedMotion (flip :192-199); «состояние снимается замкнутой формой,
 *   не из DOM» (compositor/index.ts:369).
 *   Сознательно НЕ используется: ./frame (инверсия зависимости, канон
 *   internal/binding-value.ts:10-13 — порядок родитель-раньше-ребёнка даёт
 *   собственный топосорт внутри ОДНОЙ requestFrame-заявки; потребителю в доках —
 *   asRequestFrame(frame)); buildTransform из src/value/transform.ts (подразумевает
 *   origin 50% и схлопывает scale-каналы — projection пишет строку сам под жёсткий
 *   контракт origin '0 0').
 *
 * Математика (вывод — индукция по глубине, geometry.ts): узел несёт first F,
 * last L и anchor B (где ФАКТИЧЕСКИ стоит в layout; default B = L, у
 * кроссфейд-ghost'а B = F). Целевой инвариант: V_i(p) = mix(F_i, L_i, p)
 * покомпонентно, размеры флорятся ≥ 0. Кумулятивная карта «layout над узлом →
 * page» равна box-map ближайшего проецирующего предка A:
 *   Φ_A(q) = V_A.pos + k_A ⊙ (q − B_A.pos),  k_A = V_A.size ⊘ B_A.size (ЛОКАЛЕН)
 *   s_c = (V_c.size ⊘ B_c.size) ⊘ k_A
 *   t_c = (V_c.pos − V_A.pos) ⊘ k_A − (B_c.pos − B_A.pos)
 *   k_c = V_c.size ⊘ B_c.size — индукция замкнулась: цепочка любой глубины
 *   схлопывается, для внуков нужен ТОЛЬКО ближайший проецирующий предок.
 * Частные случаи-тождества: корень ≡ flipAt(computeFlip(F, L), p); статичный
 * ребёнок s = 1 ⊘ k_A ≡ counterScale(k_A) — хелперы flip есть вырожденные
 * случаи формул.
 *
 * Инварианты субпутя:
 *   P1. CSS-safe: каждое число каждого кадра конечно; −0 схлопнут (finite(...)+0).
 *   P2. Zero-DOM в geometry/driver; DOM только в dom.ts, в момент вызова.
 *   P3. Детерминизм: время из ts кадра либо FIXED_DT = 1/60; бит-в-бит
 *       воспроизводимость; Math.random не существует для субпутя.
 *   P4. Reduced-motion = character-switch: снап identity без кадров (паритет F4 flip).
 *   P5. C⁰ всегда и C¹ по формулам driver.ts при прерывании; transform-origin
 *       потребителя — '0 0' (формулы выведены для верхнего-левого origin).
 *
 * Clamp-дефолт: clamp: FALSE — честный overshoot (value-add: scale-correction +
 * floor размеров делают его безопасным). Осознанное отличие от легаси-дефолта
 * ./flip (true) — пин-тест дефолта + строка README.
 *
 * Не-цели v1 (честно): rotate/skew и не-'0 0' origin (модель строго осевая —
 * диагонально-аффинные карты; повёрнутый предок ломает замкнутую форму, наследуем
 * F5 flip); position: fixed/sticky в дереве (page-space модель для них неверна);
 * компенсация скролла вложенных scroll-контейнеров (только window-scroll);
 * пер-узловые/пер-канальные пружины, stagger (математика к расширению готова);
 * WAAPI/compositor-эмиссия дерева (пер-кадровая коррекция 1/k(t) нелинейна);
 * live-ре-резолюция %/calc() радиусов в полёте; автодетект мутаций
 * (MutationObserver); live-подписка на смену prefers-reduced-motion в полёте;
 * z-index/stacking; жестовые распознаватели (только seek/release-швы — трекер
 * скорости у потребителя, ./gestures).
 */

export {
  cornerRadiusAt,
  createProjector,
  mixBox,
  projectAt,
  type BoxRadii,
  type CornerRadius,
  type ProjectedTransform,
  type ProjectionBoxes,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
} from './geometry.js';
export {
  createProjection,
  type ProjectionControls,
  type ProjectionOptions,
  type ProjectionPlayNode,
} from './driver.js';
export {
  createDomProjection,
  type DomProjectionControls,
  type DomProjectionElement,
  type DomProjectionOptions,
} from './dom.js';
/** Type re-export — стирается в рантайме (прецедент src/auto/index.ts:35). */
export type { FlipRect } from '../flip/index.js';
