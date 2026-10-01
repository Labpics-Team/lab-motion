/**
 * Групповой compositor-фасад. Одиночный контроллер и план переэкспортируются
 * здесь, чтобы один consumer-entry владел всей связанной capability без второй
 * предсобранной копии ядра в приложении.
 */

export {
  compileSpringPlan,
  CompositorSpring,
  type CompositorPlan,
  type CompositorPlanOptions,
  type CompositorSpringOptions,
  type SetTimerFn,
} from '../core.js';
export {
  compileStaggerPlan,
  CompositorStaggerGroup,
  type CompositorStaggerOptions,
  type CompositorStaggerPlan,
  type CompositorStaggerGroupOptions,
} from '../stagger.js';
