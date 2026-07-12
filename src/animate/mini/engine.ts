/**
 * animate/mini/engine.ts — движок анимации поверх адаптерного реестра.
 *
 * НЕ ВЕТВИТСЯ по имени свойства: канал резолвит codec через реестр, запись —
 * через adapter.surfaceOf/compose/apply. Новый вид свойства/цели = регистрация
 * в реестре, не правка этого файла (ЗАКОН расширения, registry.ts).
 *
 * Единая семантика времени: и spring, и tween, и все кодеки живут в ОДНОМ
 * прогресс-пространстве p∈[0,1] (readCompositorSpring на from=0,to=1 — та же
 * замкнутая форма, что у compositor-пути пакета). Значение канала =
 * codec.interpolate(from,to)(p). keyframe-массивы и per-property переходы (full)
 * наследуют ЭТОТ же клок — одна семантика времени по построению.
 *
 * Пути (авто по среде):
 *   reduced — prefers-reduced-motion: reduce → мгновенный снап к финалу без кадров;
 *   main    — rAF-микроцикл в замкнутой форме, фазы кадра update(вычисление)→
 *             render(запись) разведены единым ./frame-шедулером (чтение current-
 *             value сделано ОДИН раз при привязке, per-frame — только запись).
 *
 * ГРАНИЦА ПЕРВОЙ ВЕРСИИ (размерный потолок 5 KB): compositor-offload (WAAPI/
 * Element.animate через compileSpringPlan) в mini НЕ включён — переиспользование
 * компилятора пружина→linear() ядра стоит ~1.75 KB gz и физически не помещается
 * под 5120 (floor compositor+codecs+registry+frame = 5186 БЕЗ движка). Полный
 * compositor-путь живёт в субпути ./animate. mini детектирует reduced-motion и
 * гонит transform/opacity аналитической замкнутой формой на main-потоке.
 *
 * Инварианты: один владелец пары target/поверхность (реестр, supersede при
 * повторном запуске); C¹-подхват value+velocity (dominant-канал); fail-fast
 * (валидация ДО записи — codec.parse); SSR-safe (DOM только в момент вызова);
 * детерминизм (часы только через инжектируемый ./frame requestFrame).
 */

import { readCompositorSpring } from '../../compositor/core.js';
import { MotionParamError } from '../../errors.js';
import { createFrameLoop, frame as defaultFrame, type FrameLoop } from '../../frame/index.js';
import type { SpringParams } from '../../spring.js';
import type { CodecRegistry, PropertyCodec, TargetAdapter } from '../registry.js';

const FIXED_DT_MS = (1 / 60) * 1000;
const EASE_DERIV_H = 1e-3;
/** Порог сходимости прогресса (зеркалит CONVERGENCE_THRESHOLD ядра). */
const CONVERGENCE = 1e-3;

/** Дефолты mini (инлайн — НЕ тянем ../tokens): Framer-подобная пружина. */
const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const DEFAULT_DURATION_MS = 300;
/** Дефолтный tween-ease mini: easeInOutCubic (точную кривую задаёт вызывающий). */
const _defaultEase = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Режим движения (spring/tween взаимоисключающие — гейт в _resolveMode). */
export type MotionMode =
  | { readonly type: 'spring'; readonly spring: SpringParams }
  | { readonly type: 'tween'; readonly durationMs: number; readonly ease: (t: number) => number };

/** Значение канала: цель или пара [from, to] (явный from отключает подхват). */
export type PropValue = number | string | readonly [number | string, number | string];

/** Опции движка (публичный контракт mini). */
export interface EngineOptions {
  readonly spring?: SpringParams | undefined;
  readonly duration?: number | undefined;
  readonly ease?: ((t: number) => number) | undefined;
  readonly delay?: number | undefined;
  readonly stagger?: number | undefined;
  readonly onComplete?: (() => void) | undefined;
  /** Шов кадра main-пути (детерминизм тестов). Дефолт: разделяемый ./frame. */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /** Явный ./frame-цикл (переопределяет requestFrame). */
  readonly frame?: FrameLoop | undefined;
  /** Шов reduced-motion. Дефолт: globalThis.matchMedia (если среда умеет). */
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
}

