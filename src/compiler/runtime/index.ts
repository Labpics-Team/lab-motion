/**
 * compiler/runtime.ts — private executor compiled-nano артефактов (#208, #221).
 *
 * Это build-tool деталь, не runtime-tier: сюда попадают ТОЛЬКО вызовы,
 * которые compiler доказанно понизил. Математика (springLinear) — общий SSOT
 * с ./nano на build-стороне; исполнительный WAAPI-хвост НАМЕРЕННО дублирует
 * nano/index байт-в-байт по семантике: непереговорный потолок nano 1024 B
 * не оплачивает функциональную границу общего хвоста (§7.3), а паритет
 * запечатан differential-сьютом compiler-nano-lowering (C4: журнал
 * keyframes/options, delay/stagger/explicit-reduced политика,
 * finished/commitStyles/cancel). Любая правка хвоста здесь или в nano/index
 * обязана пройти этот сьют. Parser, IR, spring solver и compiler в модуль
 * не входят.
 */

import { buildTransform } from '../../value/transform.js';
import type { NanoControls, NanoTarget } from '../../nano/index.js';

export type { NanoControls, NanoTarget } from '../../nano/index.js';

/**
 * Компактная форма, которую инъецирует compiler: f — готовый кадр
 * (PropertyIndexedKeyframes-эквивалент), d/e — duration/easing, y/g —
 * delay/stagger (мс), r — статически доказанный reducedMotion (1/0;
 * отсутствие — ambient matchMedia в момент вызова, как у nano).
 */
export interface CompiledNanoCall {
  readonly f: Readonly<Record<string, number | string>>;
  readonly d: number;
  readonly e: string;
  readonly y?: number | undefined;
  readonly g?: number | undefined;
  readonly r?: 0 | 1 | undefined;
}

export function animateCompiled(target: NanoTarget, artifact: CompiledNanoCall): NanoControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  // r: 0|1|undefined — `??` пропускает явный 0 как falsy (то же поведение,
  // что прежний тернарий с === 1), ambient-ветка только при отсутствии r.
  const reduced = artifact.r
    ?? (typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Один frame-объект на ВЕСЬ вызов (литерал артефакта), не на элемент —
  // паритет с nano, который строит кадр один раз.
  const frame = artifact.f as PropertyIndexedKeyframes;
  const animations = Array.from(source, (element, index) => element.animate(frame, {
    duration: reduced ? 0 : artifact.d,
    easing: reduced ? 'linear' : artifact.e,
    delay: reduced ? 0 : (artifact.y ?? 0) + (artifact.g ?? 0) * index,
    fill: 'both',
  })) as NanoControls;
  animations.finished = Promise.all(animations.map((animation) => new Promise<Animation>((resolve, reject) => {
    animation.finished.catch(reject);
    animation.addEventListener('finish', () => queueMicrotask(() => {
      animation.finished.catch(reject);
      if (animation.playState !== 'finished') return;
      try {
        animation.commitStyles();
        animation.cancel();
      } catch { /* fill сохраняет финал на платформе без commitStyles */ }
      resolve(animation);
    }));
  })));
  return animations;
}

// ─── #240 facade-erasure: исполнитель понижённого `./animate` ────────────────
//
// Тот же класс модуля, что animateCompiled: build-tool деталь, не третий
// runtime-tier (#220). Семантика — nano-подобная одноразовость, которую автор
// подтвердил прагмой `@lm-oneshot`: без реестра владения, C¹-подхвата и
// residual-transform. Исполнительный хвост (кадры, тайминг, финализация)
// намеренно повторяет фасадный WaapiUnit._emit байт-в-байт по семантике;
// паритет запечатан C4-дифференциалом (журнал element.animate против фасада).

/** Канал понижённого фасадного вызова: [ключ, from, to]. */
export type CompiledFacadeChannel = readonly [key: string, from: number, to: number];
/** Группа записи: [CSS-группа, каналы] — одна Animation на группу. */
export type CompiledFacadeGroup = readonly [group: string, channels: readonly CompiledFacadeChannel[]];

/** Компактная форма фасадного артефакта, которую инъецирует compiler. */
export interface CompiledFacadeCall {
  readonly c: readonly CompiledFacadeGroup[];
  readonly d: number;
  readonly e: string;
  readonly y?: number | undefined;
  readonly g?: number | undefined;
}

/**
 * Значение канала при прогрессе p. Зеркало channelAt (animate/channels.ts):
 * границы возвращают public operands (IEEE −0 — часть endpoint-контракта),
 * статический span не считается взвешенной формой.
 */
