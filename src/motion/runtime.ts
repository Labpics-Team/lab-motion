import { frame, type FrameLoop } from '../frame/index.js';
import { FINISHED, STOPPED, MAX_CHANNELS, MotionError, number, properties, timing, snapshot, type PropertyInput } from './model.js';
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

interface Draft { readonly element: Element; readonly key: string; readonly program: Program; readonly reduced: boolean }
interface Track {
  readonly program: Program;
  readonly group: Surface;
  readonly value: number[];
  readonly velocity: number[];
  _owner: Run | undefined;
  elapsed: number;
  paused: boolean;
  done: boolean;
}

class Run implements Playback {
  private _tracks = new Set<Track>();
  private _status: PlaybackState = 'running';
  private _natural = true;
  private _failure: { error: unknown } | undefined;
  private _resolve!: (value: MotionResult) => void;
  private _reject!: (error: unknown) => void;
  readonly finished: Promise<MotionResult>;
  constructor(readonly duration: number) {
    this.finished = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    // Ошибка доступна через original promise; отсутствие await не оставляет unhandled rejection.
    void this.finished.catch(() => {});
  }
  get state(): PlaybackState { return this._status; }
  own(track: Track): void {
    // Новый вызов получает управление, сохраняя уже исполняемую траекторию.
    // Старый компонент не может остановить движение, принятое его преемником.
    track._owner?.settle(track, false);
    this._tracks.add(track); track._owner = this;
  }
  settle(track: Track, natural: boolean, failure?: { error: unknown }): void {
    this._tracks.delete(track);
    if (failure && !this._failure) {
      this._failure = failure; this._status = 'failed';
      for (const remaining of [...this._tracks]) {
        try { remaining.group._control([remaining], 'stop', 0, this); }
        catch { remaining.group._fail(failure.error); }
      }
    }
    this._natural &&= natural;
    if (this._tracks.size === 0 && this._failure) { this._reject(this._failure.error); return; }
    if (this._tracks.size === 0 && this._status !== 'failed') {
      this._status = this._natural ? 'finished' : 'stopped';
      this._resolve(this._natural ? FINISHED : STOPPED);
    }
  }
  empty(): void { if (this._tracks.size === 0 && this._status === 'running') { this._status = 'finished'; this._resolve(FINISHED); } }
  private _apply(action: 'pause' | 'play' | 'seek' | 'stop' | 'finish', time = 0): void {
    if (this._status === 'finished' || this._status === 'stopped' || this._status === 'failed') return;
    const groups = new Map<Surface, Track[]>();
    for (const track of this._tracks) {
      const list = groups.get(track.group) ?? []; list.push(track); groups.set(track.group, list);
    }
    const failures: unknown[] = [];
    for (const [group, selected] of groups) {
      try { group._control(selected, action, time, this); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Не удалось управлять движением');
    if (this._status === 'running' || this._status === 'paused') {
      if (action === 'pause') this._status = 'paused';
      else if (action === 'play') this._status = 'running';
    }
  }
  pause(): void { this._apply('pause'); }
  play(): void { this._apply('play'); }
  seek(milliseconds: number): void {
    if (this._status === 'running' || this._status === 'paused') this._apply('seek', number(milliseconds, 'seek', 0));
  }
  stop(): void { this._apply('stop'); }
  finish(): void { this._apply('finish'); }
}

class Surface {
  readonly tracks: Map<string, Track> = new Map();
  readonly rest: Map<string, Point> = new Map();
  readonly transforms: Record<string, number>;
  stamp: number;
  busy = false;
  private _native: Animation | undefined;
  private _nativeTime = 0;
  private _written: string | undefined;
  private _token: object | undefined;
  constructor(readonly engine: Runtime, readonly element: Element, readonly key: string) {
    const style = engine.host.styles(element);
    this.transforms = key === 'transform' ? initialTransforms(style) : {};
    this.stamp = number(engine.host.now(), 'clock');
  }
  _refresh(): void {
    if (this.tracks.size || this._written === (this.element as HTMLElement).style.getPropertyValue(this.key)) return;
    if (this.key === 'transform') Object.assign(this.transforms, initialTransforms(this.engine.host.styles(this.element)));
    this.rest.clear();
  }
  _read(key: string): { point: Point; velocity: readonly number[] } {
    const track = this.tracks.get(key);
    if (track) return { point: { coordinates: [...track.value], unit: track.program.unit }, velocity: [...track.velocity] };
    if (isTransform(key)) return { point: { coordinates: [this.transforms[key] ?? TRANSFORMS[key]!], unit: '' }, velocity: [0] };
    const saved = this.rest.get(key);
    if (saved) return { point: saved, velocity: saved.coordinates.map(() => 0) };
    const text = this.engine.host.styles(this.element).getPropertyValue(key);
    const initial = point(key, key === 'opacity' ? text === '' ? 1 : number(Number(text), 'opacity') : text || 0);
    return { point: initial, velocity: initial.coordinates.map(() => 0) };
  }
  _sync(): void {
    if (this.busy) throw new MotionError('Повторный вход в вычисление движения; easing должен быть чистым');
    this.busy = true;
    try {
      const now = number(this.engine.host.now(), 'clock');
      let delta = Math.max(0, now - this.stamp);
      if (this._native) {
        const local = this._native.currentTime;
        const current = typeof local === 'number' && Number.isFinite(local) ? local : this._nativeTime;
        delta = current - this._nativeTime; this._nativeTime = current;
      }
      this.stamp = Math.max(this.stamp, now);
      for (const track of this.tracks.values()) {
        if (!track.paused) track.elapsed = Math.max(0, track.elapsed + delta);
        sample(track.program, track.elapsed, track.value, track.velocity);
      }
    } finally { this.busy = false; }
  }
  private _text(at?: 'from' | 'to'): string {
    if (this.key === 'transform') {
      const state = { ...this.transforms };
      for (const [key, track] of this.tracks) {
        const value = at ? track.program.segments[0]![at][0]! : track.value[0]!;
        state[key] = value;
      }
      return !at && Object.keys(TRANSFORMS).every(key => state[key] === TRANSFORMS[key]) ? 'none' : transform(state);
    }
    const track = this.tracks.values().next().value as Track | undefined;
    if (!track) {
      const held = this.rest.get(this.key)!; return format(this.key, held.coordinates, held.unit);
    }
    return format(track.program.key, at ? track.program.segments[0]![at] : track.value, track.program.unit);
  }
  _render(): void {
    if (this.busy) throw new MotionError('Повторная запись свойства');
    this.busy = true;
    try {
      const text = this._text();
      (this.element as HTMLElement).style.setProperty(this.key, text);
      this._written = text;
    }
    finally { this.busy = false; }
  }
  _detach(): void {
    const previous = this._native;
    this._native = undefined; this._token = undefined;
    if (previous) {
      try { this._render(); } finally { previous.cancel(); }
    }
  }
  _attach(track: Track): void {
    const previous = this.tracks.get(track.program.key);
    // Во время замены поверхность сохраняет владельца и регистрацию.
    this.tracks.set(track.program.key, track);
    if (previous) this._end(previous, false);
  }
  _end(track: Track, natural: boolean, failure?: { error: unknown }): void {
    if (track.done) return;
    track.done = true;
    if (this.tracks.get(track.program.key) === track) this.tracks.delete(track.program.key);
    this.rest.set(track.program.key, { coordinates: [...track.value], unit: track.program.unit });
    if (isTransform(track.program.key)) this.transforms[track.program.key] = track.value[0]!;
    if (this.tracks.size === 0) {
      try { this.engine.idle(this); } catch (error) { failure ??= { error }; }
    }
    const owner = track._owner; track._owner = undefined;
    owner?.settle(track, natural, failure);
  }
  _fail(error: unknown): void {
    const native = this._native; this._native = undefined; this._token = undefined;
    try { native?.cancel(); } catch { /* исходное исключение сохраняется */ }
    for (const track of [...this.tracks.values()]) this._end(track, false, { error });
    this.engine.idle(this);
  }
  _reconcile(): void {
    if (this.tracks.size === 0) { this.engine.idle(this); return; }
    const active = [...this.tracks.values()];
    if (active.every(track => track.paused)) { this.engine.idle(this); return; }
    const first = active[0]!, seg = first.program.segments[0]!;
    const nativeEase = first.program.nativeEase;
    const canNative = (this.key === 'transform' || this.key === 'opacity') && nativeEase !== undefined && typeof this.element.animate === 'function' && this.engine.host.supports(nativeEase) &&
      active.every(track => !track.paused && track.program.nativeEase === nativeEase && track.program.segments.length === 1 &&
        track.program.duration === first.program.duration && track.program.segments[0]!.at === seg.at && track.elapsed === first.elapsed);
    if (!canNative) { this.engine.wake(this); return; }
    const token = {}; this._token = token;
    try {
      this.busy = true;
      const effect = this.element.animate([{ [this.key]: this._text('from') }, { [this.key]: this._text('to') }], {
        duration: seg.end - seg.at, delay: seg.at, easing: nativeEase, fill: 'both',
      });
      this._native = effect; this._nativeTime = first.elapsed;
      if (first.elapsed !== 0) effect.currentTime = first.elapsed;
      const finished = effect.finished;
      if (!finished || typeof finished.then !== 'function') throw new MotionError('Native effect не предоставляет finished');
      this.busy = false;
      void finished.then(() => {
        if (this._token !== token) return;
        try {
          for (const track of this.tracks.values()) {
            track.elapsed = track.program.duration; sample(track.program, track.elapsed, track.value, track.velocity);
          }
          this._render(); this._detach();
          for (const track of [...this.tracks.values()]) this._end(track, true);
          this.engine.idle(this);
        } catch (error) { this._fail(error); }
      }, error => {
        if (this._token !== token) return;
        if ((error as { name?: string })?.name === 'AbortError') {
          this._native = undefined; this._token = undefined;
          for (const track of [...this.tracks.values()]) this._end(track, false);
          this.engine.idle(this);
        } else this._fail(error);
      });
      this.engine.idle(this);
    } catch (error) { this.busy = false; this._fail(error); throw error; }
  }
  _control(selected: readonly Track[], action: 'pause' | 'play' | 'seek' | 'stop' | 'finish', time: number, owner?: Run): void {
    const owns = (track: Track): boolean => !track.done && this.tracks.get(track.program.key) === track &&
      (owner === undefined || track._owner === owner);
    // Пока команда ждала, траектория могла перейти к другому вызову.
    if (!selected.some(owns)) return;
    if (this.busy) {
      // Управление из пользовательского callback принимается после текущей операции.
      this.engine.after(() => this._control(selected, action, time, owner));
      return;
    }
    try {
      this._sync();
      if (!selected.some(owns)) return;
      this._detach();
      for (const track of selected) {
        if (!owns(track)) continue;
        if (action === 'pause') track.paused = true;
        else if (action === 'play') track.paused = false;
        else if (action === 'seek') track.elapsed = time;
        else if (action === 'finish') track.elapsed = track.program.duration;
        sample(track.program, track.elapsed, track.value, track.velocity);
      }
      this._render();
      for (const track of selected) {
        if (!owns(track)) continue;
        if (action === 'stop') this._end(track, false);
        else if (action === 'finish' || action === 'seek' && track.elapsed >= track.program.duration) this._end(track, true);
      }
      this._reconcile();
      this.engine.flush();
    } catch (error) { this._fail(error); throw error; }
  }
  _tick(): void {
    if (this._native || this.tracks.size === 0) return;
    try { this._sync(); } catch (error) { this._fail(error); }
  }
  _paint(): void {
    if (this._native || this.tracks.size === 0) return;
    try {
      this._render();
      for (const track of [...this.tracks.values()]) {
        if (!track.paused && track.elapsed >= track.program.duration) this._end(track, true);
      }
      if (this.tracks.size === 0 || [...this.tracks.values()].every(t => t.paused)) this.engine.idle(this);
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
  constructor(readonly host: RuntimeHost = defaultHost) {}
  after(action: () => void): void {
    if (this._pending.length === 0) queueMicrotask(() => this._drain());
    this._pending.push(action);
  }
  flush(): void { this._drain(); }
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
  wake(surface: Surface): void {
    this._active.add(surface);
    if (this._offUpdate || this._subscribing) return;
    this._subscribing = true;
    const teardown = (): void => {
      this._offUpdate = this._offRender = undefined;
      for (const current of [...this._active]) current._control([...current.tracks.values()], 'stop', 0);
    };
    try {
      this._offUpdate = this.host.frame.update(() => {
        this._prepared = [...this._active];
        for (const current of this._prepared) current._tick();
        this._drain();
      }, { onTeardown: teardown });
      this._offRender = this.host.frame.render(() => {
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
  idle(surface: Surface): void {
    this._active.delete(surface);
    const groups = this._surfaces.get(surface.element);
    if (surface.tracks.size === 0 && surface.key !== 'transform' && groups?.get(surface.key) === surface)
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
      text = this.host.styles(element).getPropertyValue(match[1]!).trim() || match[2] || '';
      if (!text.startsWith('var(')) { if (!text) throw new MotionError(`${key}: пустая CSS-переменная`); return text; }
    }
    throw new MotionError(`${key}: слишком глубокая CSS-переменная`);
  }
  private _draft(input: MotionTarget, props: readonly PropertyInput[], clock: Timing, offset = 0): Draft[] {
    const elements = targets(input);
    if (elements.length * props.reduce((sum, p) => sum + p.values.length, 0) > MAX_CHANNELS) throw new MotionError('Слишком много каналов движения');
    const reduced = clock.reduced || this.host.reduced();
    const result: Draft[] = [], synced = new Set<Surface>();
    try {
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i]!;
        for (const property of props) {
          const group = this._surface(element, property.key);
          if (!synced.has(group)) { synced.add(group); group._sync(); }
          const values = property.values.map(v => this._resolveValue(element, property.key, v));
          const explicit = property.authored ? point(property.key, values[0]!) : undefined;
          const current = explicit ? { point: explicit, velocity: explicit.coordinates.map(() => 0) } : group._read(property.key);
          const spec = program(property.key, current.point, values, property.authored, clock, current.velocity, offset + i * clock.stagger);
          result.push({ element, key: property.key, program: spec, reduced });
        }
      }
    } catch (error) {
      // Отвергнутый ввод не оставляет записей на живом элементе.
      for (const group of synced) if (group.tracks.size === 0) this.idle(group);
      throw error;
    }
    return result;
  }
  private _execute(drafts: readonly Draft[], total?: number): Playback {
    const run = new Run(total ?? drafts.reduce((max, d) => Math.max(max, d.reduced ? 0 : d.program.duration), 0));
    const touched = new Set<Surface>();
    try {
      for (const draft of drafts) {
        const group = this._surface(draft.element, draft.key);
        const existing = group.tracks.get(draft.key);
        const equal = !draft.reduced && draft.program.identity && existing?.program.identity &&
          draft.program.identity.every((v, i) => Object.is(v, existing.program.identity![i]));
        if (equal) { run.own(existing!); continue; }
        if (!touched.has(group)) { group._sync(); group._detach(); touched.add(group); }
        const first = draft.program.segments[0]!.from;
        const track: Track = { program: draft.program, group, value: [...first], velocity: first.map(() => 0),
          _owner: undefined, elapsed: draft.reduced ? draft.program.duration : 0, paused: false, done: false };
        sample(track.program, track.elapsed, track.value, track.velocity);
        run.own(track); group._attach(track);
      }
      for (const group of touched) {
        group._render();
        for (const track of [...group.tracks.values()]) if (track.elapsed >= track.program.duration) group._end(track, true);
        group._reconcile();
      }
      run.empty(); this._drain(); return run;
    } catch (error) { for (const group of touched) group._fail(error); throw error; }
  }
  animate(target: MotionTarget, props: MotionProperties, options?: MotionOptions): Playback {
    const input = properties(props);
    const clock = timing(options, input.some(p => p.authored));
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
      const input = properties(props), clock = timing(rest, input.some(p => p.authored));
      const drafts = this._draft(target, input, clock, offset + sequenceClock.delay);
      for (const draft of drafts) {
        count += draft.program.segments.length;
        if (count > MAX_CHANNELS) throw new MotionError('Последовательность слишком велика');
        let channels = merged.get(draft.element);
        if (!channels) { channels = new Map(); merged.set(draft.element, channels); }
        const before = channels.get(draft.key);
        let next = draft;
        if (before) {
          const at = draft.program.segments[0]!.at;
          if (at < before.program.duration) throw new MotionError('Шаги одного свойства не должны пересекаться');
          const property = input.find(p => p.key === draft.key)!;
          const p = program(draft.key, { coordinates: before.program.final, unit: before.program.unit }, property.values, property.authored, clock,
            before.program.final.map(() => 0), at - clock.delay);
          next = { ...draft, program: { ...p, segments: [...before.program.segments, ...p.segments], nativeEase: undefined, identity: undefined } };
        }
        channels.set(draft.key, next);
        end = Math.max(end, next.program.duration);
      }
      previousStart = offset; cursor = end - sequenceClock.delay;
    }
    const drafts = [...merged.values()].flatMap(map => [...map.values()]).map(d => ({ ...d, reduced: d.reduced || sequenceClock.reduced, program: { ...d.program, duration: end, nativeEase: undefined } }));
    return this._execute(drafts, drafts.every(draft => draft.reduced) ? 0 : end);
  }
}

export const runtime: Runtime = new Runtime();
export const animate: (target: MotionTarget, props: MotionProperties, options?: MotionOptions) => Playback = runtime.animate.bind(runtime);
export const sequence: (steps: readonly SequenceStep[], options?: SequenceOptions) => Playback = runtime.sequence.bind(runtime);
