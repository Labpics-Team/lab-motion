import { frame, type FrameLoop } from '../frame/index.js';
import { FINISHED, STOPPED, MAX_CHANNELS, MotionError, number, properties, timing, authoredTiming, snapshot, type PropertyInput } from './model.js';
import { TRANSFORMS, isTransform, format, point, program, sample, transform, type Point, type Program, type Segment } from './program.js';
import type { MotionOptions, MotionProperties, MotionResult, MotionScalar, MotionTarget, Playback, PlaybackState, SequenceOptions, SequenceStep, Timing } from './types.js';

export interface RuntimeHost {
  readonly frame: FrameLoop;
  now(): number;
  reduced(): boolean;
  styles(element: Element): CSSStyleDeclaration;
  supports(easing: string): boolean;
}
const defaultHost: RuntimeHost = {
  frame,
  now: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
  reduced: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  styles: element => typeof getComputedStyle === 'function' && 'ownerDocument' in element ? getComputedStyle(element) : (element as HTMLElement).style,
  supports: easing => typeof CSS !== 'undefined' && CSS.supports('animation-timing-function', easing),
};
export function targets(input: MotionTarget, root?: ParentNode): Element[] {
  const selected = typeof input === 'string'
    ? (root ?? (typeof document === 'undefined' ? undefined : document))?.querySelectorAll(input)
    : input;
  if (selected === undefined) throw new MotionError('Селектор требует DOM-контейнер');
  let result: Element[];
  if (selected && typeof selected === 'object' && 'style' in selected) result = [selected as Element];
  else {
    if (!selected || typeof selected !== 'object') throw new MotionError('Ожидается элемент или список элементов');
    if (Symbol.iterator in selected) {
      result = [];
      for (const item of selected as Iterable<Element>) {
        if (result.length === MAX_CHANNELS) throw new MotionError('Слишком много элементов');
        result.push(item);
      }
    } else {
      const list = selected as ArrayLike<Element>, length = list.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHANNELS) throw new MotionError('Недопустимый список элементов');
      result = Array.from({ length }, (_, i) => list[i]!);
    }
  }
  for (const element of result) {
    const style = (element as HTMLElement)?.style;
    if (!style || typeof style.getPropertyValue !== 'function' || typeof style.setProperty !== 'function')
      throw new MotionError('Цель должна предоставлять CSS style');
  }
  return [...new Set(result)];
}
function initialTransforms(style: CSSStyleDeclaration): Record<string, number> {
  const values = { ...TRANSFORMS };
  const text = style.getPropertyValue('transform');
  if (!text || text === 'none') return values;
  if (typeof DOMMatrixReadOnly !== 'undefined') {
    const matrix = new DOMMatrixReadOnly(text);
    if (!matrix.is2D) throw new MotionError('Независимые x/y требуют двумерного transform');
    const { a, b, c, d, e, f } = matrix;
    const sx = Math.hypot(a, b), determinant = a * d - b * c;
    if (sx > 0 && determinant === 0 && (c !== 0 || d !== 0)) throw new MotionError('Вырожденный transform нужно задать явно');
    values.x = e; values.y = f;
    values.scaleX = sx;
    values.scaleY = sx ? determinant / sx : Math.hypot(c, d);
    values.rotate = Math.atan2(sx ? b : -c, sx ? a : d) * 180 / Math.PI;
    values.skewX = determinant ? Math.atan((a * c + b * d) / determinant) * 180 / Math.PI : 0;
    return values;
  }
  // Headless style-hosts поддерживают ту же каноническую форму, которую пишет Motion.
  let rest = text;
  const re = /(translate|translateX|translateY|rotate|skew|skewX|skewY|scale|scaleX|scaleY)\(([^)]+)\)/g;
  for (const match of text.matchAll(re)) {
    const args = match[2]!.split(/[,\s]+/).filter(Boolean).map(Number.parseFloat);
    if (args.some(n => !Number.isFinite(n))) throw new MotionError('Нечисловой transform');
    const name = match[1]!, a = args[0]!;
    if (name === 'translate') { values.x = a; values.y = args[1] ?? 0; }
    else if (name === 'translateX') values.x = a;
    else if (name === 'translateY') values.y = a;
    else if (name === 'scale') { values.scaleX = a; values.scaleY = args[1] ?? a; }
    else if (name === 'skew') { values.skewX = a; values.skewY = args[1] ?? 0; }
    else values[name] = a;
    rest = rest.replace(match[0], '');
  }
  if (rest.trim()) throw new MotionError('Transform не поддерживается этим style-host');
  return values;
}

