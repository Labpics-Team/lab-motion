import { tryParseUnit } from '../value/units.js';
import { attemptAll, rethrow } from './attempt-all.js';
import { frame, type FrameLoop } from '../frame/index.js';
import { FINISHED, STOPPED, MAX_CHANNELS, failMotion, number, properties, timing, authoredTiming, isVariable, type PropertyInput, type Timing } from './model.js';
import { TRANSFORMS, isTransform, format, point, program, sample, transform, type Point, type Program, type Segment } from './program.js';
import type { MotionOptions, MotionProperties, MotionResult, MotionScalar, MotionTarget, Playback, PlaybackState } from './types.js';

export interface RuntimeHost {
  readonly frame: FrameLoop;
  now(): number;
  reduced(): boolean;
  styles(element: Element): CSSStyleDeclaration;
  supports(easing: string): boolean;
}
// Один браузерный ответ: повторный native-start не разбирает ту же CSS-кривую.
let cachedHost: typeof CSS | undefined;
let cachedCheck: typeof CSS.supports | undefined;
let cachedEasing: string | undefined;
let cachedResult = false;
function supports(easing: string): boolean {
  if (typeof CSS === 'undefined') return false;
  const host = CSS, check = host.supports;
  if (host !== cachedHost || check !== cachedCheck || easing !== cachedEasing) {
    const result: boolean = Reflect.apply(check, host, ['animation-timing-function', easing]);
    cachedHost = host; cachedCheck = check; cachedEasing = easing; cachedResult = result;
  }
  return cachedResult;
}
const defaultHost: RuntimeHost = {
  frame,
  now: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
  reduced: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  styles: element => typeof getComputedStyle === 'function' && 'ownerDocument' in element ? getComputedStyle(element) : (element as HTMLElement).style,
  supports,
};
export function targets(input: MotionTarget, root?: ParentNode): Element[] {
  const selected = typeof input === 'string'
    ? (root ?? (typeof document === 'undefined' ? undefined : document))?.querySelectorAll(input)
    : input;
  if (selected === undefined) failMotion('Селектор: нет DOM');
  let result: Element[];
  if (selected && typeof selected === 'object' && 'style' in selected) result = [selected as Element];
  else {
    if (!selected || typeof selected !== 'object') failMotion('Нужен Element/список');
    if (Symbol.iterator in selected) {
      result = [];
      for (const item of selected as Iterable<Element>) {
        if (result.length === MAX_CHANNELS) failMotion('Лимит элементов');
        result.push(item);
      }
    } else {
      const list = selected as ArrayLike<Element>, length = list.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHANNELS) failMotion('Неверный список');
      result = Array.from({ length }, (_, i) => list[i]!);
    }
  }
  for (const element of result) {
    const style = (element as HTMLElement)?.style;
    if (!style || typeof style.getPropertyValue !== 'function' || typeof style.setProperty !== 'function')
      failMotion('У цели нет CSS style');
  }
  return [...new Set(result)];
}
function initialTransforms(style: CSSStyleDeclaration): Record<string, number> {
  const values = { ...TRANSFORMS };
  const text = style.getPropertyValue('transform');
  if (!text || text === 'none') return values;
  if (typeof DOMMatrixReadOnly !== 'undefined') {
    const matrix = new DOMMatrixReadOnly(text);
    if (!matrix.is2D) failMotion('x/y: нужен 2D transform');
    const { a, b, c, d, e, f } = matrix;
    const sx = Math.hypot(a, b), determinant = a * d - b * c;
    if (sx > 0 && determinant === 0 && (c !== 0 || d !== 0)) failMotion('transform вырожден');
    values.x = e; values.y = f;
    values.scaleX = sx;
    values.scaleY = sx ? determinant / sx : Math.hypot(c, d);
    values.rotate = Math.atan2(sx ? b : -c, sx ? a : d) * 180 / Math.PI;
    values.skewX = determinant ? Math.atan((a * c + b * d) / determinant) * 180 / Math.PI : 0;
    return values;
  }
  // Headless style-hosts поддерживают ту же каноническую форму, которую пишет Motion.
  const rest = text.replace(/(translate[XY]?|rotate|(?:skew|scale)[XY]?)\(([^)]+)\)/g, (_match, name: string, arguments_: string) => {
    const args = arguments_.trim().split(/[,\s]+/).map(Number.parseFloat);
    if (args.some(n => !Number.isFinite(n))) failMotion('transform: не число');
    const a = args[0]!;
    if (name === 'translate') { values.x = a; values.y = args[1] ?? 0; }
    else if (name === 'scale' || name === 'skew') {
      values[name + 'X'] = a;
      values[name + 'Y'] = args[1] ?? (name === 'scale' ? a : 0);
    } else values[name === 'translateX' ? 'x' : name === 'translateY' ? 'y' : name] = a;
    return '';
  });
  if (rest.trim()) failMotion('transform не поддержан');
  return values;
}

