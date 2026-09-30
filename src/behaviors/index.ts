import {
  createBottomSheet as createSheetController,
  createDragDismiss as createDismissController,
  createCarousel as createCarouselController,
  createPullToRefresh as createPullController,
} from './controllers.js';
import type { SheetOptions, SheetController, DismissOptions, DismissController, CarouselOptions, CarouselController, PullOptions, PullController } from './controllers.js';
import type { BehaviorRunnerFactory, BehaviorRunnerPort, BehaviorSettleArgs } from './runner-port.js';
import { solveSpring } from '../internal/solver.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../internal/constants.js';

export type * from './controllers.js';
export { createStateCascade } from './state-cascade.js';
export type { StateCascade, StateCascadeLayer, StateCascadePatch } from './state-cascade.js';

// ─── Единый runner (B1): один clock, доводка value→target пружиной ───────────

/**
 * Создать единый runner поведения. Владеет generation-токеном: любой новый
 * `_settle()` или `_invalidate()` инкрементит его, и запланированные кадры чужого
 * поколения гаснут (B1 — ноль параллельных loops). reduced-motion → мгновенный
 * снап в target без единого кадра (B4 character-switch).
 */
function createFrameRunner(options: Parameters<BehaviorRunnerFactory>[0]): BehaviorRunnerPort {
  const requestFrame = options.requestFrame;
  let reduced = false;
  try {
    reduced = options.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {}
  let gen = 0;
  let curVel = 0;

  const schedule = (cb: (ts?: number) => void): void => {
    const handle = requestFrame!(cb);
    if (handle === 0) setTimeout(() => cb(undefined), 0); // non-draining шов (конвенция repo)
  };

  return {
    _settle(args: BehaviorSettleArgs): void {
      gen++;
      const my = gen;
      curVel = args.velocity;
      const range = args.target - args.from;
      const denom = Math.abs(range);

      const finishNow = (): void => {
        curVel = 0;
        if (args.onStep(args.target, 0)) args.onDone();
      };

      // B4: reduced-motion / вырожденный диапазон / нет кадрового шва → снап.
      if (reduced || range === 0 || !requestFrame) {
        finishNow();
        return;
      }

      // C¹-стык: нормируем унаследованную скорость на диапазон (тот же приём,
      // что smooth-pickup MotionValue и snapBack gestures) — знак «к цели» и
      // непрерывность производной на границе follow|release получаются даром.
      const v0n = curVel / range;
      let elapsed = 0;
      let lastTs: number | undefined;
      let frames = 0;

      const tick = (ts?: number): void => {
        if (my !== gen) return; // stale-кадр после перехвата/cancel
        if (Number.isFinite(ts)) {
          if (lastTs !== undefined) elapsed += Math.max(0, (ts! - lastTs) / 1000);
          lastTs = ts!;
        } else {
          elapsed += FIXED_DT_S;
        }
        frames++;

        const s = solveSpring(args.spring, elapsed, v0n);
        const val = args.from + s.value * range;
        const vel = s.velocity * range;

        if (
          !Number.isFinite(val) ||
          !Number.isFinite(vel) ||
          (Math.abs(val - args.target) / denom < CONVERGENCE_THRESHOLD &&
            Math.abs(vel) / denom < CONVERGENCE_THRESHOLD) ||
          frames >= MAX_FRAMES
        ) {
          finishNow();
          return;
        }
        curVel = vel;
        if (args.onStep(val, vel)) schedule(tick);
      };

      schedule(tick);
    },
    _invalidate(): number {
      gen++;
      const velocity = curVel;
      curVel = 0;
      return velocity;
    },
  };
}

/**
 * Нижняя панель: snap-точки, сопротивление за границами и непрерывный перехват.
 * @throws {MotionParamError} при пустых snapPoints или невалидной пружине.
 */
export function createBottomSheet(options: SheetOptions): SheetController {
  return createSheetController(options, createFrameRunner);
}

/**
 * Закрытие по смещению или скорости; недостигнутая цель возвращается пружиной.
 * @throws {MotionParamError} при невалидных порогах или пружине.
 */
export function createDragDismiss(options: DismissOptions): DismissController {
  return createDismissController(options, createFrameRunner);
}

/**
 * Пейджер с единым состоянием позиции, индекса и доводки; поддерживает RTL.
 * @throws {MotionParamError} при невалидной геометрии или пружине.
 */
export function createCarousel(options: CarouselOptions): CarouselController {
  return createCarouselController(options, createFrameRunner);
}

/**
 * Протяжка с сопротивлением и удержанием до завершения асинхронного обновления.
 * @throws {MotionParamError} при невалидном пороге, pendingPosition или пружине.
 */
export function createPullToRefresh(options: PullOptions): PullController {
  return createPullController(options, createFrameRunner);
}