interface Draft { readonly element: Element; readonly key: string; readonly _program: Program; readonly reduced: boolean }
interface Track {
  readonly _program: Program;
  readonly _group: Surface;
  readonly value: number[];
  readonly _velocity: number[];
  _owner: Run | undefined;
  _elapsed: number;
  _paused: boolean;
  _done: boolean;
}

class Run implements Playback {
  private _tracks = new Set<Track>();
  private _status: PlaybackState = 'running';
  private _natural = true;
  private _notifications = 0;
  private _failure: { error: unknown } | undefined;
  private _resolve!: (value: MotionResult) => void;
  private _reject!: (error: unknown) => void;
  readonly finished: Promise<MotionResult>;
  constructor(readonly duration: number) {
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
  _error(error: unknown): void {
    if (this._failure) return;
    this._failure = { error }; this._status = 'failed';
    for (const track of [...this._tracks]) {
      try { track._group._control([track], 'stop', 0, this); }
      catch { track._group._fail(error); }
    }
    this._complete();
  }
  private _complete(): void {
    if (this._tracks.size || this._notifications) return;
    if (this._failure) this._reject(this._failure.error);
    else {
      this._status = this._natural ? 'finished' : 'stopped';
      this._resolve(this._natural ? FINISHED : STOPPED);
    }
  }
  _own(track: Track): void {
    // Новый вызов получает управление, сохраняя уже исполняемую траекторию.
    // Старый компонент не может остановить движение, принятое его преемником.
    track._owner?._settle(track, false);
    this._tracks.add(track); track._owner = this;
  }
  _settle(track: Track, natural: boolean, failure?: { error: unknown }): void {
    this._tracks.delete(track);
    this._natural &&= natural;
    if (failure) this._error(failure.error);
    this._complete();
  }
  _empty(): void { this._complete(); }
  private _apply(action: 'pause' | 'play' | 'seek' | 'stop' | 'finish', time = 0): void {
    if (this._status !== 'running') return;
    const groups = new Map<Surface, Track[]>();
    for (const track of this._tracks) {
      const list = groups.get(track._group) ?? []; list.push(track); groups.set(track._group, list);
    }
    const failures: unknown[] = [];
    for (const [group, selected] of groups) {
      try { group._control(selected, action, time, this); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Не удалось управлять движением');
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
  readonly _rest: Map<string, Point> = new Map();
  readonly _transforms: Record<string, number>;
  _stamp: number;
  _busy = false;
  private _native: Animation | undefined;
  private _nativeTime = 0;
  private _written: string | undefined;
  private _token: object | undefined;
  constructor(readonly _engine: Runtime, readonly element: Element, readonly key: string) {
    this._transforms = key === 'transform' ? initialTransforms(_engine._host.styles(element)) : {};
    this._stamp = number(_engine._host.now(), 'clock');
  }
  _refresh(): void {
    if (this._tracks.size || this._written === (this.element as HTMLElement).style.getPropertyValue(this.key)) return;
    if (this.key === 'transform') Object.assign(this._transforms, initialTransforms(this._engine._host.styles(this.element)));
    this._rest.clear();
  }
  _read(key: string): { point: Point; _velocity: readonly number[] } {
    const track = this._tracks.get(key);
    if (track) return { point: { _coordinates: [...track.value], unit: track._program.unit }, _velocity: [...track._velocity] };
    if (isTransform(key)) return { point: { _coordinates: [this._transforms[key] ?? TRANSFORMS[key]!], unit: '' }, _velocity: [0] };
    const saved = this._rest.get(key);
    if (saved) return { point: saved, _velocity: saved._coordinates.map(() => 0) };
    const text = this._engine._host.styles(this.element).getPropertyValue(key);
    const initial = point(key, key === 'opacity' ? text === '' ? 1 : number(Number(text), 'opacity') : text || 0);
    return { point: initial, _velocity: initial._coordinates.map(() => 0) };
  }
  _sync(): void {
    if (this._busy) throw new MotionError('Easing должен быть чистой функцией');
    this._busy = true;
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
        if (!track._paused) track._elapsed = Math.max(0, track._elapsed + delta);
        sample(track._program, track._elapsed, track.value, track._velocity);
      }
    } finally { this._busy = false; }
  }
  private _text(at?: 'from' | 'to'): string {
    if (this.key === 'transform') {
      const state = { ...this._transforms };
      for (const [key, track] of this._tracks) {
        const value = at ? track._program._segments[0]![at][0]! : track.value[0]!;
        state[key] = value;
      }
      return !at && Object.keys(TRANSFORMS).every(key => state[key] === TRANSFORMS[key]) ? 'none' : transform(state);
    }
    const track = this._tracks.values().next().value as Track | undefined;
    if (!track) {
      const held = this._rest.get(this.key)!; return format(this.key, held._coordinates, held.unit);
    }
    return format(track._program.key, at ? track._program._segments[0]![at] : track.value, track._program.unit);
  }
  _render(): void {
    if (this._busy) throw new MotionError('Повторная запись свойства');
    this._busy = true;
    try {
      const text = this._text();
      (this.element as HTMLElement).style.setProperty(this.key, text);
      this._written = text;
    }
    finally { this._busy = false; }
  }
  _detach(): void {
    const previous = this._native;
    this._native = undefined; this._token = undefined;
    if (previous) {
      try { this._render(); } finally { previous.cancel(); }
    }
  }
  _attach(track: Track): void {
    const previous = this._tracks.get(track._program.key);
    // Во время замены поверхность сохраняет владельца и регистрацию.
    this._tracks.set(track._program.key, track);
    if (previous) this._end(previous, false);
  }
  _end(track: Track, natural: boolean, failure?: { error: unknown }): void {
    if (track._done) return;
    track._done = true;
    if (this._tracks.get(track._program.key) === track) this._tracks.delete(track._program.key);
    this._rest.set(track._program.key, { _coordinates: [...track.value], unit: track._program.unit });
    if (isTransform(track._program.key)) this._transforms[track._program.key] = track.value[0]!;
    if (this._tracks.size === 0) {
      try { this._engine._idle(this); } catch (error) { failure ??= { error }; }
    }
    const owner = track._owner; track._owner = undefined;
    owner?._settle(track, natural, failure);
  }
  _fail(error: unknown): void {
    const native = this._native; this._native = undefined; this._token = undefined;
    try { native?.cancel(); } catch { /* исходное исключение сохраняется */ }
    for (const track of [...this._tracks.values()]) this._end(track, false, { error });
    this._engine._idle(this);
  }
  _reconcile(): void {
    if (this._tracks.size === 0) { this._engine._idle(this); return; }
    const active = [...this._tracks.values()];
    if (active.every(track => track._paused)) { this._engine._idle(this); return; }
    const first = active[0]!, seg = first._program._segments[0]!;
    const _nativeEase = first._program._nativeEase;
    const canNative = (this.key === 'transform' || this.key === 'opacity') && _nativeEase !== undefined && typeof this.element.animate === 'function' && this._engine._host.supports(_nativeEase) &&
      active.every(track => !track._paused && track._program._nativeEase === _nativeEase && track._program._segments.length === 1 &&
        track._program.duration === first._program.duration && track._program._segments[0]!.at === seg.at && track._elapsed === first._elapsed);
    if (!canNative) { this._engine._wake(this); return; }
    const token = {}; this._token = token;
    try {
      this._busy = true;
      const effect = this.element.animate([{ [this.key]: this._text('from') }, { [this.key]: this._text('to') }], {
        duration: seg.end - seg.at, delay: seg.at, easing: _nativeEase, fill: 'both',
      });
      this._native = effect; this._nativeTime = first._elapsed;
      if (first._elapsed !== 0) effect.currentTime = first._elapsed;
      const finished = effect.finished;
      if (!finished || typeof finished.then !== 'function') throw new MotionError('Native effect не предоставляет finished');
      this._busy = false;
      void finished.then(() => {
        if (this._token !== token) return;
        try {
          for (const track of this._tracks.values()) {
            track._elapsed = track._program.duration; sample(track._program, track._elapsed, track.value, track._velocity);
          }
          this._render(); this._detach();
          for (const track of [...this._tracks.values()]) this._end(track, true);
          this._engine._idle(this);
        } catch (error) { this._fail(error); }
      }, error => {
        if (this._token !== token) return;
        if ((error as { name?: string })?.name === 'AbortError') {
          this._native = undefined; this._token = undefined;
          for (const track of [...this._tracks.values()]) this._end(track, false);
          this._engine._idle(this);
        } else this._fail(error);
      });
      this._engine._idle(this);
    } catch (error) { this._busy = false; this._fail(error); throw error; }
  }
  _control(selected: readonly Track[], action: 'pause' | 'play' | 'seek' | 'stop' | 'finish', time: number, owner?: Run): void {
    const owns = (track: Track): boolean => !track._done && this._tracks.get(track._program.key) === track &&
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
      this._detach();
      for (const track of selected) {
        if (!owns(track)) continue;
        if (action === 'pause') track._paused = true;
        else if (action === 'play') track._paused = false;
        else if (action === 'seek') track._elapsed = time;
        else if (action === 'finish') track._elapsed = track._program.duration;
        sample(track._program, track._elapsed, track.value, track._velocity);
      }
      this._render();
      for (const track of selected) {
        if (!owns(track)) continue;
        if (action === 'stop') this._end(track, false);
        else if (action === 'finish' || action === 'seek' && track._elapsed >= track._program.duration) this._end(track, true);
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
        if (!track._paused && track._elapsed >= track._program.duration) this._end(track, true);
      }
      if (this._tracks.size === 0 || [...this._tracks.values()].every(t => t._paused)) this._engine._idle(this);
    } catch (error) { this._fail(error); }
  }
}

export class Runtime {
  private readonly _surfaces = new WeakMap<Element, Map<string, Surface>>();
  private readonly _active = new Set<Surface>();
  private _offUpdate: (() => void) | undefined;
  private _offRender: (() => void) | undefined;
  private _pending: Array<() => void> = [];
  private _prepared: Surface[] = [];
  private _draining = false;
  private _subscribing = false;
  constructor(readonly _host: RuntimeHost = defaultHost) {}
  _notify(element: Element, key: string, action: () => void): void {
    const owner = this._surfaces.get(element)?.get(key)?._tracks.get(key)?._owner;
    owner?._hold();
    this._after(() => {
      try { action(); }
      catch (error) { owner?._error(error); throw error; }
      finally { owner?._release(); }
    });
  }
  _after(action: () => void): void {
    if (this._pending.length === 0) queueMicrotask(() => this._drain());
    this._pending.push(action);
  }
  _flush(): void { this._drain(); }
  private _drain(): void {
    if (this._draining) return;
    this._draining = true;
    const failures: unknown[] = [];
    try {
      while (this._pending.length) {
        const actions = this._pending; this._pending = [];
        for (const action of actions) { try { action(); } catch (error) { failures.push(error); } }
      }
    } finally { this._draining = false; }
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Ошибка отложенного управления');
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
        this._drain();
      }, { onTeardown: teardown });
      this._offRender = this._host.frame.render(() => {
        const current = this._prepared; this._prepared = [];
        for (const surface of current) surface._paint();
        this._drain();
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
    const groups = this._surfaces.get(surface.element);
    if (surface._tracks.size === 0 && surface.key !== 'transform' && groups?.get(surface.key) === surface)
      groups.delete(surface.key);
    if (this._active.size !== 0) return;
    const update = this._offUpdate, render = this._offRender;
    this._offUpdate = this._offRender = undefined; this._prepared = [];
    const errors: unknown[] = [];
    try { update?.(); } catch (error) { errors.push(error); }
    try { render?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Frame cleanup failed');
  }
  private _surface(element: Element, key: string): Surface {
    let groups = this._surfaces.get(element);
    if (!groups) { groups = new Map(); this._surfaces.set(element, groups); }
    const name = isTransform(key) ? 'transform' : key;
    let group = groups.get(name);
    if (!group) {
      const candidate = new Surface(this, element, name);
      // Чтение host-стиля может синхронно принять другой прогон.
      group = groups.get(name) ?? candidate; groups.set(name, group);
    }
    group._refresh();
    return group;
  }
  private _resolveValue(element: Element, key: string, value: MotionScalar): MotionScalar {
    if (typeof value !== 'string' || !value.trim().startsWith('var(')) return value;
    let text = value;
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const match = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(text.trim());
      if (!match || seen.has(match[1]!)) throw new MotionError(`${key}: неразрешимая CSS-переменная`);
      seen.add(match[1]!);
      text = this._host.styles(element).getPropertyValue(match[1]!).trim() || match[2] || '';
      if (!text.startsWith('var(')) { if (!text) throw new MotionError(`${key}: пустая CSS-переменная`); return text; }
    }
    throw new MotionError(`${key}: слишком глубокая CSS-переменная`);
  }
  private _draft(input: MotionTarget, props: readonly PropertyInput[], clock: Timing, offset = 0,
    origin?: (element: Element, key: string) => Point | undefined): Draft[] {
    const elements = targets(input);
    if (elements.length * props.reduce((sum, p) => sum + p.values.length, 0) > MAX_CHANNELS) throw new MotionError('Слишком много каналов движения');
    const reduced = clock.reduced || this._host.reduced();
    const author = authoredTiming(clock);
    const result: Draft[] = [], synced = new Set<Surface>();
    try {
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i]!;
        for (const property of props) {
          const group = this._surface(element, property.key);
          if (!synced.has(group)) { synced.add(group); group._sync(); }
          const values = property.values.map(v => this._resolveValue(element, property.key, v));
          const explicit = property.authored ? point(property.key, values[0]!) : origin?.(element, property.key);
          const current = explicit ? { point: explicit, _velocity: explicit._coordinates.map(() => 0) } : group._read(property.key);
          const spec = program(property.key, current.point, values, property.authored, property.authored ? author : clock, current._velocity, offset + i * clock.stagger);
          result.push({ element, key: property.key, _program: spec, reduced });
        }
      }
    } finally {
      // План хранит значения; пустая CSS-поверхность не нужна между стадиями.
      for (const group of synced) if (group._tracks.size === 0) this._idle(group);
    }
    return result;
  }
  private _execute(drafts: readonly Draft[], total?: number): Playback {
    const run = new Run(total ?? drafts.reduce((max, d) => Math.max(max, d.reduced ? 0 : d._program.duration), 0));
    const touched = new Set<Surface>();
    try {
      for (const draft of drafts) {
        const group = this._surface(draft.element, draft.key);
        const existing = group._tracks.get(draft.key);
        const equal = !draft.reduced && draft._program._identity && existing?._program._identity &&
          draft._program._identity.every((v, i) => Object.is(v, existing._program._identity![i]));
        if (equal) { run._own(existing!); continue; }
        if (!touched.has(group)) { group._sync(); group._detach(); touched.add(group); }
        const first = draft._program._segments[0]!.from;
        const track: Track = { _program: draft._program, _group: group, value: [...first], _velocity: first.map(() => 0),
          _owner: undefined, _elapsed: draft.reduced ? draft._program.duration : 0, _paused: false, _done: false };
        sample(track._program, track._elapsed, track.value, track._velocity);
        run._own(track); group._attach(track);
      }
      for (const group of touched) {
        group._render();
        for (const track of [...group._tracks.values()]) if (track._elapsed >= track._program.duration) group._end(track, true);
        group._reconcile();
      }
      run._empty();
    } catch (error) { run._error(error); throw error; }
    this._drain(); return run;
  }
  animate(target: MotionTarget, props: MotionProperties, options?: MotionOptions): Playback {
    const input = properties(props);
    const clock = timing(options);
    return this._execute(this._draft(target, input, clock));
  }
  sequence(steps: readonly SequenceStep[], options?: SequenceOptions): Playback {
    const list = snapshot(steps, 'sequence');
    const sequenceClock = timing(options as MotionOptions | undefined);
    const merged = new Map<Element, Map<string, Draft>>();
    let cursor = 0, previousStart = 0, end = 0, count = 0;
    for (const tuple of list) {
      const [target, props, option] = snapshot(tuple, 'sequence step', 2) as unknown as SequenceStep;
      if (tuple.length > 3) throw new MotionError('Шаг последовательности: [target, properties, options]');
      const { at, ...rest } = option ?? {};
      const offset = at === '<' ? previousStart : at === undefined || at === '>' ? cursor : number(at, 'at', 0);
      const input = properties(props), clock = timing(rest);
      const drafts = this._draft(target, input, clock, offset + sequenceClock.delay, (element, key) => {
        const prior = merged.get(element)?.get(key)?._program;
        return prior && { _coordinates: prior.final, unit: prior.unit };
      });
      for (const draft of drafts) {
        count += draft._program._segments.length;
        if (count > MAX_CHANNELS) throw new MotionError('Последовательность слишком велика');
        let channels = merged.get(draft.element);
        if (!channels) { channels = new Map(); merged.set(draft.element, channels); }
        const before = channels.get(draft.key);
        let next = draft;
        if (before) {
          const at = draft._program._segments[0]!.at;
          if (at < before._program.duration) throw new MotionError('Шаги одного свойства не должны пересекаться');
          next = { ...draft, _program: { ...draft._program, _segments: [...before._program._segments, ...draft._program._segments], _nativeEase: undefined, _identity: undefined } };
        }
        channels.set(draft.key, next);
        end = Math.max(end, next._program.duration);
      }
      previousStart = offset; cursor = Math.max(0, end - sequenceClock.delay);
    }
    const drafts = [...merged.values()].flatMap(map => [...map.values()]).map(d => ({ ...d, reduced: d.reduced || sequenceClock.reduced, _program: { ...d._program, duration: end, _nativeEase: undefined, _identity: undefined } }));
    return this._execute(drafts, drafts.every(draft => draft.reduced) ? 0 : end);
  }
}

export const runtime: Runtime = new Runtime();
export const animate: (target: MotionTarget, props: MotionProperties, options?: MotionOptions) => Playback = runtime.animate.bind(runtime);
export const sequence: (steps: readonly SequenceStep[], options?: SequenceOptions) => Playback = runtime.sequence.bind(runtime);