export type ControlOperation = (surface: Surface, selected: readonly Track[]) => void;
type ControlAction = 'pause' | 'play' | 'seek' | 'stop' | 'finish' | ControlOperation;

export interface Draft { readonly _element: Element; readonly _key: string; readonly _program: Program; readonly _reduced: boolean }
interface Track {
  readonly _program: Program;
  readonly _group: Surface;
  readonly _value: number[];
  readonly _velocity: number[];
  _owner: Run | undefined;
  _elapsed: number;
  _rate: number;
  _paused: boolean;
}

function moving(track: Track): boolean { return !track._paused && track._rate !== 0; }

export class Run implements Playback {
  readonly _tracks: Set<Track> = new Set();
  private _status: PlaybackState = 'running';
  private _natural = true;
  declare _capture?: (track: Track) => void;
  private _notifications = 0;
  private _failure: { _error: unknown } | undefined;
  private _cleaning = false;
  private _resolve!: (value: MotionResult) => void;
  private _reject!: (error: unknown) => void;
  readonly finished: Promise<MotionResult>;
  constructor(public duration: number) {
    this.finished = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    // Ошибка доступна через original promise; отсутствие await не оставляет unhandled rejection.
    void this.finished.catch(() => {});
  }
  get state(): PlaybackState {
    if (this._status === 'running') {
      for (const track of this._tracks) if (!track._paused) return 'running';
      if (this._tracks.size) return 'paused';
    }
    return this._status;
  }
  _hold(): void { this._notifications++; }
  _release(): void { this._notifications--; this._complete(); }
  _fault(error: unknown): void {
    if (this._failure) return;
    this._failure = { _error: error }; this._status = 'failed';
  }
  _error(error: unknown): void {
    this._fault(error);
    if (this._cleaning) return;
    this._cleaning = true;
    try {
      for (const track of [...this._tracks]) {
        try { track._group._control([track], 'stop', 0, this); }
        catch { track._group._fail(error); }
      }
    } finally { this._cleaning = false; this._complete(); }
  }
  _complete(): void {
    if (this._tracks.size || this._notifications) return;
    if (this._failure) this._reject(this._failure._error);
    else {
      const result = this._natural ? FINISHED : STOPPED;
      this._status = result.status; this._resolve(result);
    }
  }
  _own(track: Track, reduced = false): void {
    if (!reduced) this.duration = Math.max(this.duration, track._program._duration);
    // Новый вызов получает управление, сохраняя уже исполняемую траекторию.
    // Старый компонент не может остановить движение, принятое его преемником.
    track._owner?._settle(track, false);
    this._tracks.add(track); track._owner = this;
  }
  _settle(track: Track, natural: boolean, failure?: { _error: unknown }): void {
    this._capture?.(track);
    this._tracks.delete(track);
    this._natural &&= natural;
    if (failure) this._error(failure._error);
    this._complete();
  }
  _apply(action: ControlAction, time = 0): void {
    if (this._status !== 'running') return;
    const engine = this._tracks.values().next().value?._group._engine;
    if (engine?._operations) { engine._after(() => this._apply(action, time)); return; }
    const groups = new Set<Surface>();
    for (const track of this._tracks) groups.add(track._group);
    const failures: unknown[] = [];
    engine?._operation(true);
    try {
      attemptAll(groups, group => group._control(
        [...group._tracks.values()].filter(track => track._owner === this), action, time, this,
      ), failures);
    } finally { engine?._operation(false); }
    try { engine?._flush(); } catch (error) { failures.push(error); }
    rethrow(failures, 'Ошибки управления');
  }
  pause(): void { this._apply('pause'); }
  play(): void { this._apply('play'); }
  seek(milliseconds: number): void {
    if (this._status === 'running') this._apply('seek', number(milliseconds, 'seek', 0));
  }
  stop(): void { this._apply('stop'); }
  finish(): void { this._apply('finish'); }
}