/** Контролы прогона (агрегированные по целям). */
export interface AnimateControls {
  readonly finished: Promise<void>;
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
  stop(): void;
}

// ─── Реестр состояния по целям (владелец + последнее значение канала) ────────

interface ChannelSnapshot {
  readonly value: string | number;
  readonly velocity: number;
}

interface SurfaceOwner {
  captureChannel(property: string): ChannelSnapshot | undefined;
  knownChannels(): readonly string[];
  supersede(): void;
}

interface SurfaceRecord {
  owner: SurfaceOwner | undefined;
  readonly last: Map<string, ChannelSnapshot>;
}

const _registry = new WeakMap<object, Map<string, SurfaceRecord>>();

/** Запись поверхности цели (владелец + последнее значение каналов), лениво. */
function _surfaceRecord(target: object, surface: string): SurfaceRecord {
  let map = _registry.get(target);
  if (map === undefined) {
    map = new Map();
    _registry.set(target, map);
  }
  let rec = map.get(surface);
  if (rec === undefined) {
    rec = { owner: undefined, last: new Map() };
    map.set(surface, rec);
  }
  return rec;
}

// ─── Разбор опций ─────────────────────────────────────────────────────────────

/** Режим движения из опций: spring ИЛИ tween (взаимоисключающи — fail-fast). */
function _resolveMode(o: EngineOptions): MotionMode {
  const hasSpring = o.spring !== undefined;
  const hasTween = o.duration !== undefined || o.ease !== undefined;
  if (hasSpring && hasTween) {
    throw new MotionParamError(`animate: spring и duration/ease несовместимы`);
  }
  if (hasTween) {
    const durationMs = o.duration ?? DEFAULT_DURATION_MS;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new MotionParamError(`animate: duration > 0, получено ${String(o.duration)}`);
    }
    const ease = o.ease ?? _defaultEase;
    if (typeof ease !== 'function') {
      throw new MotionParamError(`animate: ease не функция`);
    }
    return { type: 'tween', durationMs, ease };
  }
  return { type: 'spring', spring: o.spring ?? DEFAULT_SPRING };
}

/** Неотрицательное конечное число или дефолт; иначе fail-fast MotionParamError. */
function _nonNeg(name: string, v: number | undefined, dflt: number): number {
  const x = v ?? dflt;
  if (!Number.isFinite(x) || x < 0) {
    throw new MotionParamError(`animate: ${name} >= 0, получено ${String(v)}`);
  }
  return x;
}