function facadeChannelAt(from: number, to: number, p: number): number {
  if (p === 1) return to;
  if (p === 0 || from === to) return from;
  const value = (1 - p) * from + p * to;
  return Number.isFinite(value) ? value : to;
}

/**
 * Значение группы при прогрессе p. Зеркало groupValueAt: transform собирается
 * общим SSOT buildTransform (импортируется, не дублируется), прочие группы —
 * единственным числовым каналом.
 */
function facadeGroupAt(group: string, channels: readonly CompiledFacadeChannel[], p: number): string | number {
  if (group !== 'transform') {
    const [, from, to] = channels[0]!;
    return facadeChannelAt(from, to, p);
  }
  const state: Record<string, number> = {};
  for (const [key, from, to] of channels) state[key] = facadeChannelAt(from, to, p);
  return buildTransform(state);
}

/**
 * Кадры одной группы. Не-WebKit платформы получают ДВА кадра (0 и 1) и всю
 * физику в linear()-строке; WebKit не исполняет linear() и получает явные
 * стопы, развёрнутые из той же строки (`progress percent%`) — это не
 * дублирование данных, а разбор уже injected артефакта, поэтому литерал не
 * растёт. Разбор строгий: любая неожиданная форма роняет вызов, а не рисует
 * тихо неверную кривую.
 */
function facadeFrames(
  group: string,
  channels: readonly CompiledFacadeChannel[],
  easing: string,
  explicit: boolean,
): Record<string, string | number>[] {
  if (!explicit) {
    return [
      { offset: 0, [group]: facadeGroupAt(group, channels, 0) },
      { offset: 1, [group]: facadeGroupAt(group, channels, 1) },
    ];
  }
  return easing.slice(7, -1).split(', ').map((stop) => {
    const space = stop.indexOf(' ');
    const progress = +stop.slice(0, space);
    const percent = +stop.slice(space + 1, -1);
    if (!Number.isFinite(progress) || !Number.isFinite(percent)) {
      throw new Error('lab-motion: повреждённый артефакт кривой');
    }
    return { offset: percent / 100, [group]: facadeGroupAt(group, channels, progress) };
  });
}

/** WebKit не исполняет CSS linear(): зеркало requiresExplicitSpringKeyframes. */
function facadeRequiresExplicitKeyframes(): boolean {
  try {
    const identity = (globalThis as { navigator?: { vendor?: string; userAgent?: string } }).navigator;
    return !!(identity?.vendor?.includes('Apple') && identity?.userAgent?.includes('AppleWebKit'));
  } catch {
    return false;
  }
}

export function animateFacadeCompiled(
  target: NanoTarget,
  artifact: CompiledFacadeCall,
): NanoControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  const reduced = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const explicit = !reduced && facadeRequiresExplicitKeyframes();
  const animations: Animation[] = [];
  Array.from(source, (element, index) => {
    const delay = (artifact.y ?? 0) + (artifact.g ?? 0) * index;
    for (const [group, channels] of artifact.c) {
      // Политика reduced-motion фасада: финальная поза пишется сразу, кадров
      // нет вовсе (не duration:0-анимация) — движение запрещено, а результат
      // обязан быть виден.
      if (reduced) {
        (element as unknown as { style: CSSStyleDeclaration }).style
          .setProperty(group, String(facadeGroupAt(group, channels, 1)));
        continue;
      }
      animations.push(element.animate(facadeFrames(group, channels, artifact.e, explicit), {
        duration: artifact.d,
        easing: explicit ? 'linear' : artifact.e,
        iterations: 1,
        fill: 'both',
        composite: 'replace',
        ...(delay > 0 ? { delay } : {}),
      }));
    }
  });
  const controls = animations as NanoControls;
  // Duck-контракт целей (#131/#196): фасад принимает host, чей animate()
  // возвращает минимальный объект. Ненаблюдаемая Animation (без finished или
  // addEventListener) не роняет вызов — она просто не участвует в агрегате
  // ожидания; финал держит fill:'both'. Врать о времени завершения нельзя,
  // поэтому такая запись резолвится сразу, а не «через duration».
  controls.finished = Promise.all(animations.map((animation) => (
    typeof animation.addEventListener === 'function' && animation.finished
      ? new Promise<Animation>((resolve, reject) => {
        animation.finished.catch(reject);
        animation.addEventListener('finish', () => queueMicrotask(() => {
          animation.finished.catch(reject);
          if (animation.playState !== 'finished') return;
          try {
            animation.commitStyles();
            animation.cancel();
          } catch { /* fill сохраняет финал на платформе без commitStyles */ }
          resolve(animation);
        }));
      })
      : Promise.resolve(animation)
  )));
  return controls;
}