class Surface {
  readonly _tracks: Map<string, Track> = new Map();
  private _rest: Point | undefined;
  readonly _transforms: Record<string, number>;
  _stamp: number;
  _busy = false;
  _native: Animation | undefined;
  _nativeTime = 0;
  private _written: string | undefined;
  private _token: Promise<Animation> | undefined;
  constructor(readonly _engine: Runtime, readonly _element: Element, readonly _key: string) {
    this._transforms = _key === 'transform' ? initialTransforms(_engine._host.styles(_element)) : {};
    this._stamp = number(_engine._host.now(), 'clock');
  }
  _lock(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._engine._operation(busy);
  }
  _refresh(): void {
    if (this._tracks.size || this._written === (this._element as HTMLElement).style.getPropertyValue(this._key)) return;
    if (this._key === 'transform') Object.assign(this._transforms, initialTransforms(this._engine._host.styles(this._element)));
    this._rest = undefined;
  }
  _read(key: string): Point & { readonly _velocity: readonly number[] } {
    const track = this._tracks.get(key);
    if (track) return { _coordinates: [...track._value], _unit: track._program._unit, _velocity: [...track._velocity] };
    if (isTransform(key)) return { _coordinates: [this._transforms[key] ?? TRANSFORMS[key]!], _unit: '', _velocity: [0] };
    let initial = this._rest;
    if (!initial) {
      const text = this._engine._host.styles(this._element).getPropertyValue(key);
      initial = point(key, key === 'opacity' ? text === '' ? 1 : number(Number(text), 'opacity') : text || 0);
    }
    return { ...initial, _velocity: initial._coordinates.map(() => 0) };
  }
  _sync(): void {
    if (this._busy) failMotion('easing: повторный вход');
    this._lock(true);
    try {
      const now = number(this._engine._host.now(), 'clock');
      let delta = Math.max(0, now - this._stamp);
      if (this._native) {
        const local = this._native.currentTime;
        const current = typeof local === 'number' && Number.isFinite(local) ? local : this._nativeTime;
        delta = current - this._nativeTime; this._nativeTime = current;
      }
      this._stamp = Math.max(this._stamp, now);
      for (const track of this._tracks.values()) {
        if (!track._paused && (this._native || track._rate !== 0))
          track._elapsed = Math.min(track._program._duration, Math.max(0, track._elapsed + (this._native ? delta : delta * track._rate)));
        this._sample(track);
      }
    } finally { this._lock(false); }
  }
  _sample(track: Track): void {
    sample(track._program, track._elapsed, track._value, track._velocity,
      track._paused ? 0 : this._native?.playbackRate ?? track._rate);
  }
  _ended(track: Track): boolean {
    return track._rate < 0 ? track._elapsed <= 0 : track._elapsed >= track._program._duration;
  }
  private _text(at: 0 | 1 | 2 = 0): string {
    if (this._key === 'transform') {
      const state = this._transforms;
      for (const track of this._tracks.values()) {
        const value = (at ? at === 1 ? track._program._segments[0]!._from : track._program._segments[0]!._to : track._value)[0]!;
        state[track._program._key] = value;
      }
      let identity = !at, translationOnly = !!at;
      for (const key in TRANSFORMS) {
        const neutral = state[key] === TRANSFORMS[key];
        identity &&= neutral;
        if (key !== 'x' && key !== 'y') translationOnly &&= neutral && !this._tracks.has(key);
      }
      return identity ? 'none' : transform(state, translationOnly);
    }
    const track = this._tracks.values().next().value as Track | undefined;
    if (!track) {
      const held = this._rest!; return format(this._key, held._coordinates, held._unit);
    }
    return format(track._program._key, at ? at === 1 ? track._program._segments[0]!._from : track._program._segments[0]!._to : track._value, track._program._unit);
  }
  _render(): void {
    if (this._busy) failMotion('style: повторная запись');
    this._lock(true);
    try {
      const text = this._text();
      (this._element as HTMLElement).style.setProperty(this._key, text);
      this._written = text;
    }
    finally { this._lock(false); }
  }
  _detach(): void {
    const previous = this._native;
    this._native = undefined; this._token = undefined;
    if (previous) {
      try { this._render(); }
      catch (error) {
        try { previous.cancel(); } catch { /* ошибка CSS-записи остаётся причиной */ }
        throw error;
      }
      previous.cancel();
    }
  }
  _attach(track: Track): void {
    const previous = this._tracks.get(track._program._key);
    // Во время замены поверхность сохраняет владельца и регистрацию.
    this._tracks.set(track._program._key, track);
    if (previous) this._end(previous, false);
  }
  _end(track: Track, natural: boolean, failure?: { _error: unknown }): void {
    const owner = track._owner;
    if (!owner) return;
    track._owner = undefined;
    if (this._tracks.get(track._program._key) === track) this._tracks.delete(track._program._key);
    if (this._key !== 'transform') this._rest = { _coordinates: [...track._value], _unit: track._program._unit };
    if (isTransform(track._program._key)) this._transforms[track._program._key] = track._value[0]!;
    if (this._tracks.size === 0) {
      try { this._engine._idle(this); } catch (error) { failure ??= { _error: error }; }
    }
    owner._settle(track, natural, failure);
  }
  _fail(error: unknown): void {
    // Снимок полномочий делается до host.cancel: callback может принять successor.
    const owned = [...this._tracks.values()].map(track => [track, track._owner] as const);
    for (const [, owner] of owned) owner?._fault(error);
    const native = this._native; this._native = undefined; this._token = undefined;
    try { native?.cancel(); } catch { /* исходное исключение остаётся причиной */ }
    for (const [track, owner] of owned) {
      if (owner && track._owner === owner) this._end(track, false, { _error: error });
    }
  }
  _reconcile(): void {
    if (this._native || this._tracks.size === 0) { this._engine._idle(this); return; }
    const active = [...this._tracks.values()];
    if (!active.some(moving)) { this._engine._idle(this); return; }
    const first = active[0]!, seg = first._program._segments[0]!;
    const _nativeEase = first._program._nativeEase;
    const canNative = first._rate > 0 && (this._key === 'transform' || this._key === 'opacity') && _nativeEase !== undefined && typeof this._element.animate === 'function' && this._engine._host.supports(_nativeEase) &&
      active.every(track => !track._paused && track._rate === first._rate && track._program._nativeEase === _nativeEase && track._program._segments.length === 1 &&
        track._program._duration === first._program._duration && track._program._segments[0]!._at === seg._at && track._elapsed === first._elapsed);
    if (!canNative) { this._engine._wake(this); return; }
    try {
      this._lock(true);
      const effect = this._element.animate([{ [this._key]: this._text(1) }, { [this._key]: this._text(2) }], {
        duration: seg._end - seg._at, delay: seg._at, easing: _nativeEase, fill: 'both',
      });
      this._native = effect; this._nativeTime = first._elapsed;
      this._watch();
      // Новый effect ещё не передан потребителю; сначала скорость, затем точная поза.
      if (first._rate !== 1) effect.playbackRate = first._rate;
      if (first._elapsed !== 0) effect.currentTime = first._elapsed;
      this._lock(false);
      this._engine._idle(this);
    } catch (error) { this._lock(false); this._fail(error); throw error; }
  }
  _watch(): void {
    const effect = this._native!, finished = effect.finished;
    if (this._token === finished) return;
    const token = this._token = finished;
    if (!finished || typeof finished.then !== 'function') failMotion('У Animation нет finished');
    const fail = (error: unknown): void => {
      if (this._token !== token || this._native !== effect) return;
      if ((error as { name?: string })?.name !== 'AbortError') { this._fail(error); return; }
      this._native = undefined; this._token = undefined;
      for (const track of [...this._tracks.values()]) this._end(track, false);
    };
    void finished.then(() => {
      if (this._token !== token || this._native !== effect) return;
      const completed = [...this._tracks.values()].map(track => [track, track._owner] as const);
      try {
        for (const [track] of completed) {
          track._elapsed = track._program._duration;
          this._sample(track);
        }
        this._detach();
        // Host cleanup может синхронно передать даже прежний Track новому Run.
        for (const [track, owner] of completed) if (track._owner === owner) this._end(track, true);
      } catch (error) { this._fail(error); }
    }, fail);
  }
  _control(selected: readonly Track[], action: ControlAction, time: number, owner?: Run): void {
    const owns = (track: Track): boolean => !!track._owner && this._tracks.get(track._program._key) === track &&
      (owner === undefined || track._owner === owner);
    // Пока команда ждала, траектория могла перейти к другому вызову.
    if (!selected.some(owns)) return;
    if (this._busy) {
      // Управление из пользовательского callback принимается после текущей операции.
      this._engine._after(() => this._control(selected, action, time, owner));
      return;
    }
    try {
      this._sync();
      if (!selected.some(owns)) return;
      if (typeof action === 'function') {
        action(this, selected.filter(owns));
      } else {
        this._detach();
        for (const track of selected) {
          if (!owns(track)) continue;
          if (action === 'pause') track._paused = true;
          else if (action === 'play') track._paused = false;
          else if (action === 'seek') track._elapsed = Math.min(time, track._program._duration);
          else if (action === 'finish') track._elapsed = track._program._duration;
          this._sample(track);
        }
        this._render();
        for (const track of selected) {
          if (!owns(track)) continue;
          if (action === 'stop') this._end(track, false);
          else if (action === 'finish' || action === 'seek' && this._ended(track)) this._end(track, true);
        }
      }
      this._reconcile();
      this._engine._flush();
    } catch (error) { this._fail(error); throw error; }
  }
  _tick(): void {
    if (this._native || this._tracks.size === 0) return;
    try { this._sync(); } catch (error) { this._fail(error); }
  }
  _paint(): void {
    if (this._native || this._tracks.size === 0) return;
    try {
      this._render();
      for (const track of [...this._tracks.values()]) {
        if (moving(track) && this._ended(track)) this._end(track, true);
      }
      for (const track of this._tracks.values()) if (moving(track)) return;
      this._engine._idle(this);
    } catch (error) { this._fail(error); }
  }
}