/** Активно ли prefers-reduced-motion (guard: нет matchMedia или бросок → false). */
function _prefersReduced(mm: ((q: string) => { matches: boolean }) | undefined): boolean {
  if (typeof mm !== 'function') return false;
  try {
    return mm('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ─── Каналы ─────────────────────────────────────────────────────────────────

/** Канал в полёте: кодек + parsed from/to + сериализованное текущее значение. */
interface Channel {
  readonly property: string;
  readonly codec: PropertyCodec;
  from: unknown;
  readonly to: unknown;
  interp: (p: number) => unknown;
  /** Числовой диапазон to−from ИЛИ undefined (C⁰-канал). */
  readonly numRange: number | undefined;
  value: string | number;
  velocity: number;
}

/** Спецификация одного свойства (после codec.parse — валидна). */
interface Spec {
  readonly property: string;
  readonly codec: PropertyCodec;
  readonly explicitFrom: unknown | undefined;
  readonly to: unknown;
}

/** Разбирает props → спеки, резолвя кодек и парся значения (fail-fast ДО записи). */
function _parseSpecs(props: Record<string, PropValue>, registry: CodecRegistry): Spec[] {
  const specs: Spec[] = [];
  for (const property of Object.keys(props)) {
    if (property === 'transform') {
      throw new MotionParamError(
        `animate: 'transform' целиком нельзя — используйте x/y/scale/rotate`,
      );
    }
    const codec = registry.resolveCodec(property);
    const raw = props[property]!;
    const pair = Array.isArray(raw) ? (raw as readonly [unknown, unknown]) : undefined;
    if (pair !== undefined && pair.length !== 2) {
      throw new MotionParamError(`animate: пара '${property}' — [from, to]`);
    }
    specs.push({
      property,
      codec,
      explicitFrom: pair !== undefined ? codec.parse(pair[0], property) : undefined,
      to: codec.parse(pair !== undefined ? pair[1] : raw, property),
    });
  }
  return specs;
}

// ─── Подхват скорости (C¹) ────────────────────────────────────────────────────

const _RANGE_EPS = 1e-10;

/** v0 = velocity / range (канон MotionValue); |range|≤eps или non-finite → 0. */
function _normalizeV0(velocity: number, range: number | undefined): number {
  if (range === undefined || !(Math.abs(range) > _RANGE_EPS)) return 0;
  const v0 = velocity / range;
  return Number.isFinite(v0) ? v0 + 0 : 0;
}

/** Привязанная поверхность: каналы + остаточные (замороженные) + v0 группы. */
interface BoundSurface {
  readonly channels: Channel[];
  readonly residuals: Map<string, string | number>;
  readonly v0: number;
}

/**
 * Привязывает спеки поверхности к цели: резолв from (пара → живой владелец →
 * реестр → adapter.read → codec.parse), сев v0 по доминантному каналу (max
 * |range|), заморозка остаточных transform-каналов (полная transform-строка).
 * НЕ прерывает владельца — supersede делает вызывающий ПОСЛЕ привязки.
 */
function _bindSurface(
  target: object,
  surface: string,
  specs: readonly Spec[],
  adapter: TargetAdapter,
  rec: SurfaceRecord,
): BoundSurface {
  const owner = rec.owner;
  const channels: Channel[] = [];
  let domVel = 0;
  let domRange: number | undefined;

  for (const spec of specs) {
    const codec = spec.codec;
    let from: unknown;
    let velocity = 0;
    if (spec.explicitFrom !== undefined) {
      from = spec.explicitFrom;
    } else {
      const live = owner?.captureChannel(spec.property);
      const stored = rec.last.get(spec.property);
      if (live !== undefined) {
        from = codec.parse(live.value, spec.property);
        velocity = live.velocity;
      } else if (stored !== undefined) {
        from = codec.parse(stored.value, spec.property);
      } else {
        from = codec.parse(adapter.read(target, spec.property), spec.property);
      }
    }
    const numRange = codec.range?.(from, spec.to);
    const interp = codec.interpolate(from, spec.to);
    channels.push({
      property: spec.property,
      codec,
      from,
      to: spec.to,
      interp,
      numRange,
      value: codec.serialize(interp(0)),
      velocity,
    });
    if (numRange !== undefined && (domRange === undefined || Math.abs(numRange) > Math.abs(domRange))) {
      domRange = numRange;
      domVel = velocity;
    }
  }

  const residuals = new Map<string, string | number>();
  if (surface === 'transform') {
    const animated = new Set(specs.map((s) => s.property));
    const known = new Set<string>(rec.last.keys());
    if (owner !== undefined) for (const k of owner.knownChannels()) known.add(k);
    // scale выигрывает у scaleX/scaleY в _buildTransform: остаточный uniform-scale
    // при анимации ОСЕВОГО канала «съел» бы новый рендер (scaleX не виден). НЕ
    // несём конфликтующий residual 'scale' — тогда осевой канал реально рендерится.
    for (const key of known) {
      if (
        animated.has(key) ||
        (key === 'scale' && (animated.has('scaleX') || animated.has('scaleY')))
      ) {
        continue;
      }
      const snap = owner?.captureChannel(key) ?? rec.last.get(key);
      if (snap !== undefined) residuals.set(key, snap.value);
    }
  }

  return { channels, residuals, v0: _normalizeV0(domVel, domRange) };
}

// ─── Unit: один прогон одной поверхности одной цели ──────────────────────────

interface UnitOptions {
  readonly target: object;
  readonly surface: string;
  readonly adapter: TargetAdapter;
  readonly record: SurfaceRecord;
  readonly bound: BoundSurface;
  readonly mode: MotionMode;
  readonly delayMs: number;
  readonly frame: FrameLoop;
  /** reduced-motion: мгновенный снап к финалу без кадров (= _settle сразу). */
  readonly reduced: boolean;
  readonly onDone: (natural: boolean) => void;
}

class Unit implements SurfaceOwner {
  readonly finished: Promise<void>;
  private readonly _o: UnitOptions;
  private _resolve!: () => void;
  private _done = false;
  private _paused = false;
  private _active = false;
  private _gen = 0;
  private _wallMs = 0;
  private _tMs = 0;
  private readonly _v0: number;
  private _lastTs: number | undefined;
  private _converged = false;
  private _off: (() => void) | undefined;

  /** Стартует прогон: reduced → мгновенный снап, иначе планирует первый кадр. */
  constructor(o: UnitOptions) {
    this._o = o;
    this._v0 = o.bound.v0;
    this.finished = new Promise<void>((res) => {
      this._resolve = res;
    });
    // reduced-motion — снап к финалу (то же, что естественное оседание _settle).
    if (o.reduced) this._settle();
    else this._schedule();
  }

  // ── SurfaceOwner (подхват при повторном animate) ──────────────────────────

  /** Снимок канала для C¹-подхвата: живой канал (value+velocity) или остаток. */
  captureChannel(property: string): ChannelSnapshot | undefined {
    const ch = this._o.bound.channels.find((c) => c.property === property);
    if (ch !== undefined) return { value: ch.value, velocity: ch.velocity };
    const frozen = this._o.bound.residuals.get(property);
    return frozen === undefined ? undefined : { value: frozen, velocity: 0 };
  }

  /** Все ключи прогона: живые каналы + остаточные (для residual-проекции). */
  knownChannels(): readonly string[] {
    return [...this._o.bound.channels.map((c) => c.property), ...this._o.bound.residuals.keys()];
  }

  /** Прерывание прогона повторным animate: стоп без записи, finished (не natural). */
  supersede(): void {
    if (this._done) return;
    this._teardown();
    this._finish(false);
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  /** Пауза: замораживает прогон, уже запланированный кадр становится инертен. */
  pause(): void {
    if (this._done || this._paused) return;
    this._paused = true;
    this._gen++; // уже запланированный кадр инертен
  }

  /** Возобновление после паузы: сбрасывает ts-базу и планирует новый кадр. */
  play(): void {
    if (this._done || !this._paused) return;
    this._paused = false;
    this._lastTs = undefined;
    this._schedule();
  }

  /** Перемотка к виртуальному времени tMs: синхронный эмит (вычисление+запись). */
  seek(tMs: number): void {
    // !isFinite отсекает и NaN, и ±Infinity: Infinity утекал бы в _compute/spring
    // (tMs/1000 → ∞ → бросок изнутри). Нефинитная перемотка — no-op, как NaN.
    if (this._done || !Number.isFinite(tMs)) return;
    this._active = true;
    this._tMs = Math.max(0, tMs);
    this._lastTs = undefined;
    // Немедленный эмит: вычисление + запись синхронно (перемотка видима сразу).
    if (this._compute(this._tMs)) this._settle();
    else this._write();
  }

  /** Отмена: стоп на текущем значении, фиксация в реестр, finished (не natural). */
  cancel(): void {
    if (this._done) return;
    this._teardown();
    this._writeBack();
    this._finish(false);
  }

  // ── main-путь: единый ./frame, фазы update(вычисление)→render(запись) ─────
  //
  // update и render — once-подписки ОДНОГО кадра ./frame: в тике сначала фаза
  // update (продвинуть время, посчитать значения каналов, БЕЗ записи в DOM),
  // затем фаза render (записать посчитанное). Так чтение current-value
  // (сделано один раз в _bindSurface) и записи разведены по фазам — layout-
  // thrash исключён. render перепланирует кадр (batch-семантика ./frame).

  /** Планирует один кадр: update (вычисление) + render (запись) как once-подписки. */
  private _schedule(): void {
    const gen = this._gen;
    this._off?.();
    const offU = this._o.frame.update((ts) => this._update(ts, gen), { once: true });
    const offR = this._o.frame.render(() => this._render(gen), { once: true });
    this._off = (): void => {
      offU();
      offR();
    };
  }

  /** Фаза update: продвинуть время и посчитать значения каналов (без записи). */
  private _update(ts: number | undefined, gen: number): void {
    if (gen !== this._gen || this._done || this._paused) return;
    let dt = ts !== undefined ? (this._lastTs !== undefined ? ts - this._lastTs : 0) : FIXED_DT_MS;
    if (ts !== undefined) this._lastTs = ts;
    if (dt < 0) dt = 0;
    this._wallMs += dt;
    if (!this._active) {
      if (this._wallMs + FIXED_DT_MS >= this._o.delayMs) {
        this._active = true;
        this._tMs = 0;
      }
    } else {
      this._tMs += dt;
    }
    this._converged = this._active && this._compute(this._tMs);
  }

  /** Фаза render: записать посчитанное; сходимость → точный финал. */
  private _render(gen: number): void {
    if (gen !== this._gen || this._done || this._paused) return;
    if (this._converged) {
      this._settle();
      return;
    }
    if (this._active) this._write();
    this._schedule();
  }

  /**
   * Вычисляет (p, dpdt) при виртуальном времени tMs и сэмплит каналы (БЕЗ
   * записи в DOM — она в фазе render). Возвращает true — прогон сошёлся.
   */
  private _compute(tMs: number): boolean {
    const o = this._o;
    let p: number;
    let dpdt: number;
    if (o.mode.type === 'tween') {
      if (tMs >= o.mode.durationMs) return true;
      const k = tMs / o.mode.durationMs;
      const eased = o.mode.ease(k);
      p = Number.isFinite(eased) ? eased : k;
      const k0 = k > EASE_DERIV_H ? k - EASE_DERIV_H : 0;
      const k1 = k + EASE_DERIV_H < 1 ? k + EASE_DERIV_H : 1;
      const slope = (o.mode.ease(k1) - o.mode.ease(k0)) / (k1 - k0);
      const raw = (slope * 1000) / o.mode.durationMs;
      dpdt = Number.isFinite(raw) ? raw + 0 : 0;
    } else {
      const r = readCompositorSpring(o.mode.spring, { from: 0, to: 1, v0: this._v0, t: tMs / 1000 });
      p = r.value;
      dpdt = r.velocity;
      if (Math.abs(p - 1) < CONVERGENCE && Math.abs(dpdt) < CONVERGENCE) return true;
    }
    for (const ch of o.bound.channels) {
      ch.value = ch.codec.serialize(ch.interp(p));
      const vel = ch.numRange !== undefined ? ch.numRange * dpdt : 0;
      ch.velocity = Number.isFinite(vel) ? vel + 0 : 0;
    }
    return false;
  }

  /** Запись поверхности: остаточные + живые каналы → compose → apply в цель. */
  private _write(): void {
    const o = this._o;
    const map = new Map<string, string | number>();
    o.bound.residuals.forEach((v, k) => map.set(k, v));
    for (const ch of o.bound.channels) map.set(ch.property, ch.value);
    o.adapter.apply(o.target, o.surface, o.adapter.compose(o.surface, map));
  }

  /** Оседание: точный финал (interp(1)) записан, зафиксирован, finished (natural). */
  private _settle(): void {
    if (this._done) return;
    for (const ch of this._o.bound.channels) {
      ch.value = ch.codec.serialize(ch.interp(1));
      ch.velocity = 0;
    }
    this._write();
    this._writeBack();
    this._finish(true);
  }

  // ── Общее ─────────────────────────────────────────────────────────────────

  /** Снятие подписок кадра и инвалидация поколения (запланированный кадр инертен). */
  private _teardown(): void {
    this._gen++;
    this._off?.();
    this._off = undefined;
  }

  /** Фиксация последних значений каналов/остатков в реестр (для будущего from). */
  private _writeBack(): void {
    const rec = this._o.record;
    for (const ch of this._o.bound.channels) {
      rec.last.set(ch.property, { value: ch.value, velocity: 0 });
    }
    this._o.bound.residuals.forEach((v, k) => {
      if (!rec.last.has(k)) rec.last.set(k, { value: v, velocity: 0 });
    });
  }

  /** Терминализация: снимает владение записью, резолвит finished, зовёт onDone. */
  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    this._gen++;
    if (this._o.record.owner === this) this._o.record.owner = undefined;
    this._resolve();
    this._o.onDone(natural);
  }
}

// ─── Резолв целей (в момент вызова — SSR-safe) ───────────────────────────────

/** Похоже ли на список элементов (массив/NodeList): number-length + object-элемент. */
function _isArrayLike(t: unknown): boolean {
  if (Array.isArray(t)) return true;
  const len = (t as { length?: unknown } | null)?.length;
  // Number.isFinite сам отвергает не-числовой length (доп. typeof-гейт не нужен).
  if (!Number.isFinite(len as number)) return false;
  // Список элементов (NodeList/массив), не plain-object со случайным length.
  return len === 0 || typeof (t as ArrayLike<unknown>)[0] === 'object';
}

/** Резолв цели(ей) в момент вызова (SSR-safe): селектор → NodeList, список, объект. */
function _resolveTargets(target: unknown, registry: CodecRegistry): object[] {
  if (typeof target === 'string') {
    const doc = (globalThis as { document?: { querySelectorAll?: (s: string) => ArrayLike<object> } }).document;
    if (doc === undefined || typeof doc.querySelectorAll !== 'function') {
      throw new MotionParamError(
        `animate: селектор '${target}' требует document`,
      );
    }
    return _collect(doc.querySelectorAll(target));
  }
  if (target !== null && typeof target === 'object') {
    // Прямая adapter-цель ПЕРВЫМ: объект с полем length:0 (напр. style-цель)
    // иначе трактуется как пустой список → тихий no-op (цель не анимируется).
    // Валидная прямая цель (resolveAdapter не бросает) — ОДНА цель, не список.
    try {
      registry.resolveAdapter(target);
      return [target as object];
    } catch {
      /* не прямая цель — пробуем как список */
    }
    if (_isArrayLike(target)) return _collect(target as ArrayLike<object>);
    return [target as object];
  }
  throw new MotionParamError(`animate: цель — объект/список/селектор`);
}

function _collect(list: ArrayLike<object>): object[] {
  // Number.isFinite сам отвергает не-числовой length (доп. typeof не нужен).
  const n = Number.isFinite(list.length) ? list.length : 0;
  const out: object[] = [];
  for (let i = 0; i < n; i++) out.push(list[i]!);
  return out;
}

/** Дефолтный matchMedia-шов: globalThis.matchMedia, если среда его предоставляет. */
function _defaultMatchMedia(): ((q: string) => { matches: boolean }) | undefined {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === 'function' ? mm.bind(globalThis) : undefined;
}

// ─── runAnimate: оркестрация целей × поверхностей ────────────────────────────

/**
 * Запускает анимацию props на target через переданный реестр. Вся валидация
 * (режим, delay, stagger, codec.parse, резолв целей) — ДО побочных эффектов:
 * бросок MotionParamError не пишет ни одного стиля (fail-fast).
 */
export function runAnimate(
  registry: CodecRegistry,
  target: unknown,
  props: Record<string, PropValue>,
  options: EngineOptions = {},
): AnimateControls {
  const mode = _resolveMode(options);
  const baseDelay = _nonNeg('delay', options.delay, 0);
  const staggerStep = _nonNeg('stagger', options.stagger, 0);
  const specs = _parseSpecs(props, registry);
  const targets = _resolveTargets(target, registry);

  const reduced = _prefersReduced(options.matchMedia ?? _defaultMatchMedia());
  // Единый ./frame-шедулер: инжектированный requestFrame → выделенный цикл
  // (детерминизм тестов); иначе разделяемый синглтон (один rAF на весь пакет).
  const frameLoop =
    options.frame ??
    (options.requestFrame !== undefined
      ? createFrameLoop({ requestFrame: options.requestFrame })
      : defaultFrame);

  const units: Unit[] = [];
  let total = 0;
  let done = 0;
  let natural = 0;
  let setupDone = false;
  let completed = false;
  const maybeComplete = (): void => {
    if (!completed && setupDone && done === total && natural === total) {
      completed = true;
      options.onComplete?.();
    }
  };
  const report = (nat: boolean): void => {
    done++;
    if (nat) natural++;
    maybeComplete();
  };

  // ── Фаза 1: собрать и провалидировать ВЕСЬ план ДО любой мутации ──────────
  // Резолв адаптера + surfaceOf + _bindSurface (все могут бросить) выполняются
  // для ВСЕХ целей/поверхностей ПЕРЕД supersede/instantiate/write. Иначе бросок
  // на ПОЗДНЕЙ цели оставил бы ранние юниты запущенными (под reduced — с уже
  // записанным финалом): частичная анимация при fail-fast. _bindSurface без
  // побочных эффектов (только read/parse/capture — НЕ прерывает владельца).
  // Кортеж плана [target, surface, adapter, record, bound, delayMs] (без имён
  // полей — экономия байт под потолком mini; порядок = деструктуризация ниже).
  type PlanEntry = readonly [object, string, TargetAdapter, SurfaceRecord, BoundSurface, number];
  const plan: PlanEntry[] = [];
  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i]!;
    const adapter = registry.resolveAdapter(tgt);
    const delayMs = baseDelay + staggerStep * i;

    const bySurface = new Map<string, Spec[]>();
    for (const spec of specs) {
      const surface = adapter.surfaceOf(spec.property);
      const list = bySurface.get(surface);
      if (list === undefined) bySurface.set(surface, [spec]);
      else list.push(spec);
    }

    for (const [surface, list] of bySurface) {
      const rec = _surfaceRecord(tgt, surface);
      const bound = _bindSurface(tgt, surface, list, adapter, rec);
      plan.push([tgt, surface, adapter, rec, bound, delayMs]);
    }
  }

  // ── Фаза 2: мутации (supersede + instantiate) — только после полной валидации ─
  for (const [tgt, surface, adapter, rec, bound, delayMs] of plan) {
    rec.owner?.supersede();
    total++;
    const unit = new Unit({
      target: tgt,
      surface,
      adapter,
      record: rec,
      bound,
      mode,
      delayMs,
      frame: frameLoop,
      reduced,
      onDone: report,
    });
    // reduced-снап оседает в конструкторе синхронно (пишет rec.last, finished
    // резолвится) — владельцем НЕ становится (прогон завершён). Живой прогон —
    // становится: повторный animate подхватит value+velocity через него.
    if (!reduced) rec.owner = unit;
    units.push(unit);
  }
  setupDone = true;
  maybeComplete();

  const finished = Promise.all(units.map((u) => u.finished)).then(() => undefined);

  return {
    finished,
    play: () => units.forEach((u) => u.play()),
    pause: () => units.forEach((u) => u.pause()),
    seek: (tMs) => units.forEach((u) => u.seek(tMs)),
    cancel: () => units.forEach((u) => u.cancel()),
    stop: () => units.forEach((u) => u.cancel()),
  };
}
