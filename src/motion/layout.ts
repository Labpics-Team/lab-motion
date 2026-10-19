import { FINISHED, STOPPED, MotionError, number, timing } from './model.js';
import { program } from './program.js';
import type { MotionEase, MotionOptions, MotionResult, MotionSpring, Playback, PlaybackState } from './types.js';

interface LayoutCommon { readonly delay?: number; readonly reducedMotion?: 'user' | 'always' }
export type LayoutOptions = LayoutCommon & (
  | { readonly spring?: MotionSpring; readonly duration?: never; readonly ease?: never }
  | { readonly duration?: number; readonly ease?: Exclude<MotionEase, (p: number) => number>; readonly spring?: never }
);
interface Transition {
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  readonly updateCallbackDone: Promise<void>;
  skipTransition(): void;
}
interface Session {
  _root: Element;
  _document: Document;
  _transition?: Transition;
  _style?: HTMLStyleElement;
  _effects: Animation[];
  _name: string;
  _previousName: string;
  _previousPriority: string;
  _delay: number;
  _easing: string | undefined;
}
function clearStyles(session: Session): void {
  const css = (session._root as HTMLElement).style;
  try {
    if (css.getPropertyValue('view-transition-name') === session._name) {
      if (session._previousName) css.setProperty('view-transition-name', session._previousName, session._previousPriority);
      else css.removeProperty('view-transition-name');
    }
  } finally {
    const style = session._style; session._style = undefined; style?.remove();
  }
}
const owners = new WeakMap<Document, Playback>();
let serial = 0;

function createLayout(root: Element, mutate: () => void | Promise<void>, options?: LayoutOptions): Playback {
  const config = timing(options as MotionOptions | undefined);
  if (!config.cssEase) throw new MotionError('layout использует CSS easing');
  const path = program('--lab-motion-progress', { _coordinates: [0], unit: '' }, [1], false, config, [0]);
  const reduced = config.reduced || root.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const duration = reduced ? 0 : path.duration;
  let session: Session | undefined = { _root: root, _document: root.ownerDocument, _effects: [], _name: `lab-motion-${++serial}`,
    _previousName: '', _previousPriority: '', _delay: config.delay, _easing: path._nativeEase };
  let action: (() => void | Promise<void>) | undefined = mutate;
  let status: PlaybackState = 'running', settled = false;
  let terminal: MotionResult | undefined, requested: number | undefined;
  let resolve!: (result: MotionResult) => void, reject!: (error: unknown) => void;
  const finished = new Promise<MotionResult>((yes, no) => { resolve = yes; reject = no; });
  void finished.catch(() => {});
  const inactive = (): boolean => settled || terminal !== undefined;

  function release(cancel: boolean): void {
    const current = session; session = undefined;
    if (!current) return;
    if (owners.get(current._document) === run) owners.delete(current._document);
    try { if (cancel) current._transition?.skipTransition(); }
    finally { clearStyles(current); }
  }
  function complete(failure?: { error: unknown }): void {
    if (settled) return;
    settled = true; action = undefined;
    try { release(Boolean(failure)); } catch (error) { failure ??= { error }; }
    if (failure) { status = 'failed'; reject(failure.error); }
    else { const result = terminal ?? FINISHED; status = result.status; resolve(result); }
  }
  function stopWith(result: MotionResult): void {
    if (inactive()) return;
    terminal = result; status = result.status;
    try { release(true); } catch (error) { complete({ error }); }
  }
  function apply(): void {
    for (const effect of session?._effects ?? []) {
      if (status === 'paused') effect.pause(); else effect.play();
      if (requested !== undefined) effect.currentTime = requested;
    }
    requested = undefined;
  }
  function playing(next: PlaybackState): void {
    if (inactive()) return;
    status = next;
    if (session?._effects.length) apply();
  }
  const run: Playback = {
    duration, finished, get state(): PlaybackState { return status; },
    pause(): void { playing('paused'); }, play(): void { playing('running'); },
    seek(milliseconds): void {
      if (inactive()) return;
      requested = number(milliseconds, 'seek', 0);
      if (requested >= duration) stopWith(FINISHED);
      else if (session?._effects.length) apply();
    },
    stop(): void { stopWith(STOPPED); }, finish(): void { stopWith(FINISHED); },
  };
  async function commit(): Promise<void> {
    const update = action; action = undefined;
    await update?.();
  }
  function ready(): void {
    const current = session;
    if (!current || inactive()) return;
    try {
      current._effects = current._document.getAnimations().filter(effect => {
        const pseudo = (effect.effect as (KeyframeEffect & { pseudoElement?: string }) | null)?.pseudoElement;
        return typeof pseudo === 'string' && pseudo.includes(current._name);
      });
      if (status === 'paused' || requested !== undefined) apply();
    } catch (error) { complete({ error }); }
  }
  // Только session удерживает DOM после запуска; release обрывает эту ссылку.
  function start(): void {
    const current = session!;
    owners.get(current._document)?.stop(); owners.set(current._document, run);
    const inline = (current._root as HTMLElement).style;
    current._previousName = inline.getPropertyValue('view-transition-name');
    current._previousPriority = inline.getPropertyPriority('view-transition-name');
    const native = current._document.startViewTransition;
    const css = current._document.defaultView?.CSS;
    const supported = typeof native === 'function' && current._easing !== undefined && css?.supports('animation-timing-function', current._easing);
    const failed = (error: unknown): void => complete({ error });
    if (!duration || !supported) { void commit().then(() => complete(), failed); return; }
    try {
      inline.setProperty('view-transition-name', current._name);
      const style = current._document.createElement('style'); current._style = style;
      style.textContent = `::view-transition-group(${current._name}){animation-duration:${duration - current._delay}ms;animation-delay:${current._delay}ms;animation-timing-function:${current._easing}}::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}`;
      (current._document.head ?? current._document.documentElement).append(style);
      const transition = native.call(current._document, commit); current._transition = transition;
      void transition.ready.then(ready, () => {});
      void transition.updateCallbackDone.catch(failed);
      void transition.finished.then(() => complete(), failed);
    } catch (error) { complete({ error }); throw error; }
  }
  start();
  return run;
}

/** Обновляет приложение один раз; временные снимки принадлежат браузеру. */
export function layout(root: Element, mutate: () => void | Promise<void>, options?: LayoutOptions): Playback {
  if (!root?.ownerDocument || typeof root.getBoundingClientRect !== 'function' || !(root as HTMLElement).style)
    throw new MotionError('layout ожидает DOM-элемент');
  if (typeof mutate !== 'function') throw new MotionError('layout ожидает функцию изменения DOM');
  return createLayout(root, mutate, options);
}
