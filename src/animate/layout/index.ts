/**
 * animate/layout.ts — side-effect субпуть `import '@labpics/motion/animate/layout'`.
 *
 * Единственное назначение: регистрация Surface-роутера (Future Layout) в фасаде
 * ./animate. Импорт opt-in: модуль отмечен в package.json sideEffects и не
 * вытряхивается; сам фасад при этом остаётся строго tree-shakeable — без этого
 * импорта граф transaction/artifact/coordinator/observer не попадает ни в один
 * consumer-бандл, даже если ./animate поставляется тем же пакетом.
 */

import { tryRouteSurfaceTransition } from '../../future-layout/route.js';
import { hasSurfaceRouter, installSurfaceRouter } from '../surface-router.js';

installSurfaceRouter(tryRouteSurfaceTransition);

/**
 * Маркер инициализации: экспортируемая честная зависимость от присваивания
 * запирает регистрацию в module-графе (без неё минификатор, не видя потребителя
 * внутреннего состояния, стирает чистый side-effect модуль целиком).
 * Тесты и consumers могут использовать его как подтверждение, что Surface-
 * роутер установлен.
 */
export const surfaceLayoutRouter: boolean = hasSurfaceRouter();
