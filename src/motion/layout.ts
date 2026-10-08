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
  _mutate: (() => void | Promise<void>) | undefined;
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
const owners = new WeakMap<Document, LayoutRun>();
let serial = 0;

class LayoutRun implements Playback {
  private _session: Session | undefined;
  private _status: PlaybackState = 'running';
  private _resolve!: (result: MotionResult) => void;
  private _reject!: (error: unknown) => void;
  private _terminal: MotionResult | undefined;
  private _settled = false;
  private _requestedTime: number | undefined;
  readonly duration: number;
  readonly finished: Promise<MotionResult>;
  constructor(root: Element, mutate: () => void | Promise<void>, options?: LayoutOptions) {
    const config = timing(options as MotionOptions | undefined);
    if (typeof config.ease === 'function' && !config.cssEase) throw new MotionError('layout использует CSS easing');
    const path = program('--lab-motion-progress', { coordinates: [0], unit: '' }, [1], false, config, [0]);
    const win = root.ownerDocument.defaultView;
    const reduced = config.reduced || win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    this.duration = reduced ? 0 : path.duration;
    this.finished = new Promise((yes, no) => { this._resolve = yes; this._reject = no; });
    void this.finished.catch(() => {});
    this._session = { _root: root, _document: root.ownerDocument, _mutate: mutate, _effects: [], _name: `lab-motion-${++serial}`,
      _previousName: '', _previousPriority: '',
      _delay: config.delay, _easing: path.nativeEase };
  }
  get state(): PlaybackState { return this._status; }
  private _inactive(): boolean { return this._settled || this._terminal !== undefined; }
  private _complete(failure?: { error: unknown }): void {
    if (this._settled) return;
    this._settled = true;
    const session = this._session; this._session = undefined;
    if (session) {
      if (owners.get(session._document) === this) owners.delete(session._document);
      if (failure) { try { session._transition?.skipTransition(); } catch { /* сохраняем исходную ошибку */ } }
      try { clearStyles(session); } catch (error) { failure ??= { error }; }
    }
    if (failure) { this._status = 'failed'; this._reject(failure.error); }
    else { const result = this._terminal ?? FINISHED; this._status = result.status; this._resolve(result); }
  }
  private _stopWith(result: MotionResult): void {
    if (this._inactive()) return;
    this._terminal = result; this._status = result.status;
    try {
      this._session?._transition?.skipTransition();
      if (this._session) clearStyles(this._session);
    } catch (error) { this._complete({ error }); return; }
  }
  private _apply(): void {
    for (const effect of this._session?._effects ?? []) {
      if (this._status === 'paused') effect.pause(); else effect.play();
      if (this._requestedTime !== undefined) effect.currentTime = this._requestedTime;
    }
    this._requestedTime = undefined;
  }
  pause(): void { if (!this._inactive()) { this._status = 'paused'; if (this._session?._effects.length) this._apply(); } }
  play(): void { if (!this._inactive()) { this._status = 'running'; if (this._session?._effects.length) this._apply(); } }
  seek(milliseconds: number): void {
    if (this._inactive()) return;
    this._requestedTime = number(milliseconds, 'seek', 0);
    if (this._requestedTime >= this.duration) this._stopWith(FINISHED);
    else if (this._session?._effects.length) this._apply();
  }
  stop(): void { this._stopWith(STOPPED); }
  finish(): void { this._stopWith(FINISHED); }
  private async _commit(): Promise<void> {
    const action = this._session?._mutate;
    if (this._session) this._session._mutate = undefined;
    await action?.();
  }
  private _ready(): void {
    const session = this._session;
    if (!session || this._inactive()) return;
    try {
      session._effects = session._document.getAnimations().filter(effect => {
        const pseudo = (effect.effect as (KeyframeEffect & { pseudoElement?: string }) | null)?.pseudoElement;
        return typeof pseudo === 'string' && pseudo.includes(session._name);
      });
      if (this._status === 'paused' || this._requestedTime !== undefined) this._apply();
    } catch (error) { this._complete({ error }); }
  }
  start(): void {
    const session = this._session!;
    owners.get(session._document)?.stop(); owners.set(session._document, this);
    const inline = (session._root as HTMLElement).style;
    session._previousName = inline.getPropertyValue('view-transition-name');
    session._previousPriority = inline.getPropertyPriority('view-transition-name');
    const native = session._document.startViewTransition;
    const css = session._document.defaultView?.CSS;
    const supported = typeof native === 'function' && session._easing !== undefined && css?.supports('animation-timing-function', session._easing);
    if (!this.duration || !supported) {
      void this._commit().then(() => this._complete(), error => this._complete({ error }));
      return;
    }
    try {
      (session._root as HTMLElement).style.setProperty('view-transition-name', session._name);
      const style = session._document.createElement('style'); session._style = style;
      style.textContent = `::view-transition-group(${session._name}){animation-duration:${this.duration - session._delay}ms;animation-delay:${session._delay}ms;animation-timing-function:${session._easing}}::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}`;
      (session._document.head ?? session._document.documentElement).append(style);
      const transition = native.call(session._document, () => this._commit());
      session._transition = transition;
      void transition.ready.then(() => this._ready(), () => {});
      void transition.updateCallbackDone.catch(error => this._complete({ error }));
      void transition.finished.then(() => this._complete(), error => this._complete({ error }));
    } catch (error) { this._complete({ error }); throw error; }
  }
}

/** Обновляет приложение один раз; временные снимки принадлежат браузеру. */
export function layout(root: Element, mutate: () => void | Promise<void>, options?: LayoutOptions): Playback {
  if (!root?.ownerDocument || typeof root.getBoundingClientRect !== 'function' || !(root as HTMLElement).style)
    throw new MotionError('layout ожидает DOM-элемент');
  if (typeof mutate !== 'function') throw new MotionError('layout ожидает функцию изменения DOM');
  const run = new LayoutRun(root, mutate, options); run.start(); return run;
}
