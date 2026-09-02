/**
 * animate/surface-router.ts — точечный seam между фасадом и Surface-роутером.
 *
 * ЗАЧЕМ: базовый фасад не тащит полный граф Future Layout (transaction/
 * artifact/coordinator/observer ~58 KB source). Регистрация маршрутизатора —
 * явное действие потребителя через side-effect субпуть `./animate/layout`;
 * type-only ссылка на контракт роутера не создаёт runtime-рёбер, а отсутствие
 * регистрации при layout:'project' — типизированная отказная граница (LM173),
 * не silent fallback на незапрошенный движок.
 */

import { MotionParamError } from '../errors.js';
import type {
  SurfaceRouteControls,
  tryRouteSurfaceTransition,
} from '../future-layout/route.js';

type SurfaceRouterFn = typeof tryRouteSurfaceTransition;

let router: SurfaceRouterFn | undefined;

/** Регистрация реального маршрутизатора из субпутя ./animate/layout. */
export function installSurfaceRouter(fn: SurfaceRouterFn): void {
  router = fn;
}

/**
 * Чтение внутреннего состояния: минификатор не может выбросить установщик,
 * пока остаётся наблюдаемый потребитель регистрации.
 */
export function hasSurfaceRouter(): boolean {
  return router !== undefined;
}

/**
 * Делегирует явный layout:'project' зарегистрированному роутеру. Без роутера —
 * типизированный LM173: поведение не молчит и не подменяется прямым tween.
 */
export function routeSurface(
  target: unknown,
  props: Record<string, unknown>,
  options: unknown,
): SurfaceRouteControls | undefined {
  if (
    options === null ||
    typeof options !== 'object' ||
    (options as { layout?: unknown }).layout !== 'project'
  ) {
    return undefined;
  }
  if (router === undefined) throw new MotionParamError('LM173');
  return router(target, props, options as never);
}