export class Runtime {
  private readonly _surfaces = new WeakMap<Element, Record<string, Surface>>();
  private readonly _active = new Set<Surface>();
  private _offUpdate: (() => void) | undefined;
  private _offRender: (() => void) | undefined;
  private _pending: Array<() => void> = [];
  private _prepared: Surface[] = [];
  private _draining = false;
  _operations = 0;
  private _subscribing = false;
  constructor(readonly _host: RuntimeHost = defaultHost) {}
  _operation(enter: boolean): void { this._operations += enter ? 1 : -1; }
  _notify(element: Element, key: string, action: () => void): void {
    const owner = this._surfaces.get(element)?.[key]?._tracks.get(key)?._owner;
    owner?._hold();
    this._after(() => {
      try { action(); }
      catch (error) { owner?._error(error); throw error; }
      finally { owner?._release(); }
    });
  }
  _after(action: () => void): void {
    if (this._pending.length === 0) queueMicrotask(() => this._flush());
    this._pending.push(action);
  }
  _flush(): void {
    if (this._pending.length === 0 || this._draining || this._operations) return;
    this._draining = true;
    const failures: unknown[] = [];
    try {
      attemptAll(this._pending, action => action(), failures);
    } finally { this._pending.length = 0; this._draining = false; }
    rethrow(failures, 'Ошибки команд');
  }
  _wake(surface: Surface): void {
    this._active.add(surface);
    if (this._offUpdate || this._subscribing) return;
    this._subscribing = true;
    const teardown = (): void => {
      this._offUpdate = this._offRender = undefined;
      for (const current of [...this._active]) current._control([...current._tracks.values()], 'stop', 0);
    };
    try {
      this._offUpdate = this._host.frame.update(() => {
        this._prepared = [...this._active];
        for (const current of this._prepared) current._tick();
        this._flush();
      }, { onTeardown: teardown });
      this._offRender = this._host.frame.render(() => {
        const current = this._prepared; this._prepared = [];
        for (const surface of current) surface._paint();
        this._flush();
      }, { onTeardown: teardown });
      if (this._active.size === 0) { this._offUpdate(); this._offRender(); this._offUpdate = this._offRender = undefined; }
    } catch (error) {
      this._offUpdate?.(); this._offRender?.(); this._offUpdate = this._offRender = undefined;
      for (const current of [...this._active]) current._fail(error);
      throw error;
    } finally { this._subscribing = false; }
  }
  _idle(surface: Surface): void {
    this._active.delete(surface);
    const groups = this._surfaces.get(surface._element);
    if (surface._tracks.size === 0 && surface._key !== 'transform' && groups?.[surface._key] === surface)
      delete groups[surface._key];
    if (this._active.size !== 0) return;
    const update = this._offUpdate, render = this._offRender;
    this._offUpdate = this._offRender = undefined; this._prepared = [];
    if (update || render) rethrow(attemptAll([update, render], release => release?.()), 'Frame cleanup failed');
  }
  private _surface(element: Element, key: string): Surface {
    let groups = this._surfaces.get(element);
    if (!groups) { groups = Object.create(null) as Record<string, Surface>; this._surfaces.set(element, groups); }
    const name = isTransform(key) ? 'transform' : key;
    let group = groups[name];
    if (!group) {
      const candidate = new Surface(this, element, name);
      // Чтение host-стиля может синхронно принять другой прогон.
      group = groups[name] ?? candidate; groups[name] = group;
    }
    group._refresh();
    return group;
  }
  private _resolveValue(element: Element, key: string, value: MotionScalar): MotionScalar {
    if (!isVariable(value)) return value;
    let text = value;
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const variable = tryParseUnit(text);
      if (variable?.kind !== 'var' || seen.has(variable.name)) failMotion(`${key}: CSS var не найдена`);
      seen.add(variable.name);
      text = this._host.styles(element).getPropertyValue(variable.name).trim() || variable.fallback || '';
      if (!/^var\(/i.test(text)) { if (!text) failMotion(`${key}: пустая CSS-переменная`); return text; }
    }
    failMotion(`${key}: CSS var: цикл или глубина`);
  }
  _draft(input: MotionTarget, props: readonly PropertyInput[], clock: Timing, offset = 0,
    origin?: (element: Element, key: string) => Point | undefined): Draft[] {
    const elements = targets(input);
    if (elements.length * props.reduce((sum, p) => sum + p._values.length, 0) > MAX_CHANNELS) failMotion('Слишком много каналов');
    const reduced = clock._reduced || this._host.reduced();
    const author = authoredTiming(clock);
    const result: Draft[] = [], synced = new Set<Surface>();
    try {
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i]!;
        for (let j = 0; j < props.length; j++) {
          const property = props[j]!;
          const group = this._surface(element, property._key);
          if (!synced.has(group)) { synced.add(group); group._sync(); }
          const values = property._literal ? property._values : property._values.map(v => this._resolveValue(element, property._key, v));
          const explicit = property._authored ? point(property._key, values[0]!) : origin?.(element, property._key);
          const current = explicit ? { ...explicit, _velocity: explicit._coordinates.map(() => 0) } : group._read(property._key);
          const spec = program(property._key, current, values, property._authored, property._authored ? author : clock, current._velocity, offset + i * clock._stagger);
          result.push({ _element: element, _key: property._key, _program: spec, _reduced: reduced });
        }
      }
    } finally {
      // План хранит значения; пустая CSS-поверхность не нужна между стадиями.
      for (const group of synced) if (group._tracks.size === 0) this._idle(group);
    }
    return result;
  }
  _execute(drafts: readonly Draft[], total?: number): Playback {
    const run = new Run(total ?? 0);
    const touched = new Set<Surface>();
    try {
      for (const draft of drafts) {
        const group = this._surface(draft._element, draft._key);
        const existing = group._tracks.get(draft._key);
        const equal = !draft._reduced && draft._program._identity && existing?._program._identity &&
          draft._program._identity.every((v, i) => Object.is(v, existing._program._identity![i]));
        if (equal) { run._own(existing!); continue; }
        if (!touched.has(group)) { group._sync(); group._detach(); touched.add(group); }
        const first = draft._program._segments[0]!._from;
        const track: Track = { _program: draft._program, _group: group, _value: [...first], _velocity: first.map(() => 0),
          _owner: undefined, _elapsed: draft._reduced ? draft._program._duration : 0, _rate: 1, _paused: false };
        group._sample(track);
        run._own(track, draft._reduced); group._attach(track);
      }
      for (const group of touched) {
        group._render();
        for (const track of [...group._tracks.values()]) if (track._elapsed >= track._program._duration) group._end(track, true);
        group._reconcile();
      }
      run._complete();
    } catch (error) { run._error(error); throw error; }
    this._flush(); return run;
  }
  animate(target: MotionTarget, props: MotionProperties, options?: MotionOptions): Playback {
    const input = properties(props);
    const clock = timing(options);
    return this._execute(this._draft(target, input, clock));
  }
}

export const runtime: Runtime = /* @__PURE__ */ new Runtime();
export function animate(target: MotionTarget, props: MotionProperties, options?: MotionOptions): Playback {
  return runtime.animate(target, props, options);
}
