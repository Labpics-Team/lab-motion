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

/**
 * Реестр состояния понижённых прогонов: элемент → группа → значения каналов
 * на КОНЕЦ последнего прогона. Без него второй вызов на том же элементе
 * стартовал бы из identity и телепортировал элемент назад — фасад именно для
 * этого держит свой реестр (см. bindGroup: живой прогон → реестр → identity →
 * живой стиль). WeakMap: запись умирает вместе с элементом, чистить нечего.
 */
interface FacadeRun {
  readonly channels: readonly CompiledFacadeChannel[];
  readonly easing: string;
  readonly durationMs: number;
  readonly delayMs: number;
  readonly animation: Animation | undefined;
}
const facadeRegistry = new WeakMap<object, Map<string, FacadeRun>>();

/** Стопы кривой из уже инъецированной linear()-строки: [progress, доля]. */
function facadeStops(easing: string): [progress: number, tau: number][] {
  return easing.slice(7, -1).split(', ').map((stop) => {
    const space = stop.indexOf(' ');
    return [+stop.slice(0, space), +stop.slice(space + 1, -1) / 100];
  });
}

/**
 * Прогресс кривой в доле времени τ — та же кусочно-линейная функция, которую
 * исполняет браузер по linear()-строке. Нужна, чтобы прерванный на лету прогон
 * отдал СВОЮ текущую позицию: без этого следующий вызов стартовал бы из конца
 * (прыжок вперёд) либо из identity (прыжок назад).
 */
function facadeProgressAt(easing: string, tau: number): number {
  const stops = facadeStops(easing);
  if (tau <= 0) return stops[0]![0];
  const last = stops[stops.length - 1]!;
  if (tau >= last[1]) return last[0];
  for (let i = 1; i < stops.length; i++) {
    const [progress, at] = stops[i]!;
    if (tau > at) continue;
    const [prevProgress, prevAt] = stops[i - 1]!;
    const span = at - prevAt;
    return span === 0
      ? progress
      : prevProgress + (progress - prevProgress) * ((tau - prevAt) / span);
  }
  return last[0];
}

/**
 * Доля пройденного времени прогона. Отменённый прогон (playState idle) не
 * оставил следа — его состояние игнорируется; нечитаемое время трактуется как
 * завершение (fill:'both' держит финальную позу, значит визуально мы там).
 */
function facadeRunTau(run: FacadeRun): number | undefined {
  const animation = run.animation;
  if (animation === undefined) return 1;
  try {
    if (animation.playState === 'idle') return undefined;
    const time = animation.currentTime;
    // Нечитаемое время — состояние НЕИЗВЕСТНО, а не «завершено»: угадывать
    // финальную позу значит рисковать прыжком вперёд. Неизвестность роняет нас
    // в тот же каскад, что у фасада без живого владельца (стиль → identity).
    if (typeof time !== 'number') return undefined;
    const elapsed = time - run.delayMs;
    return elapsed <= 0 ? 0 : Math.min(1, elapsed / run.durationMs);
  } catch {
    return undefined; // hostile-host: состояние неизвестно — тот же каскад
  }
}

/**
 * Старт канала — тем же каскадом, что фасад: реестр прошлого прогона →
 * identity для transform (декомпозиция computed-матрицы ненадёжна, фасад её
 * тоже не делает) → живой стиль для прочих групп (opacity и подобные).
 * `from` артефакта используется ТОЛЬКО как identity/дефолт, потому что
 * компилятор не может знать состояние страницы.
 */
function facadeStartValue(
  element: object,
  group: string,
  key: string,
  artifactFrom: number,
): number {
  const run = facadeRegistry.get(element)?.get(group);
  if (run !== undefined) {
    const tau = facadeRunTau(run);
    if (tau !== undefined) {
      const channel = run.channels.find(([name]) => name === key);
      if (channel !== undefined) {
        return facadeChannelAt(channel[1], channel[2], facadeProgressAt(run.easing, tau));
      }
    }
  }
  if (group === 'transform') return artifactFrom;
  try {
    const style = (element as { style?: { getPropertyValue?(n: string): string } }).style;
    const inline = style?.getPropertyValue?.(group);
    if (inline !== undefined && inline !== '') {
      const parsed = parseFloat(inline);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch { /* duck-цель без полного style-контракта */ }
  const computed = (globalThis as {
    getComputedStyle?: (e: unknown) => { getPropertyValue(n: string): string };
  }).getComputedStyle;
  if (typeof computed === 'function') {
    try {
      const parsed = parseFloat(computed(element).getPropertyValue(group));
      if (Number.isFinite(parsed)) return parsed;
    } catch { /* не-Element цель в DOM-среде */ }
  }
  return artifactFrom;
}

/** Запоминает прогон: следующий вызов читает из него ТЕКУЩУЮ позицию. */
function rememberFacadeRun(element: object, group: string, run: FacadeRun): void {
  let groups = facadeRegistry.get(element);
  if (groups === undefined) facadeRegistry.set(element, groups = new Map());
  groups.set(group, run);
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
    for (const [group, artifactChannels] of artifact.c) {
      // Старт — из ЖИВОГО состояния (реестр прошлого прогона / стиль), а не из
      // артефакта: компилятор не знает состояние страницы, и вызов «верни
      // карточку назад» обязан ехать оттуда, где она сейчас, а не телепортировать
      // её в identity. Это тот же каскад, что у фасадного bindGroup.
      const channels = artifactChannels.map(([key, from, to]): CompiledFacadeChannel =>
        [key, facadeStartValue(element as object, group, key, from), to]);
      // Политика reduced-motion фасада: финальная поза пишется сразу, кадров
      // нет вовсе (не duration:0-анимация) — движение запрещено, а результат
      // обязан быть виден.
      if (reduced) {
        (element as unknown as { style: CSSStyleDeclaration }).style
          .setProperty(group, String(facadeGroupAt(group, channels, 1)));
        rememberFacadeRun(element as object, group, {
          channels, easing: artifact.e, durationMs: artifact.d, delayMs: 0, animation: undefined,
        });
        continue;
      }
      const animation = element.animate(facadeFrames(group, channels, artifact.e, explicit), {
        duration: artifact.d,
        easing: explicit ? 'linear' : artifact.e,
        iterations: 1,
        fill: 'both',
        composite: 'replace',
        ...(delay > 0 ? { delay } : {}),
      });
      // Прогон регистрируется ЖИВЫМ: следующий вызов на этом элементе прочитает
      // из него текущую позицию (сэмплированием той же кривой), а не финальную.
      rememberFacadeRun(element as object, group, {
        channels, easing: artifact.e, durationMs: artifact.d, delayMs: delay, animation,
      });
      animations.push(animation);
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
